import type { DataType, TypedMember } from '@baaportal/s7-types';
import { describe, expect, it } from 'vitest';
import {
  buildSsb,
  dataLayout,
  decodeBlock,
  instanceValues,
  readBlockFile,
  readSsb,
  type SsbSection,
} from '../src';
import { realBlocks } from './realBlocks';

const el = (name: string, type: DataType): TypedMember => ({ name, type });
const E = (name: 'Bool' | 'Byte' | 'Int' | 'Real' | 'Word' | 'Char'): DataType => ({
  kind: 'elementary',
  name,
});
const empty = (): Record<SsbSection, TypedMember[]> => ({
  in: [],
  out: [],
  inOut: [],
  stat: [],
  temp: [],
  ret: [],
});

describe('dataLayout (mc7 §1.4.8)', () => {
  it('DB1806 (istanza reale): i valori di istanza sono i dati diversi dai valori iniziali', ({
    skip,
  }) => {
    const real = realBlocks().find((x) => x.name === 'DB1806');
    if (!real) return skip();
    const b = decodeBlock(real.bytes);
    const values = instanceValues(b.iface, b.data!);
    const lay = new Map(dataLayout(b.iface).offsets.map((o) => [o.path, o]));
    for (const path of Object.keys(values)) {
      const kind = lay.get(path)?.type.kind;
      expect(['elementary', 'string', 'dateAndTime'], path).toContain(kind);
    }
    // Gli unici dati diversi dai valori iniziali: tre DT senza valore iniziale, che STEP 7 scrive
    // come 1990-01-01 nei dati (il compilatore li lascerebbe a zero, mc7 §1.9)
    const dt = 'DT#1990-01-01-00:00:00.000';
    expect(values).toEqual({
      'STAT29.OUT9.OUT2.OUT5': dt,
      'STAT29.OUT9.OUT2.OUT6': dt,
      'STAT29.OUT9.OUT2.OUT7': dt,
    });
  });

  it('valori di istanza: solo letterali che parseLiteral accetta e che ricompilati ridanno gli stessi byte', () => {
    const iface = readSsb(
      buildSsb(
        {
          ...empty(),
          stat: [
            el('r', E('Real')),
            el('t', { kind: 'elementary', name: 'S5Time' }),
            el('dt', { kind: 'dateAndTime' }),
            el('d', { kind: 'elementary', name: 'Date' }),
            el('s', { kind: 'string', length: 4 }),
          ],
        },
        { dt: 'DT#2024-01-01-00:00:00' },
        'DB',
      ),
      'DB',
    );
    // r 0, t 4, dt 6, d 14, s 16
    const base = new Uint8Array(dataLayout(iface).size);
    base.set([0x24, 0x01, 0x01, 0, 0, 0, 0, 0x02], 6);
    base[16] = 4;
    const at = (bytes: [number, number[]][]) => {
      const x = base.slice();
      for (const [o, b] of bytes) x.set(b, o);
      return instanceValues(iface, x);
    };
    // REAL massimo float32, positivo e negativo: parseLiteral li accetta e tornano identici
    expect(at([[0, [0x7f, 0x7f, 0xff, 0xff]]])).toEqual({ STAT0: '3.4028234663852886e+38' });
    expect(at([[0, [0xff, 0x7f, 0xff, 0xff]]])).toEqual({ STAT0: '-3.4028234663852886e+38' });
    expect(at([[4, [0x09, 0x99]]])).toEqual({ STAT1: 'S5T#9S990MS' });
    // fuori: S5TIME non normalizzato, DT a zero o col giorno della settimana sbagliato, data oltre
    // il 2168, STRING con byte oltre la lunghezza attuale
    expect(at([[4, [0x10, 0x10]]])).toEqual({});
    expect(at([[6, [0, 0, 0, 0, 0, 0, 0, 0]]])).toEqual({});
    expect(at([[6, [0x24, 0x10, 0x30, 0x13, 0x45, 0x59, 0x99, 0x95]]])).toEqual({});
    expect(at([[14, [0xff, 0xff]]])).toEqual({});
    expect(at([[16, [4, 2, 0x41, 0x42, 0x43, 0x44]]])).toEqual({});
    expect(at([[16, [4, 2, 0x41, 0x42, 0, 0]]])).toEqual({ STAT4: "'AB'" });
  });

  it('dataLayout = lunghezza dei dati su tutti i DB globali e sul DB di istanza DB1806', ({
    skip,
  }) => {
    const lines: string[] = [];
    let globals = 0;
    let instances = 0;
    for (const b of realBlocks()) {
      const f = readBlockFile(b.bytes);
      if (f.header.kind !== 'DB') continue;
      const i = readSsb(f.ssb, 'DB');
      const lay = dataLayout(i);
      expect(lay.size, b.name).toBe(f.mc7.length);
      if (i.header[0] === 0x05) globals++;
      else instances++;
      lines.push(
        `${b.name}: layout ${lay.size} = dati ${f.mc7.length} (${lay.offsets.length} voci)`,
      );
    }
    console.log(`[layout] ${globals} DB globali, ${instances} DB di istanza\n${lines.join('\n')}`);
    if (globals + instances === 0) return skip();
    if (realBlocks().length >= 31) {
      expect(globals).toBe(12);
      expect(instances).toBe(1);
    }
  });

  it('DB13 da 64 KB e ARRAY di STRUCT: layout e valori iniziali', ({ skip }) => {
    const b = realBlocks().find((x) => x.name === 'DB13');
    if (!b) return skip();
    const f = readBlockFile(b.bytes);
    const lay = dataLayout(readSsb(f.ssb, 'DB'));
    expect(lay.size).toBe(64040);
    const arr = lay.offsets[0]!;
    expect(arr).toMatchObject({ path: 'STAT0', byte: 0, strideBits: 320 });
    expect(arr.type).toMatchObject({ kind: 'array', dims: [{ lo: 0, hi: 1600 }] });
    // membri del primo elemento
    expect(lay.offsets[1]).toMatchObject({ path: 'STAT0[0].STAT0', byte: 0 });

    const b2 = realBlocks().find((x) => x.name === 'FB3003');
    if (!b2) return;
    const i2 = readSsb(readBlockFile(b2.bytes).ssb, 'FB');
    const arrays = i2.elements.filter((e) => e.type.kind === 'array');
    expect(arrays).toHaveLength(10);
    expect(arrays[0]!.children![0]!.children!.map((c) => !!c.initial)).toEqual(Array(6).fill(true));
  });

  it('regole di allineamento: BOOL a bit, BYTE, pari, STRING n+2, ARRAY OF BOOL', () => {
    const ssb = buildSsb(
      {
        ...empty(),
        stat: [
          el('a', E('Bool')),
          el('b', E('Bool')),
          el('c', E('Int')),
          el('d', E('Byte')),
          el('e', E('Real')),
          el('s', { kind: 'string', length: 3 }),
          el('f', { kind: 'array', dims: [{ lo: 0, hi: 2 }], element: E('Bool') }),
        ],
      },
      {},
      'DB',
    );
    const lay = dataLayout(readSsb(ssb, 'DB'));
    expect(lay.offsets.map((o) => [o.path, o.byte, o.bit])).toEqual([
      ['STAT0', 0, 0],
      ['STAT1', 0, 1],
      ['STAT2', 2, undefined],
      ['STAT3', 4, undefined],
      ['STAT4', 6, undefined],
      ['STAT5', 10, undefined],
      ['STAT6', 16, undefined],
    ]);
    expect(lay.size).toBe(18);
  });

  it('ARRAY OF STRUCT: passo = dimensione pari della struct', () => {
    const ssb = buildSsb(
      {
        ...empty(),
        stat: [
          el('t', {
            kind: 'array',
            dims: [{ lo: 1, hi: 3 }],
            element: { kind: 'struct', members: [el('b', E('Bool')), el('i', E('Int'))] },
          }),
          el('z', E('Byte')),
        ],
      },
      {},
      'DB',
    );
    const lay = dataLayout(readSsb(ssb, 'DB'));
    expect(lay.offsets.map((o) => [o.path, o.byte])).toEqual([
      ['STAT0', 0],
      ['STAT0[1].STAT0', 0],
      ['STAT0[1].STAT1', 2],
      ['STAT1', 12],
    ]);
    expect(lay.offsets[0]!.strideBits).toBe(32);
    expect(lay.size).toBe(14);
  });

  it('FB: IN, OUT, IN_OUT (puntatore di 6 byte), STAT; i TEMP non occupano spazio', () => {
    const ssb = buildSsb(
      {
        ...empty(),
        in: [el('a', E('Bool'))],
        inOut: [el('s', { kind: 'string', length: 20 })],
        stat: [el('x', E('Int'))],
        temp: [el('t', { kind: 'array', dims: [{ lo: 0, hi: 99 }], element: E('Int') })],
      },
      {},
      'FB',
    );
    const lay = dataLayout(readSsb(ssb, 'FB'));
    expect(lay.offsets.map((o) => [o.path, o.byte])).toEqual([
      ['IN0', 0],
      ['IN_OUT0', 2],
      ['STAT0', 8],
    ]);
    expect(lay.size).toBe(10);
  });

  it('limite di 64 KB (S7-300): un ARRAY enorme dà RangeError, non un numero senza senso', () => {
    const arr = (hi: number[]): DataType => ({
      kind: 'array',
      dims: hi.map((h) => ({ lo: 0, hi: h })),
      element: E('Int'),
    });
    const size = (t: DataType): number =>
      dataLayout(readSsb(buildSsb({ ...empty(), stat: [el('x', t)] }, {}, 'FB'), 'FB')).size;
    expect(size(arr([32766]))).toBe(65534);
    expect(size(arr([32767]))).toBe(65536); // esattamente il limite
    expect(() => size(arr([32768]))).toThrow(RangeError);
    expect(() => size(arr([9999, 9999]))).toThrow(RangeError);
    expect(() => size(arr([99999999, 99999999, 99999999]))).toThrow(RangeError);
    // ARRAY di STRUCT: il passo moltiplicato per il numero degli elementi
    const st: DataType = {
      kind: 'array',
      dims: [
        { lo: 0, hi: 5000 },
        { lo: 0, hi: 5000 },
      ],
      element: { kind: 'struct', members: [el('a', E('Int')), el('b', E('Real'))] },
    } as DataType;
    expect(() => size(st)).toThrow(RangeError);
  });
});
