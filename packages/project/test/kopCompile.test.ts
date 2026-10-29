import { readBlockFile } from '@baaportal/mc7';
import { SimCpu } from '@baaportal/sim';
import type { LadElem, LadNetwork } from '@baaportal/ladfbd';
import { describe, expect, it } from 'vitest';
import {
  blockToMc7File,
  blockSources,
  createCodeBlock,
  createProject,
  readBaap,
  sourceHashOf,
  writeBaap,
  type CodeBlock,
  type PlcDevice,
} from '../src/index';
import { cpu315pn, makeDevice, now, seq } from './fixtures';

let n = 0;
const id = () => `e${++n}`;
const contact = (op: string): LadElem => ({ id: id(), k: 'contact', neg: false, op });
const andNet = (a: string, b: string, q: string): LadNetwork => ({
  root: { id: id(), series: [contact(a), contact(b)], outs: [{ id: id(), k: 'coil', op: q }] },
});

function kopFc(dev: PlcDevice, number: number, lad: LadNetwork): CodeBlock {
  const b = createCodeBlock({ kind: 'FC', number, name: `K${number}`, language: 'KOP' });
  b.networks[0]!.lad = lad;
  dev.blocks.push(b);
  return b;
}

describe('blocchi KOP compilati dall AWL generato', () => {
  it('un FC KOP compila e il byte della lingua è 0x02', () => {
    const dev = makeDevice(seq('k'));
    const b = kopFc(dev, 20, andNet('I 0.0', 'I 0.1', 'Q 4.0'));
    const r = blockToMc7File(b, dev, cpu315pn, now);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.file).toBeTruthy();
    expect(readBlockFile(r.file!).header.language).toBe(0x02);
  });

  it('un operando vuoto dà KOP_EMPTY_OPERAND (rete 1) e nessun file', () => {
    const dev = makeDevice(seq('k'));
    const b = kopFc(dev, 20, andNet('I 0.0', '', 'Q 4.0'));
    const r = blockToMc7File(b, dev, cpu315pn, now);
    expect(r.file).toBeUndefined();
    const d = r.diagnostics.find((x) => x.code === 'KOP_EMPTY_OPERAND');
    expect(d).toMatchObject({ severity: 'error', network: 1 });
  });

  it('l hash cambia se cambia il KOP', () => {
    const dev = makeDevice(seq('k'));
    const b = kopFc(dev, 20, andNet('I 0.0', 'I 0.1', 'Q 4.0'));
    const before = sourceHashOf(b);
    b.networks[0]!.lad = andNet('I 0.0', 'I 0.2', 'Q 4.0');
    expect(sourceHashOf(b)).not.toBe(before);
  });

  it('un FC AWL compila ancora con la lingua 0x01', () => {
    const dev = makeDevice(seq('k'));
    const b = createCodeBlock({ kind: 'FC', number: 21, name: 'Aw', language: 'AWL' });
    b.networks[0]!.source = 'NOP 0;';
    dev.blocks.push(b);
    const r = blockToMc7File(b, dev, cpu315pn, now);
    expect(readBlockFile(r.file!).header.language).toBe(0x01);
  });

  it('simulatore: FC KOP «I 0.0 AND I 0.1 → Q 4.0» richiamato da OB1 AWL', () => {
    const dev = makeDevice(seq('s'));
    dev.blocks.length = 0;
    kopFc(dev, 1, andNet('I 0.0', 'I 0.1', 'Q 4.0'));
    const ob = createCodeBlock({ kind: 'OB', number: 1, name: 'Main', language: 'AWL' });
    ob.networks[0]!.source = '\tCALL FC 1;';
    dev.blocks.push(ob);
    const cpu = new SimCpu({
      cpuTypeId: 'cpu-315-2-pn-dp',
      props: {
        maxCycleMs: 150,
        minCycleMs: 0,
        clockMemory: { enabled: false, byte: 0 },
        retentivity: { mBytes: 16, timers: 2, counters: 2 },
        cyclicInterruptMs: 100,
      },
    });
    for (const b of dev.blocks) {
      const r = blockToMc7File(b, dev, cpu315pn, now);
      expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      cpu.loadBlock(r.file!);
    }
    cpu.run();
    cpu.memory.physIn[0] = 0b11;
    expect(cpu.cycle().ok).toBe(true);
    expect(cpu.memory.physOut[4]! & 1).toBe(1);
    cpu.memory.physIn[0] = 0b01;
    cpu.cycle();
    expect(cpu.memory.physOut[4]! & 1).toBe(0);
  });
});

describe('FUP come vista del modello KOP', () => {
  const pair = (): { dev: PlcDevice; kop: CodeBlock; fup: CodeBlock } => {
    const dev = makeDevice(seq('k'));
    const lad = andNet('I 0.0', 'I 0.1', 'Q 4.0');
    const kop = kopFc(dev, 20, lad);
    const fup = createCodeBlock({ kind: 'FC', number: 21, name: 'K20', language: 'FUP' });
    fup.networks[0]!.lad = structuredClone(lad);
    dev.blocks.push(fup);
    return { dev, kop, fup };
  };

  it('stesso blocco in FUP e in KOP: stesse blockSources, MC7 diverso solo nel byte di linguaggio', () => {
    const { dev, kop, fup } = pair();
    expect(blockSources(fup, dev)).toEqual(blockSources(kop, dev));
    const a = readBlockFile(blockToMc7File(kop, dev, cpu315pn, now).file!);
    const rf = blockToMc7File(fup, dev, cpu315pn, now);
    expect(rf.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const b = readBlockFile(rf.file!);
    expect(a.header.language).toBe(0x02);
    expect(b.header.language).toBe(0x03);
    expect(b.mc7).toEqual(a.mc7);
    const rest = (h: typeof a.header) => ({ ...h, language: 0, number: 0, raw: undefined });
    expect(rest(b.header)).toEqual(rest(a.header));
  });

  it('un .baap con un blocco FUP si salva, si rilegge e si compila', () => {
    const { dev, fup } = pair();
    const p = createProject({ name: 'X', author: '', comment: '' }, now);
    p.devices.push(dev);
    const back = readBaap(writeBaap(p, { appVersion: '1.0.0' }));
    const d2 = back.devices[0]!;
    const f2 = d2.blocks.find((b) => b.id === fup.id) as CodeBlock;
    expect(f2.language).toBe('FUP');
    const r = blockToMc7File(f2, d2, cpu315pn, now);
    expect(r.diagnostics.map((d) => d.code)).not.toContain('LINGUAGGIO_NON_COMPILABILE');
    expect(readBlockFile(r.file!).header.language).toBe(0x03);
  });
});
