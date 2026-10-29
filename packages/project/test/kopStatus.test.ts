// Osservazione dei segmenti KOP/FUP: lo stato per riga dell'AWL generato, preso dal simulatore,
// diventa lo stato degli elementi del grafico (`networkStatus`).
import type { LineMapEntry } from '@baaportal/mc7';
import { SimCpu, type MonitorStep } from '@baaportal/sim';
import {
  networkStatus,
  type ElemStatus,
  type LadBox,
  type LadElem,
  type LadNetwork,
  type LadNode,
  type LadOut,
  type LineState,
} from '@baaportal/ladfbd';
import { describe, expect, it } from 'vitest';
import { blockToMc7File, createCodeBlock, kopSources } from '../src/index';
import { cpu315pn, makeDevice, now, seq } from './fixtures';

let n = 0;
const id = () => `e${++n}`;
const c = (op: string, neg = false): LadElem => ({ id: id(), k: 'contact', neg, op });
const coil = (op: string): LadOut => ({ id: id(), k: 'coil', op });
const node = (series: LadElem[], outs: (LadOut | LadNode)[]): LadNode => ({
  id: id(),
  series,
  outs,
});
const net = (series: LadElem[], outs: (LadOut | LadNode)[], label?: string): LadNetwork => ({
  ...(label ? { label } : {}),
  root: node(series, outs),
});
const box = (
  kind: LadBox['box'],
  pins: Record<string, string>,
  instance = '',
  boolPins: LadBox['boolPins'] = {},
): LadBox => ({ id: id(), k: 'box', box: kind, instance, pins, boolPins });

/** Righe → stato dopo l'ultima istruzione eseguita (come `monitorLinesByNetwork` nella UI). */
function cellsOf(map: LineMapEntry[], steps: MonitorStep[], network: number) {
  const by = new Map(steps.map((s) => [s.offset, s]));
  const cells = new Map<number, LineState>();
  for (const e of map.filter((x) => x.network === network).sort((a, b) => a.offset - b.offset)) {
    const s = by.get(e.offset);
    if (s) cells.set(e.line, s);
    else if (!cells.has(e.line)) cells.set(e.line, null);
  }
  return cells;
}

/** Compila un FC KOP con le reti date, lo richiama da OB1 e osserva un ciclo. */
function run(nets: LadNetwork[], inputs: number, mw: Record<number, number> = {}) {
  const dev = makeDevice(seq('s'));
  dev.blocks.length = 0;
  const fc = createCodeBlock({ kind: 'FC', number: 1, name: 'K', language: 'KOP' });
  fc.networks = nets.map((lad, i) => ({ id: `n${i}`, title: '', comment: '', source: '', lad }));
  dev.blocks.push(fc);
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
  let map: LineMapEntry[] = [];
  for (const b of dev.blocks) {
    const r = blockToMc7File(b, dev, cpu315pn, now);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    if (b === fc) map = r.lines!;
    cpu.loadBlock(r.file!);
  }
  cpu.run();
  cpu.memory.physIn[0] = inputs;
  for (const [a, v] of Object.entries(mw)) {
    cpu.memory.M[Number(a)] = (v >> 8) & 0xff;
    cpu.memory.M[Number(a) + 1] = v & 0xff;
  }
  cpu.setMonitor({ kind: 'FC', number: 1 });
  expect(cpu.cycle().ok).toBe(true);
  const steps = cpu.monitorSnapshot()!;
  const src = kopSources(fc, dev);
  return (i: number): Map<string, ElemStatus> =>
    networkStatus(nets[i]!, src[i]!.lines, cellsOf(map, steps, i));
}

describe('networkStatus sul simulatore', () => {
  it('serie: contatti con lo stato dell’operando, bobina con il flusso', () => {
    const a = c('I 0.0');
    const b = c('I 0.1');
    const q = coil('Q 4.0');
    const nt = net([a, b], [q]);
    const st = run([nt], 0b01)(0);
    expect(st.get(a.id)).toMatchObject({ in: true, out: true, sta: true });
    expect(st.get(b.id)).toMatchObject({ in: true, out: false, sta: false });
    expect(st.get(q.id)).toMatchObject({ out: false });
    expect(st.get(nt.root.id)).toMatchObject({ out: false });
  });

  it('contatto NC, parallelo e il flusso che ne esce', () => {
    const a = c('I 0.0');
    const b = c('I 0.2');
    const p: LadElem = { id: id(), k: 'parallel', branches: [[a], [b]] };
    const x = c('I 0.1', true);
    const q = coil('Q 4.1');
    const st = run([net([p, x], [q])], 0b001)(0);
    expect(st.get(a.id)).toMatchObject({ out: true, sta: true });
    expect(st.get(b.id)).toMatchObject({ out: false, sta: false });
    expect(st.get(p.id)).toMatchObject({ in: true, out: true });
    // NC con l'operando a 0: conduce
    expect(st.get(x.id)).toMatchObject({ in: true, out: true, sta: false });
    expect(st.get(q.id)!.out).toBe(true);
  });

  it('ramo del parallelo senza flusso davanti resta a 0 anche se il contatto è chiuso', () => {
    const a = c('I 0.1');
    const b = c('I 0.0');
    const d = c('I 0.2');
    const p: LadElem = { id: id(), k: 'parallel', branches: [[b, c('I 0.0')], [d]] };
    const q = coil('Q 4.1');
    const st = run([net([a, p], [q])], 0b001)(0);
    expect(st.get(a.id)!.out).toBe(false);
    expect(st.get(b.id)).toMatchObject({ in: false, out: false, sta: true });
    expect(st.get(p.id)!.out).toBe(false);
    expect(st.get(q.id)!.out).toBe(false);
  });

  it('ramo a T: ogni uscita prende il flusso del suo nodo', () => {
    const a = c('I 0.0');
    const b = c('I 0.1');
    const q1 = coil('Q 4.2');
    const q2 = coil('Q 4.3');
    const t = node([b], [q2]);
    const st = run([net([a], [q1, t])], 0b01)(0);
    expect(st.get(q1.id)!.out).toBe(true);
    expect(st.get(t.id)!.out).toBe(false);
    expect(st.get(b.id)).toMatchObject({ in: true, out: false });
    expect(st.get(q2.id)!.out).toBe(false);
  });

  it('NOT e fronte di salita', () => {
    const a = c('I 0.0');
    const no: LadElem = { id: id(), k: 'not' };
    const q = coil('Q 4.4');
    const e = c('I 0.0');
    const fp: LadElem = { id: id(), k: 'edge', dir: 'P', mem: 'M 0.0' };
    const q2 = coil('Q 4.5');
    const at = run([net([a, no], [q]), net([e, fp], [q2])], 0b01);
    expect(at(0).get(no.id)).toMatchObject({ in: true, out: false });
    expect(at(0).get(q.id)!.out).toBe(false);
    // primo ciclo con I 0.0 = 1 e M 0.0 = 0: impulso
    expect(at(1).get(fp.id)).toMatchObject({ in: true, out: true });
  });

  it('box con EN/ENO: flusso e valori dei pin; con EN = 0 il corpo non è elaborato', () => {
    const a = c('I 0.0');
    const add = box('ADD_I', { IN1: 'MW 10', IN2: 'MW 12', OUT: 'MW 14' });
    const q = coil('Q 4.6');
    const b = c('I 0.1');
    const add2 = box('ADD_I', { IN1: 'MW 10', IN2: 'MW 12', OUT: 'MW 16' });
    const q2 = coil('Q 4.7');
    const at = run([net([a, add], [q]), net([b, add2], [q2])], 0b01, { 10: 3, 12: 4 });
    expect(at(0).get(add.id)).toMatchObject({
      in: true,
      out: true,
      pins: { EN: true },
      values: { IN1: 3, IN2: 4, OUT: 7 },
    });
    expect(at(0).get(q.id)!.out).toBe(true);
    const s2 = at(1).get(add2.id)!;
    expect(s2).toMatchObject({ in: false, out: false, pins: { EN: false } });
    expect(s2.values).toBeUndefined();
    expect(at(1).get(q2.id)!.out).toBe(false);
  });

  it('temporizzatore a box: S, R, Q e il valore corrente', () => {
    const r = c('I 0.1');
    const t = box('S_ODT', { TV: 'S5T#5S', BI: 'MW 20' }, 'T 1', { R: [r] });
    const q = coil('Q 5.0');
    const s = c('I 0.0');
    const st = run([net([s, t], [q])], 0b01)(0);
    const ts = st.get(t.id)!;
    expect(ts).toMatchObject({ in: true, out: false, pins: { S: true, R: false } });
    // TV caricato come S5TIME (W#16#0500: 500 × 10 ms), BI: tempo residuo in binario
    expect(ts.values!['TV']).toBe(0x0500);
    expect(ts.values!['BI']).toBe(500);
    expect(st.get(r.id)).toMatchObject({ out: false });
  });

  it('confronto: uscita e valori dei due ingressi', () => {
    const k: LadElem = { id: id(), k: 'cmp', fn: '<I', in1: 'MW 10', in2: 'MW 12' };
    const a = c('I 0.0');
    const k2: LadElem = { id: id(), k: 'cmp', fn: '==I', in1: 'MW 10', in2: 'MW 12' };
    const q = coil('Q 5.1');
    const q2 = coil('Q 5.2');
    const at = run([net([k], [q]), net([a, k2], [q2])], 0b01, { 10: 3, 12: 4 });
    expect(at(0).get(k.id)).toMatchObject({ out: true, values: { in1: 3, in2: 4 } });
    expect(at(1).get(k2.id)).toMatchObject({ in: true, out: false });
  });

  it('segmento saltato: nessun elemento elaborato', () => {
    const j = c('I 0.3');
    const skipped = c('I 0.0');
    const q = coil('Q 5.3');
    const after = c('I 0.0');
    const nets = [
      net([j], [{ id: id(), k: 'jmp', label: 'SKIP' }]),
      net([skipped], [q]),
      net([after], [coil('Q 5.4')], 'SKIP'),
    ];
    const at = run(nets, 0b1001);
    expect([...at(1).values()].every((x) => x.notRun)).toBe(true);
    expect(at(1).get(q.id)).toEqual({ notRun: true });
    expect(at(2).get(after.id)!.out).toBe(true);
  });
});
