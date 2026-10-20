import type { DataType, TypedMember } from '@baaportal/s7-types';
import { describe, expect, it } from 'vitest';
import {
  Mc7Error,
  buildSsb,
  readBlockFile,
  readSsb,
  writeSsb,
  type BlockKind,
  type SsbElement,
  type SsbSection,
} from '../src';
import { realBlocks } from './realBlocks';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const el = (name: string, type: DataType): TypedMember => ({ name, type });
const elem = (name: 'Bool' | 'Byte' | 'Int' | 'Real' | 'Word'): DataType => ({
  kind: 'elementary',
  name,
});

/** Tipo senza nomi (MC7 non li ha): i membri delle struct diventano ''. */
function strip(t: unknown): unknown {
  const x = t as DataType;
  if (x.kind === 'struct') return { kind: 'struct', members: x.members.map((m) => strip(m.type)) };
  if (x.kind === 'array') return { ...x, element: strip(x.element) };
  return x;
}
interface Shape {
  section: SsbSection;
  type: unknown;
  initial: string | undefined;
  children: Shape[];
}
const shape = (e: SsbElement): Shape => ({
  section: e.section,
  type: strip(e.type),
  initial: e.initial ? hex(e.initial) : undefined,
  children: (e.children ?? []).map(shape),
});

const kindOf = (name: string): BlockKind => {
  const m = /^(OB|DB|FB|FC|SFB|SFC|SDB)\d/.exec(name);
  return (m ? m[1] : 'DB') as BlockKind;
};

describe('SSB: interfaccia dei blocchi (mc7 §1.4)', () => {
  it("le 23 interfacce reali si leggono fino all'ultimo byte e si riscrivono identiche", ({
    skip,
  }) => {
    const lines: string[] = [];
    let n = 0;
    for (const b of realBlocks()) {
      const f = readBlockFile(b.bytes);
      if (f.ssb.length === 0) continue;
      const i = readSsb(f.ssb, f.header.kind!);
      expect(hex(writeSsb(i)), b.name).toBe(hex(f.ssb));
      expect(i.header.length).toBe(7);
      expect(i.tail.length).toBeLessThanOrEqual(1);
      for (const e of i.elements) expect(e.name).toBeUndefined();
      lines.push(`${b.name} ${f.ssb.length} B OK`);
      n++;
    }
    console.log(`[ssb roundtrip] ${n}/23\n${lines.join('\n')}`);
    if (n === 0) return skip();
    if (realBlocks().length >= 31) expect(n).toBe(23);
  });

  it('DB3003: struct con valori iniziali e ARRAY OF STRUCT', ({ skip }) => {
    const b = realBlocks().find((x) => x.name === 'DB3003');
    if (!b) return skip();
    const i = readSsb(readBlockFile(b.bytes).ssb, 'DB');
    expect(i.elements).toHaveLength(1);
    const top = i.elements[0]!;
    expect(top.type.kind).toBe('struct');
    expect(top.children).toHaveLength(8);
    expect(top.children![0]!.type).toEqual({ kind: 'elementary', name: 'S5Time' });
    expect(hex(top.children![0]!.initial!)).toBe('7233');
    expect(hex(top.children![1]!.initial!)).toBe('d30f'); // DATE
    expect(hex(top.children![4]!.initial!)).toBe('9902030102034004'); // DT
    expect(hex(top.children![5]!.initial!)).toBe('fe0731616166666464'); // STRING[254]
    const arr = top.children![6]!;
    expect(arr.type.kind).toBe('array');
    expect(arr.type).toMatchObject({ dims: [{ lo: 1, hi: 10 }] });
    expect(arr.initial).toBeUndefined();
    const st = arr.children![0]!;
    expect(st.type.kind).toBe('struct');
    expect(st.children).toHaveLength(6);
    expect(hex(st.children![5]!.initial!)).toBe('fe0731616166666464');
  });

  it('DB1 di cattura: riga ARRAY con flag, 6 byte + valore (mc7 §1.4.6)', ({ skip }) => {
    const b = realBlocks().find((x) => /s7comm_downloading_block_db1/.test(x.name));
    if (!b) return skip();
    const i = readSsb(readBlockFile(b.bytes).ssb, 'DB');
    const arr = i.elements[0]!.children![0]!;
    expect(arr.type).toMatchObject({ kind: 'array', dims: [{ lo: 0, hi: 199 }] });
    expect(hex(arr.initial!)).toBe('0100000101000000');
  });

  it('DB1806: DB di istanza con multi-istanze (15 nnnn + struct)', ({ skip }) => {
    const b = realBlocks().find((x) => x.name === 'DB1806');
    if (!b) return skip();
    const i = readSsb(readBlockFile(b.bytes).ssb, 'DB');
    expect(i.header[0]).toBe(0x0a);
    const multi = i.elements.filter((e) => e.type.kind === 'named');
    expect(multi.length).toBeGreaterThan(0);
    const first = multi.find((e) => e.type.kind === 'named' && e.type.name === 'FB1805')!;
    expect(first.section).toBe('stat');
    expect(first.children).toHaveLength(1);
    expect(first.children![0]!.type.kind).toBe('struct');
    expect(first.children![0]!.children).toHaveLength(97);
  });

  it('flag sconosciuti: modificare un tipo ricodifica solo quella riga', () => {
    // Nessun blocco reale non protetto ha la riga con byte esteso: si parte dal nostro SSB e si
    // marca la prima riga col bit 4 di `pt` e un byte esteso (come nel blocco protetto che li aveva).
    const base = readSsb(
      buildSsb(
        {
          in: [el('A', elem('Int')), el('B', elem('Bool'))],
          out: [],
          inOut: [],
          stat: [],
          temp: [],
          ret: [],
        },
        {},
        'FB',
      ),
      'FB',
    );
    const row = base.elements[0]!;
    row.raw = Uint8Array.from([row.raw[0]!, row.raw[1]! | 0x10, 0x05]);
    const i = readSsb(writeSsb(base), 'FB');
    expect(i.elements.some((e) => e.raw.length === 3 && (e.raw[1]! & 0x10) !== 0)).toBe(true);
    const ext = i.elements.find((e) => (e.raw[1]! & 0x10) !== 0)!;
    const before = writeSsb(i);
    ext.type = { kind: 'elementary', name: 'Word' };
    const after = writeSsb(i);
    expect(after.length).toBe(before.length);
    const diffs = [...after].filter((v, k) => v !== before[k]).length;
    expect(diffs).toBeGreaterThan(0);
    expect(diffs).toBeLessThanOrEqual(2);
    const again = readSsb(after, 'FB');
    expect(again.elements.map((e) => e.raw[1])).toEqual(i.elements.map((e) => e.raw[1]));
    expect(again.elements[0]!.raw[2]).toBe(0x05);
  });

  it('SDB / SSB vuoto', () => {
    const i = readSsb(new Uint8Array(0), 'SDB');
    expect(i.elements).toEqual([]);
    expect(writeSsb(i)).toHaveLength(0);
  });

  it('errori: troncato, tipo di blocco, genere', () => {
    expect(() => readSsb(Uint8Array.of(1, 0, 0), 'FB')).toThrow(Mc7Error);
    // I dichiara 5 byte ma ce ne sono 2
    expect(() => readSsb(Uint8Array.of(1, 0, 0, 5, 0, 0, 0, 5, 1), 'FB')).toThrow(Mc7Error);
    // genere di DB su un FB
    expect(() => readSsb(Uint8Array.of(5, 1, 0, 0, 0, 0, 0, 0), 'FB')).toThrow(Mc7Error);
  });
});

describe('buildSsb', () => {
  const empty = (): Record<SsbSection, TypedMember[]> => ({
    in: [],
    out: [],
    inOut: [],
    stat: [],
    temp: [],
    ret: [],
  });
  const resolve = (name: string) =>
    name === 'FB1805'
      ? {
          kind: 'fb' as const,
          sections: {
            input: [el('Speed', elem('Int'))],
            output: [el('Run', elem('Bool'))],
            inOut: [],
            static: [el('Acc', elem('Real'))],
          },
        }
      : null;

  const sections = (): Record<SsbSection, TypedMember[]> => ({
    ...empty(),
    in: [el('En', elem('Bool'))],
    out: [el('Cnt', elem('Int'))],
    stat: [
      el('Gain', elem('Real')),
      el('Txt', { kind: 'string', length: 10 }),
      el('Tab', {
        kind: 'array',
        dims: [{ lo: 1, hi: 3 }],
        element: {
          kind: 'struct',
          members: [el('a', elem('Int')), el('b', elem('Bool'))],
        },
      }),
      el('Motor', { kind: 'named', name: 'FB1805' }),
    ],
    temp: [el('t', elem('Byte'))],
  });
  const initials = {
    En: 'true',
    Cnt: '-2',
    Gain: '1.5',
    Txt: "'abc'",
    'Tab.a': '7',
    'Motor.Speed': '100',
  };

  it('interfaccia fatta a mano: readSsb dà gli stessi tipi e valori', () => {
    const ssb = buildSsb(sections(), initials, 'FB', { resolve });
    expect(ssb.length % 2).toBe(0);
    const i = readSsb(ssb, 'FB');
    expect(i.header[0]).toBe(1);
    const s = i.elements.map(shape);
    expect(s.map((x) => x.section)).toEqual(['in', 'out', 'stat', 'stat', 'stat', 'stat', 'temp']);
    expect(s[0]).toMatchObject({ type: elem('Bool'), initial: '01' });
    expect(s[1]).toMatchObject({ type: elem('Int'), initial: 'feff' });
    expect(s[2]).toMatchObject({ type: elem('Real'), initial: '0000c03f' });
    expect(s[3]).toMatchObject({ type: { kind: 'string', length: 10 }, initial: '0a03616263' });
    const tab = s[4]!;
    expect(tab.type).toMatchObject({ kind: 'array', dims: [{ lo: 1, hi: 3 }] });
    expect(tab.initial).toBeUndefined();
    expect(tab.children[0]!.children.map((c) => c.initial)).toEqual(['0700', undefined]);
    expect(tab.children[0]!.children.map((c) => c.type)).toEqual([elem('Int'), elem('Bool')]);
    const motor = s[5]!;
    expect(motor.type).toEqual({ kind: 'named', name: 'FB1805' });
    const inner = motor.children[0]!;
    expect(inner.type).toEqual({
      kind: 'struct',
      members: [
        { name: '', type: elem('Int') },
        { name: '', type: elem('Bool') },
        { name: '', type: elem('Real') },
      ].map((m) => m.type),
    });
    expect(inner.children.map((c) => [c.section, c.initial])).toEqual([
      ['in', '6400'],
      ['out', undefined],
      ['stat', undefined],
    ]);
    expect(s[6]).toMatchObject({ section: 'temp', type: elem('Byte') });
    // riscrivere dà gli stessi byte
    expect(hex(writeSsb(i))).toBe(hex(ssb));
  });

  it('byte esatti di righe e valori (mc7 §1.4.4, §1.4.6)', () => {
    const ssb = buildSsb(
      { ...empty(), stat: [el('x', elem('Int')), el('s', { kind: 'string', length: 4 })] },
      { x: '5', s: "'ab'" },
      'FB',
    );
    // 7 intestazione + righe 05 0c, 13 0c 04 + valori 05 00, 04 02 61 62 = 7+5+6 = 18
    expect(hex(ssb)).toBe('010000050006' + '00' + '050c' + '130c04' + '0500' + '04026162');
  });

  it('DB globale: una sola STRUCT (pt 04), genere 05', () => {
    const ssb = buildSsb(
      { ...empty(), stat: [el('a', elem('Word')), el('b', elem('Bool'))] },
      {},
      'DB',
      { number: 7 },
    );
    expect(hex(ssb.slice(0, 7))).toBe('05' + '0700' + '0700' + '0000');
    expect(hex(ssb.slice(7, 14))).toBe('1104' + '02' + '0404' + '0104');
    expect(() => buildSsb({ ...empty(), in: [el('a', elem('Int'))] }, {}, 'DB')).toThrow(
      RangeError,
    );
  });

  it('literal non valido: RangeError con il percorso', () => {
    expect(() => buildSsb(sections(), { ...initials, Cnt: '70000' }, 'FB', { resolve })).toThrow(
      /Cnt/,
    );
    expect(() => buildSsb(sections(), { ...initials, Cnt: '70000' }, 'FB', { resolve })).toThrow(
      RangeError,
    );
    expect(() =>
      buildSsb(sections(), { ...initials, Txt: "'abcdefghijklm'" }, 'FB', { resolve }),
    ).toThrow(/Txt/);
    expect(() => buildSsb(sections(), { 'Motor.Speed': 'zz' }, 'FB', { resolve })).toThrow(
      /Motor\.Speed/,
    );
    expect(() => buildSsb(sections(), { Nope: '1' }, 'FB', { resolve })).toThrow(/Nope/);
    expect(() => buildSsb(sections(), {}, 'FB')).toThrow(RangeError); // FB1805 senza risolutore
  });

  it('tutti i tipi elementari: valori iniziali (mc7 §1.4.6)', () => {
    const E = (name: string): DataType => ({ kind: 'elementary', name }) as DataType;
    const cases: [string, DataType, string, string][] = [
      ['a', E('Byte'), '16#AB', 'ab'],
      ['b', E('Word'), '16#1234', '3412'],
      ['c', E('DWord'), '16#DEADBEEF', 'efbeadde'],
      ['d', E('DInt'), '-1', 'ffffffff'],
      ['e', E('Char'), "'A'", '41'],
      ['g', E('Time'), 'T#1S', 'e8030000'],
      ['h', E('Date'), 'D#1990-01-02', '0100'],
      ['i', E('Time_Of_Day'), 'TOD#01:02:03.400', '88d03800'],
      ['j', { kind: 'dateAndTime' }, 'DT#1999-02-03-01:02:03.400', '9902030102034004'],
    ];
    for (const [name, type, lit, want] of cases) {
      const ssb = buildSsb({ ...empty(), stat: [el(name, type)] }, { [name]: lit }, 'FB');
      const i = readSsb(ssb, 'FB');
      expect(hex(i.elements[0]!.initial!), name).toBe(want);
    }
    // 7233 = base 10 s, valore 372 -> 3720 s = 1H2M
    const s5 = buildSsb({ ...empty(), stat: [el('f', E('S5Time'))] }, { f: 'S5T#1H2M' }, 'FB');
    expect(hex(readSsb(s5, 'FB').elements[0]!.initial!)).toBe('7233');
  });
});

describe('SSB: fuzz', () => {
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('5000 buffer casuali: solo Mc7Error o RangeError', () => {
    const rand = rng(1234);
    const real = realBlocks()
      .map((b) => ({ kind: kindOf(b.name), ssb: readBlockFile(b.bytes).ssb }))
      .filter((x) => x.ssb.length > 0);
    const kinds: BlockKind[] = ['OB', 'DB', 'FB', 'FC', 'SFB', 'SFC', 'SDB'];
    let parsed = 0;
    for (let n = 0; n < 5000; n++) {
      let buf: Uint8Array;
      const mode = n % 3;
      if (mode === 0 || real.length === 0) {
        buf = Uint8Array.from({ length: Math.floor(rand() * 80) }, () => Math.floor(rand() * 256));
      } else if (mode === 1) {
        // SSB reale con qualche byte alterato
        buf = Uint8Array.from(real[Math.floor(rand() * real.length)]!.ssb);
        for (let k = 0; k < 1 + Math.floor(rand() * 4); k++) {
          buf[Math.floor(rand() * buf.length)] = Math.floor(rand() * 256);
        }
      } else {
        // intestazione coerente, righe casuali con tipi plausibili
        const rows = Uint8Array.from({ length: Math.floor(rand() * 40) }, () =>
          rand() < 0.6 ? 1 + Math.floor(rand() * 0x1d) : Math.floor(rand() * 256),
        );
        const v = Math.floor(rand() * 8);
        buf = new Uint8Array(7 + rows.length + v);
        buf[0] = rand() < 0.5 ? 1 : 5;
        buf[3] = rows.length;
        buf[5] = v;
        buf.set(rows, 7);
      }
      const kind = kinds[Math.floor(rand() * kinds.length)]!;
      try {
        const i = readSsb(buf, kind);
        parsed++;
        // quel che si legge si riscrive uguale
        expect(hex(writeSsb(i))).toBe(hex(buf));
      } catch (e) {
        if (!(e instanceof Mc7Error) && !(e instanceof RangeError)) throw e;
        if (e instanceof RangeError) expect(e.message).not.toMatch(/call stack/i);
      }
    }
    console.log(`[ssb fuzz] 5000 buffer, ${parsed} letti e riscritti identici`);
  });
});
