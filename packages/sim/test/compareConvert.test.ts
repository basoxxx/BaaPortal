import { describe, expect, it } from 'vitest';
import { SimError } from '../src';
import { runAwl } from './helpers';

const prog = (...lines: string[]): string[] => [lines.map((l) => `\t${l};`).join('\n')];

const f32 = (x: number): number => {
  const v = new DataView(new ArrayBuffer(4));
  v.setFloat32(0, x, false);
  return v.getUint32(0, false);
};
const toF = (u: number): number => {
  const v = new DataView(new ArrayBuffer(4));
  v.setUint32(0, u >>> 0, false);
  return v.getFloat32(0, false);
};

function run(ins: string, accu2: number, accu1: number, stw: object = {}) {
  return runAwl(prog(ins), { regs: { accu1, accu2, stw } });
}
const cc = (r: ReturnType<typeof run>): string =>
  `${r.regs.stw.cc1 ? 1 : 0}${r.regs.stw.cc0 ? 1 : 0}`;

// Manuale AWL, «Operazioni di confronto»: ACCU2 confrontato con ACCU1; RLO = risultato;
// CC: uguale 00, ACCU2 < ACCU1 01, ACCU2 > ACCU1 10, non confrontabile 11.
// [ACCU2, ACCU1, CC, ==, <>, >, <, >=, <=]
type Cmp = [number, number, string, boolean, boolean, boolean, boolean, boolean, boolean];
const ORDER = ['==', '<>', '>', '<', '>=', '<='];
function checkCmp(suffix: string, table: Cmp[]) {
  for (const [a2, a1, ccE, ...exp] of table) {
    it(`confronti ${suffix} ${a2.toString(16)} ? ${a1.toString(16)}`, () => {
      ORDER.forEach((op, i) => {
        const r = run(op + suffix, a2, a1);
        expect(r.regs.stw.rlo).toBe(exp[i]);
        expect(r.regs.stw.sta).toBe(exp[i]);
        expect(r.regs.stw.fc).toBe(true);
        expect(r.regs.stw.or).toBe(false);
        expect(cc(r)).toBe(ccE);
        expect(r.regs.stw.ov).toBe(false);
        expect(r.regs.accu1).toBe(a1);
        expect(r.regs.accu2).toBe(a2);
      });
    });
  }
}
checkCmp('I', [
  [5, 5, '00', true, false, false, false, true, true],
  [0xffff, 1, '01', false, true, false, true, false, true], // -1 < 1
  [3, 0xfffe, '10', false, true, true, false, true, false],
  [0xaaaa0005, 0xbbbb0005, '00', true, false, false, false, true, true], // solo parole basse
]);
checkCmp('D', [
  [7, 7, '00', true, false, false, false, true, true],
  [0x80000000, 1, '01', false, true, false, true, false, true],
  [1, 0xffffffff, '10', false, true, true, false, true, false],
]);
checkCmp('R', [
  [f32(1.5), f32(1.5), '00', true, false, false, false, true, true],
  [f32(-1), f32(2), '01', false, true, false, true, false, true],
  [f32(2), f32(-1), '10', false, true, true, false, true, false],
  [f32(0), f32(-0), '00', true, false, false, false, true, true],
]);

describe('confronti: casi particolari', () => {
  it('==R con NaN → CC 11, RLO 0', () => {
    for (const op of ORDER) {
      const r = run(op + 'R', f32(NaN), f32(1));
      expect(r.regs.stw.rlo).toBe(false);
      expect(cc(r)).toBe('11');
      expect(r.regs.stw).toMatchObject({ ov: true, os: true });
    }
  });

  it('il confronto si combina con RLO (prima interrogazione)', () => {
    const first = run('==I', 1, 2, { rlo: true, fc: false });
    expect(first.regs.stw.rlo).toBe(false); // /FC = 0: il valore sostituisce l'RLO
    const chained = run('==I', 1, 1, { rlo: false, fc: true });
    expect(chained.regs.stw.rlo).toBe(false); // /FC = 1: RLO AND vero
  });

  it('OV non si azzera se il confronto non è un REAL non valido; OS resta', () => {
    const r = run('==I', 1, 1, { os: true, ov: true });
    expect(r.regs.stw).toMatchObject({ ov: false, os: true });
  });
});

type Conv = [string, number, number, string | null, boolean];
// Manuale AWL, «Operazioni di conversione». [ins, ACCU1, ACCU1 atteso, CC (null = invariato), overflow]
const CONV: Conv[] = [
  ['BTI', 0xaaaa0123, 0xaaaa007b, null, false],
  ['BTI', 0xaaaaf123, 0xaaaaff85, null, false], // -123
  ['BTI', 0x0999, 999, null, false],
  ['ITB', 0xaaaa007b, 0xaaaa0123, null, false],
  ['ITB', 0xaaaaff85, 0xaaaaf123, null, false],
  ['ITB', 0x03e7, 0x0999, null, false],
  ['ITB', 0x03e8, 0x03e8, null, true], // 1000 fuori campo: ACCU1 invariato
  ['ITB', 0xfc17, 0xfc17, null, true], // -1001
  ['BTD', 0x01234567, 1234567, null, false],
  ['BTD', 0xf1234567, -1234567 >>> 0, null, false],
  ['ITD', 0xaaaa7fff, 0x00007fff, null, false],
  ['ITD', 0xaaaa8000, 0xffff8000, null, false],
  ['DTB', 123456, 0x00123456, null, false],
  ['DTB', -1234567 >>> 0, 0xf1234567, null, false],
  ['DTB', 10000000, 10000000, null, true],
  ['DTB', -10000000 >>> 0, -10000000 >>> 0, null, true],
  ['DTR', 3, f32(3), null, false],
  ['DTR', -16777217 >>> 0, f32(-16777216), null, false], // arrotondato a 32 bit
  ['INVI', 0xaaaa00ff, 0xaaaaff00, null, false],
  ['INVD', 0x0f0f0f0f, 0xf0f0f0f0, null, false],
  ['NEGI', 5, 0xfffb, '01', false],
  ['NEGI', 0xaaaa0000, 0xaaaa0000, '00', false],
  ['NEGI', 0xfffb, 5, '10', false],
  ['NEGI', 0x8000, 0x8000, '01', true],
  ['NEGD', 5, 0xfffffffb, '01', false],
  ['NEGD', 0x80000000, 0x80000000, '01', true],
  ['CAW', 0xaaaa1234, 0xaaaa3412, null, false],
  ['CAD', 0x11223344, 0x44332211, null, false],
  ['RND', f32(2.5), 2, null, false],
  ['RND', f32(3.5), 4, null, false],
  ['RND', f32(-2.5), -2 >>> 0, null, false],
  ['RND', f32(2.4), 2, null, false],
  ['RND', f32(2.6), 3, null, false],
  ['RND+', f32(2.1), 3, null, false],
  ['RND+', f32(-2.1), -2 >>> 0, null, false],
  ['RND-', f32(2.9), 2, null, false],
  ['RND-', f32(-2.1), -3 >>> 0, null, false],
  ['TRUNC', f32(2.9), 2, null, false],
  ['TRUNC', f32(-2.9), -2 >>> 0, null, false],
  ['RND', f32(3e10), f32(3e10), null, true],
  ['TRUNC', f32(-3e10), f32(-3e10), null, true],
  ['RND-', f32(NaN), f32(NaN), null, true],
  ['RND+', f32(Infinity), f32(Infinity), null, true],
  ['RND', f32(2147483648), f32(2147483648), null, true],
  ['RND', f32(-2147483648), 0x80000000, null, false],
];

describe('conversioni', () => {
  for (const [ins, a1, exp, ccE, ov] of CONV) {
    it(`${ins} ${a1.toString(16)}`, () => {
      const before = { cc0: true, cc1: false };
      const r = run(ins, 0x1357, a1, before);
      expect(r.regs.accu1).toBe(exp >>> 0);
      expect(r.regs.accu2).toBe(0x1357);
      expect(r.regs.stw.ov).toBe(ov);
      expect(r.regs.stw.os).toBe(ov);
      if (ccE) expect(cc(r)).toBe(ccE);
      else expect(cc(r)).toBe('01'); // CC invariato
    });
  }

  it('NEGR inverte il segno senza toccare la parola di stato', () => {
    const stw = { cc0: true, cc1: true, ov: true, os: false };
    for (const [a, e] of [
      [2.5, -2.5],
      [-2.5, 2.5],
      [0, -0],
    ] as const) {
      const r = run('NEGR', 0, f32(a), stw);
      expect(r.regs.accu1).toBe(f32(e));
      expect(r.regs.stw).toMatchObject(stw);
    }
  });

  it('confronto con OR = 1: OR-bit OR risultato', () => {
    // A M0.0 / A M0.1 / O / L / L / ==I: l'OR-bit pendente entra nel risultato (regola di A).
    const set = { setup: (m: { M: Uint8Array }) => (m.M[0] = 3) };
    const r = runAwl(prog('A M 0.0', 'A M 0.1', 'O', 'L 1', 'L 2', '==I'), set);
    expect(r.regs.stw.rlo).toBe(true); // OR-bit 1 OR (falso)
    const f = runAwl(prog('A M 0.0', 'A M 0.1', 'O', 'L 1', 'L 2', '==I'));
    expect(f.regs.stw.rlo).toBe(false);
    const t = runAwl(prog('A M 0.0', 'A M 0.1', 'O', 'L 1', 'L 1', '==I'));
    expect(t.regs.stw.rlo).toBe(true);
    const p = runAwl(prog('AN M 0.0', 'AN M 0.1', 'O', 'L 1', 'L 2', '==I'));
    expect(p.regs.stw.or).toBe(false);
  });

  it('RND 2.5 → 2, 3.5 → 4', () => {
    expect(run('RND', 0, f32(2.5)).regs.accu1).toBe(2);
    expect(run('RND', 0, f32(3.5)).regs.accu1).toBe(4);
  });

  it('TRUNC 3e10 → OV', () => {
    const r = run('TRUNC', 0, f32(3e10));
    expect(r.regs.accu1).toBe(f32(3e10));
    expect(r.regs.stw).toMatchObject({ ov: true, os: true });
    expect(toF(r.regs.accu1)).toBeGreaterThan(2.9e10);
  });

  it('BTI con BCD non valido → BCD_NON_VALIDO', () => {
    for (const [ins, v] of [
      ['BTI', 0x00a5],
      ['BTI', 0x0f23],
      ['BTD', 0x0a000000],
      ['BTD', 0x0000009b],
    ] as const) {
      expect(() => run(ins, 0, v)).toThrow(SimError);
      try {
        run(ins, 0, v);
      } catch (e) {
        expect((e as SimError).code).toBe('BCD_NON_VALIDO');
      }
    }
  });

  it('NEGI -32768 → overflow', () => {
    const r = run('NEGI', 0, 0x8000);
    expect(r.regs.accu1).toBe(0x8000);
    expect(r.regs.stw).toMatchObject({ cc1: false, cc0: true, ov: true, os: true });
  });
});
