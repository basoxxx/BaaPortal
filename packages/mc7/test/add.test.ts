import { describe, expect, it } from 'vitest';
import { parseAdd, readBlockFile, serializeAdd, writeBlockFile } from '../src';
import { realBlocks } from './realBlocks';

const byName = (re: RegExp) => realBlocks().find((b) => re.test(b.name));

describe('ADD (mc7 §1.5)', () => {
  it("l'esempio di §1.5 (OB1 TIA): 5 reti e 3 salti", () => {
    const bytes = Uint8Array.from([
      0x05, 0, 0x86, 0, 0x42, 0, 0x04, 0, 0x06, 0, 0, 0, 0x03, 0, 0x03, 0, 0x0d, 0, 0x17, 0,
    ]);
    const add = parseAdd(bytes, 212);
    expect(add?.networks).toEqual([134, 66, 4, 6, 0]);
    expect(add?.jumps).toEqual([3, 13, 23]);
    expect(add?.rest.length).toBe(0);
    expect(serializeAdd(add!)).toEqual(bytes);
  });

  it('ADD che non si legge: undefined (resta grezza)', () => {
    expect(parseAdd(new Uint8Array(0), 10)).toBeUndefined();
    expect(parseAdd(Uint8Array.from([9, 0, 1, 0]), 100)).toBeUndefined(); // 9 reti non entrano
    expect(parseAdd(Uint8Array.from([1, 0, 50, 0, 0, 0]), 10)).toBeUndefined(); // rete > codice
    expect(parseAdd(Uint8Array.from([0, 0, 5, 0, 1, 0]), 10)).toBeUndefined(); // 5 salti non entrano
  });

  it('OB1 reale (TIA): reti e salti come in mc7 §5.2', ({ skip }) => {
    const b = byName(/^OB1 \(.*tia_s300_downloadOb1/);
    if (!b) return skip();
    const f = readBlockFile(b.bytes);
    expect(f.add.networks).toEqual([134, 66, 4, 6, 0]);
    expect(f.add.jumps).toEqual([3, 13, 23]);
    expect(f.add.networks.reduce((a, c) => a + c, 0)).toBe(f.header.mc7Length - 2);
  });

  it("l'ordine dei salti si conserva (FC100: non crescente) e il resto di FB101", ({ skip }) => {
    const fc100 = byName(/^FC100$/);
    const fb101 = byName(/^FB101$/);
    const fb751 = byName(/^FB751$/);
    if (!fc100 || !fb101 || !fb751) return skip();
    const a = readBlockFile(fc100.bytes).add;
    expect(a.jumps.length).toBe(73);
    expect(a.jumps.some((v, i) => i > 0 && v < a.jumps[i - 1]!)).toBe(true);
    const b = readBlockFile(fb101.bytes);
    expect(b.add.networks).toEqual([0, 0, 22]);
    expect(b.add.rest.length).toBe(12);
    const c = readBlockFile(fb751.bytes);
    expect(c.addRaw.length).toBe(0);
    expect(c.add.networks).toEqual([]);
  });

  it("modificare l'ADD strutturata cambia i byte scritti", ({ skip }) => {
    const b = byName(/^OB1 \(.*tia_s300_downloadOb1/);
    if (!b) return skip();
    const f = readBlockFile(b.bytes);
    f.add.jumps.push(30);
    const g = readBlockFile(writeBlockFile(f));
    expect(g.add.jumps).toEqual([3, 13, 23, 30]);
    expect(g.header.addLength).toBe(f.header.addLength + 2);
  });

  it('ADD illeggibile: addRaw è usato com’è', () => {
    const b = byName(/^SDB/) ?? realBlocks()[0]!;
    const f = readBlockFile(b.bytes);
    const raw = Uint8Array.from([0xff, 0xff, 1, 2, 3]);
    const g = readBlockFile(
      writeBlockFile({
        ...f,
        addRaw: raw,
        add: { networks: [], jumps: [], rest: new Uint8Array(0) },
      }),
    );
    expect(g.addRaw).toEqual(raw);
    expect(g.add.networks).toEqual([]);
  });
});
