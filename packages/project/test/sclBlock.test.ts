import { readBlockFile } from '@baaportal/mc7';
import { describe, expect, it } from 'vitest';
import {
  blockSources,
  blockToMc7File,
  createCodeBlock,
  createProject,
  kopSources,
  readBaap,
  writeBaap,
  type CodeBlock,
  type PlcDevice,
} from '../src/index';
import { cpu315pn, makeDevice, now, seq } from './fixtures';

const member = (name: string, type: string) => ({ id: `m-${name}`, name, type, comment: '' });

function sclFc(dev: PlcDevice, text: string): CodeBlock {
  const b = createCodeBlock({ kind: 'FC', number: 30, name: 'S30', language: 'SCL' });
  b.interface.input.push(member('a', 'Int'), member('b', 'Int'));
  b.interface.output.push(member('x', 'Bool'));
  b.networks[0]!.source = text;
  dev.blocks.push(b);
  return b;
}

describe('blocchi SCL compilati in AWL', () => {
  it('un FC SCL compila senza diagnostiche; blockSources è l AWL generato; byte di linguaggio 0x04', () => {
    const dev = makeDevice(seq('s'));
    const b = sclFc(dev, '#x := #a > #b;');
    expect(kopSources(b, dev)[0]!.scl!.diagnostics).toEqual([]);
    expect(blockSources(b, dev)[0]).toMatch(/\S/);
    expect(blockSources(b, dev)[0]).not.toContain(':=');
    const r = blockToMc7File(b, dev, cpu315pn, now);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(readBlockFile(r.file!).header.language).toBe(0x04);
  });

  it('un operando sconosciuto è un errore di compilazione col messaggio SCL e la riga', () => {
    const dev = makeDevice(seq('s'));
    const b = sclFc(dev, '#x := #a > #b;\n#x := #nonesiste > #b;');
    const sc = kopSources(b, dev)[0]!.scl!;
    expect(sc.source).toBe('');
    const r = blockToMc7File(b, dev, cpu315pn, now);
    expect(r.file).toBeUndefined();
    const d = r.diagnostics.find((x) => x.severity === 'error')!;
    expect(d.code).toBe('SCL_ERRORE');
    expect(d.network).toBe(1);
    expect(d.line).toBe(2);
    expect(d.message).toBe(sc.diagnostics[0]!.message);
  });

  it('un .baap con un blocco SCL si salva, si rilegge e si compila', () => {
    const dev = makeDevice(seq('s'));
    const b = sclFc(dev, '#x := #a > #b;');
    const p = createProject({ name: 'X', author: '', comment: '' }, now);
    p.devices.push(dev);
    const back = readBaap(writeBaap(p, { appVersion: '1.0.0' }));
    const d2 = back.devices[0]!;
    const b2 = d2.blocks.find((x) => x.id === b.id) as CodeBlock;
    expect(b2.language).toBe('SCL');
    expect(b2.networks[0]!.source).toBe('#x := #a > #b;');
    const r = blockToMc7File(b2, d2, cpu315pn, now);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.file).toBeTruthy();
  });
});
