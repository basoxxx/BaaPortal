import { describe, expect, it } from 'vitest';
import {
  formatOffset,
  layoutInstance,
  layoutStruct,
  parseType,
  type LayoutResult,
  type TypedMember,
  type TypeResolver,
} from '../src';

function m(name: string, typeText: string): TypedMember {
  const r = parseType(typeText);
  if (!r.ok) throw new Error(`tipo non valido: ${typeText}`);
  return { name, type: r.type };
}
const none: TypeResolver = () => null;
function offsets(r: LayoutResult) {
  if (!r.ok) throw new Error(`layout fallito: ${r.error}`);
  return Object.fromEntries(r.entries.map((e) => [e.path, formatOffset(e)]));
}

describe('layout', () => {
  it('Bool nello stesso byte, Byte al byte, Int e Real al byte pari', () => {
    const r = layoutStruct(
      [
        m('a', 'Bool'),
        m('b', 'Bool'),
        m('c', 'Byte'),
        m('d', 'Int'),
        m('e', 'Bool'),
        m('f', 'Real'),
      ],
      none,
    );
    expect(offsets(r)).toEqual({ a: '0.0', b: '0.1', c: '1.0', d: '2.0', e: '4.0', f: '6.0' });
    expect(r.ok && r.sizeBytes).toBe(10);
  });

  it('Struct e Array a byte pari con lunghezza pari', () => {
    const s = {
      name: 's',
      type: { kind: 'struct', members: [m('p', 'Bool'), m('q', 'Byte')] },
    } as const;
    const r = layoutStruct(
      [m('x', 'Bool'), s, m('y', 'Byte'), m('arr', 'Array[1..3] of Bool'), m('z', 'Byte')],
      none,
    );
    expect(offsets(r)).toEqual({
      x: '0.0',
      s: '2.0',
      's.p': '2.0',
      's.q': '3.0',
      y: '4.0',
      arr: '6.0',
      z: '8.0',
    });
    expect(r.ok && r.sizeBytes).toBe(10);
    expect(r.ok && r.entries.find((e) => e.path === 'arr')!.strideBits).toBe(1);
  });

  it('String[n] occupa n+2 byte da un byte pari', () => {
    expect(
      offsets(layoutStruct([m('c', 'Char'), m('s', 'String[3]'), m('b', 'Byte')], none)),
    ).toEqual({ c: '0.0', s: '2.0', b: '7.0' });
  });

  it('stride degli array', () => {
    const r = layoutStruct(
      [
        m('a', 'Array[1..4] of String[3]'),
        m('b', 'Array[1..2,1..3] of Int'),
        m('c', 'Array[0..2] of Byte'),
      ],
      none,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const stride = (p: string) => r.entries.find((e) => e.path === p)!.strideBits;
    expect([stride('a'), stride('b'), stride('c')]).toEqual([48, 16, 8]);
    expect(r.sizeBytes).toBe(24 + 12 + 4);
  });

  it('dati di istanza: sezioni a byte pari, InOut complesso come puntatore, multi-istanza', () => {
    const resolve: TypeResolver = (n) =>
      n === 'Sub'
        ? { kind: 'fb', sections: { input: [m('x', 'Int')], output: [], inOut: [], static: [] } }
        : null;
    const r = layoutInstance(
      {
        input: [m('a', 'Bool'), m('t', 'Timer')],
        output: [m('b', 'Bool')],
        inOut: [m('c', 'Int'), m('d', 'Array[1..10] of Byte')],
        static: [m('e', 'Bool'), m('inst', '"Sub"')],
      },
      resolve,
    );
    expect(offsets(r)).toEqual({
      a: '0.0',
      t: '2.0',
      b: '4.0',
      c: '6.0',
      d: '8.0',
      e: '14.0',
      inst: '16.0',
      'inst.x': '16.0',
    });
    expect(r.ok && r.sizeBytes).toBe(18);
  });

  it('UDT: layout come struct, sconosciuto e ricorsivo', () => {
    const udt: TypeResolver = (n) =>
      n === 'U' ? { kind: 'udt', members: [m('p', 'Byte'), m('q', 'Int')] } : null;
    const r = layoutStruct([m('b', 'Bool'), m('u', '"U"')], udt);
    expect(offsets(r)).toEqual({ b: '0.0', u: '2.0', 'u.p': '2.0', 'u.q': '4.0' });
    expect(r.ok && r.sizeBytes).toBe(6);

    expect(layoutStruct([m('u', '"Manca"')], none)).toEqual({
      ok: false,
      error: 'UNKNOWN_TYPE',
      name: 'Manca',
    });
    const loop: TypeResolver = (n) =>
      n === 'A'
        ? { kind: 'udt', members: [m('b', '"B"')] }
        : n === 'B'
          ? { kind: 'udt', members: [m('a', '"A"')] }
          : null;
    expect(layoutStruct([m('x', '"A"')], loop)).toMatchObject({ ok: false, error: 'CYCLE' });
  });

  it('Void non è disponibile in memoria; tipi parametro hanno la loro dimensione', () => {
    expect(layoutStruct([{ name: 'v', type: { kind: 'void' } }], none)).toMatchObject({
      ok: false,
      error: 'NOT_LAYOUTABLE',
    });
    const r = layoutStruct([m('t', 'Timer'), m('p', 'Pointer'), m('a', 'Any'), m('d', 'DT')], none);
    expect(offsets(r)).toEqual({ t: '0.0', p: '2.0', a: '8.0', d: '18.0' });
    expect(r.ok && r.sizeBytes).toBe(26);
  });
});
