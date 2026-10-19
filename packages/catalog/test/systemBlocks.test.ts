import { describe, expect, it } from 'vitest';
import { formatType, parseType, type TypedMember } from '@baaportal/s7-types';
import { SYSTEM_BLOCKS, findSystemBlock, type SystemBlock } from '../src';

const sig = (b: SystemBlock) => {
  const list = (ms: TypedMember[]) => ms.map((m) => `${m.name}:${formatType(m.type)}`);
  return { input: list(b.input), output: list(b.output) };
};
const all = (b: SystemBlock): TypedMember[] => [
  ...b.input,
  ...b.output,
  ...b.inOut,
  ...(b.static ?? []),
];

describe('catalogo SFC/SFB', () => {
  it('SFB 4 TON e SFC 1 READ_CLK con le interfacce attese', () => {
    expect(findSystemBlock({ kind: 'SFB', number: 4 })!.name).toBe('TON');
    expect(sig(findSystemBlock({ name: 'TON' })!)).toEqual({
      input: ['IN:Bool', 'PT:Time'],
      output: ['Q:Bool', 'ET:Time'],
    });
    expect(findSystemBlock({ name: 'READ_CLK' })!.returnType).toBe('Int');
  });

  it('SFC 20 BLKMOV: SRCBLK in, DSTBLK out, RET_VAL Int', () => {
    const b = findSystemBlock({ kind: 'SFC', number: 20 })!;
    expect(b.name).toBe('BLKMOV');
    expect(sig(b)).toEqual({ input: ['SRCBLK:Any'], output: ['DSTBLK:Any'] });
    expect(b.returnType).toBe('Int');
  });

  it('numeri e nomi unici per tipo, nomi senza ambiguita tra SFC e SFB', () => {
    for (const kind of ['SFC', 'SFB'] as const) {
      const of = SYSTEM_BLOCKS.filter((b) => b.kind === kind);
      expect(of.length).toBeGreaterThan(0);
      expect(new Set(of.map((b) => b.number)).size).toBe(of.length);
    }
    const names = SYSTEM_BLOCKS.map((b) => b.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it('ogni tipo e valido, i parametri sono unici per blocco, la fonte e presente', () => {
    for (const b of SYSTEM_BLOCKS) {
      expect(b.source.trim(), b.name).not.toBe('');
      const names = all(b).map((m) => m.name.toLowerCase());
      expect(new Set(names).size, b.name).toBe(names.length);
      if (b.returnType !== undefined) {
        expect(parseType(b.returnType).ok, `${b.name} RET_VAL`).toBe(true);
        expect(b.kind).toBe('SFC');
      }
      for (const m of all(b))
        expect(parseType(formatType(m.type)).ok, `${b.name}.${m.name}`).toBe(true);
    }
  });

  it('ricerca per nome senza distinguere maiuscole, per numero esatta', () => {
    expect(findSystemBlock({ name: 'ton' })).toBe(findSystemBlock({ kind: 'SFB', number: 4 }));
    expect(findSystemBlock({ kind: 'SFC', number: 4 })!.name).toBe('READ_RTM');
    expect(findSystemBlock({ kind: 'SFB', number: 20 })).toBeUndefined();
    expect(findSystemBlock({ name: 'Nonexistent' })).toBeUndefined();
    expect(findSystemBlock({ name: '__proto__' })).toBeUndefined();
    expect(findSystemBlock({ name: 'constructor' })).toBeUndefined();
  });

  it('SFB 0-5 sono i contatori e i temporizzatori IEC', () => {
    const names = [0, 1, 2, 3, 4, 5].map((n) => findSystemBlock({ kind: 'SFB', number: n })?.name);
    expect(names).toEqual(['CTU', 'CTD', 'CTUD', 'TP', 'TON', 'TOF']);
  });
});
