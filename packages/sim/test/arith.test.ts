import { describe, expect, it } from 'vitest';
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

/** Codice CC come stringa «CC1 CC0». */
const cc = (r: ReturnType<typeof runAwl>): string =>
  `${r.regs.stw.cc1 ? 1 : 0}${r.regs.stw.cc0 ? 1 : 0}`;

type IntCase = [string, number, number, number, string, boolean];

function runInt(ins: string, accu2: number, accu1: number, os = false) {
  return runAwl(prog(ins), { regs: { accu1, accu2, stw: { os } } });
}

// Manuale AWL, «Operazioni con numeri interi»: ACCU2 (op) ACCU1, CC dal segno del risultato
// avvolto, overflow OV = OS = 1. [istruzione, ACCU2, ACCU1, ACCU1 atteso, CC, OV]
const INT_TABLE: IntCase[] = [
  ['+I', 2, 3, 5, '10', false],
  ['+I', 0xffff, 1, 0, '00', false], // -1 + 1
  ['+I', 0, 0xffff, 0xffff, '01', false],
  ['+I', 0x7fff, 1, 0x8000, '01', true], // 32767+1 → -32768
  ['+I', 0x8000, 0xffff, 0x7fff, '10', true], // -32768-1 → 32767
  ['+I', 0xabcd8000, 0x12348000, 0x12340000, '00', true], // -65536 → 0 con OV
  ['-I', 5, 7, 0xfffe, '01', false],
  ['-I', 0x8000, 1, 0x7fff, '10', true],
  ['*I', 300, 300, 0x00015f90, '10', true], // 90000: 32 bit, OV
  ['*I', 0xfffe, 3, 0xfffffffa, '01', false],
  ['*I', 0x8000, 2, 0xffff0000, '01', true], // -65536: CC dal segno vero
  ['/I', 8, 2, 0x00000004, '10', false],
  ['/I', 0x8000, 0xffff, 0x00008000, '10', true], // -32768 / -1
  ['+D', 1, 2, 3, '10', false],
  ['+D', 0x7fffffff, 1, 0x80000000, '01', true],
  ['+D', 0x80000000, 0xffffffff, 0x7fffffff, '10', true],
  ['-D', 0x80000000, 1, 0x7fffffff, '10', true], // sotto il minimo
  ['-D', 10, 10, 0, '00', false],
  ['*D', 0x10000, 0x10000, 0, '10', true], // 2^32 → 0, CC dal segno vero
  ['*D', 0x10000, 0xffff0000, 0, '01', true], // sotto il minimo
  ['*D', 100000, 100000, 0x540be400, '10', true],
  ['*D', 0xfffffffe, 3, 0xfffffffa, '01', false],
  ['/D', 7, 2, 3, '10', false],
  ['/D', 0xfffffff9, 2, 0xfffffffd, '01', false], // -7/2 → -3
  ['/D', 0x80000000, 0xffffffff, 0x80000000, '10', true],
  ['MOD', 7, 2, 1, '10', false],
  ['MOD', 0xfffffff9, 2, 0xffffffff, '01', false], // -7 mod 2 → -1
  ['MOD', 8, 2, 0, '00', false],
];

describe('aritmetica intera', () => {
  for (const [ins, a2, a1, exp, ccExp, ov] of INT_TABLE) {
    it(`${ins} ${a2.toString(16)}, ${a1.toString(16)}`, () => {
      const r = runInt(ins, a2, a1);
      const keepsHigh = ins === '+I' || ins === '-I';
      const want = keepsHigh ? ((a1 & 0xffff0000) | (exp & 0xffff)) >>> 0 : exp >>> 0;
      expect(r.regs.accu1).toBe(want);
      expect(r.regs.accu2).toBe(a2);
      expect(cc(r)).toBe(ccExp);
      expect(r.regs.stw.ov).toBe(ov);
      expect(r.regs.stw.os).toBe(ov);
    });
  }

  it('+I 32767+1 → overflow', () => {
    const r = runInt('+I', 0x7fff, 1);
    expect(r.regs.accu1 & 0xffff).toBe(0x8000);
    expect(r.regs.stw).toMatchObject({ cc1: false, cc0: true, ov: true, os: true });
  });

  it('/I 7/2 → quoziente 3, resto in ACCU1-H 1', () => {
    const r = runInt('/I', 7, 2);
    expect(r.regs.accu1).toBe(0x00010003);
    expect(cc(r)).toBe('10');
    const n = runInt('/I', 0xfff9, 2); // -7/2 → -3 resto -1
    expect(n.regs.accu1).toBe(0xfffffffd);
  });

  it('/I per 0', () => {
    const r = runInt('/I', 7, 0xabcd0000);
    expect(r.regs.accu1).toBe(0);
    expect(cc(r)).toBe('11');
    expect(r.regs.stw).toMatchObject({ ov: true, os: true });
  });

  it('/D e MOD per 0', () => {
    for (const ins of ['/D', 'MOD']) {
      const r = runInt(ins, 7, 0);
      expect(r.regs.accu1).toBe(0);
      expect(cc(r)).toBe('11');
      expect(r.regs.stw).toMatchObject({ ov: true, os: true });
    }
  });

  it('-D sotto il minimo', () => {
    const r = runInt('-D', 0x80000000, 1);
    expect(r.regs.accu1).toBe(0x7fffffff);
    expect(r.regs.stw).toMatchObject({ cc1: true, cc0: false, ov: true, os: true });
  });

  it('OS resta 1 fino a JOS', () => {
    // OV si azzera col risultato valido, OS (memorizzato) no.
    const r = runAwl(prog('+D', '+D'), {
      regs: { accu1: 1, accu2: 0x7fffffff, stw: {} },
    });
    expect(r.regs.stw).toMatchObject({ ov: false, os: true });
    const q = runAwl(prog('+D'), { regs: { accu1: 1, accu2: 1, stw: { os: true } } });
    expect(q.regs.stw).toMatchObject({ ov: false, os: true });
  });

  it('+ con costante: non tocca la parola di stato', () => {
    const stw = { cc0: true, cc1: true, ov: true, os: false };
    const r = runAwl(prog('+ 5'), { regs: { accu1: 0xaaaaffff, stw } });
    expect(r.regs.accu1).toBe(0xaaaa0004);
    expect(r.regs.stw).toMatchObject(stw);
    const d = runAwl(prog('+ L#-1'), { regs: { accu1: 0, stw } });
    expect(d.regs.accu1).toBe(0xffffffff);
    expect(d.regs.stw).toMatchObject(stw);
    const n = runAwl(prog('+ -5'), { regs: { accu1: 0xaaaa0003, stw } });
    expect(n.regs.accu1).toBe(0xaaaafffe);
    expect(n.regs.stw).toMatchObject(stw);
  });
});

type RealCase = [string, number, number, number, string, boolean];
// Manuale AWL, «Operazioni in virgola mobile» e tabella dei bit di stato. [ins, a2, a1, atteso, CC, OV]
const REAL_TABLE: RealCase[] = [
  ['+R', 1.5, 2.25, 3.75, '10', false],
  ['+R', -1.5, 0.5, -1, '01', false],
  ['+R', 1, -1, 0, '00', false],
  ['-R', 1, 3, -2, '01', false],
  ['*R', 3e38, 10, Infinity, '10', true], // infinito
  ['*R', -3e38, 10, -Infinity, '01', true],
  ['*R', 1e-30, 1e-30, 0, '00', false],
  ['/R', 1, 0, Infinity, '10', true],
  ['/R', 0, 0, NaN, '11', true],
  ['/R', 7, 2, 3.5, '10', false],
  ['SQR', 0, 3, 9, '10', false],
  ['SQRT', 0, 16, 4, '10', false],
  ['SQRT', 0, -1, NaN, '11', true],
  ['EXP', 0, 0, 1, '10', false],
  ['LN', 0, 1, 0, '00', false],
  ['LN', 0, 0, -Infinity, '01', true],
  ['LN', 0, -1, NaN, '11', true],
  ['SIN', 0, 0, 0, '00', false],
  ['COS', 0, 0, 1, '10', false],
  ['TAN', 0, 0, 0, '00', false],
  ['ASIN', 0, 2, NaN, '11', true],
  ['ACOS', 0, 1, 0, '00', false],
  ['ATAN', 0, 1, Math.atan(1), '10', false],
];

describe('aritmetica reale', () => {
  for (const [ins, a2, a1, exp, ccExp, ov] of REAL_TABLE) {
    it(`${ins} ${a2}, ${a1}`, () => {
      const r = runInt(ins, f32(a2), f32(a1));
      expect(r.regs.accu1).toBe(f32(exp));
      expect(cc(r)).toBe(ccExp);
      expect(r.regs.stw.ov).toBe(ov);
      expect(r.regs.stw.os).toBe(ov);
      expect(r.regs.accu2).toBe(f32(a2));
    });
  }

  it('*R → infinito', () => {
    const r = runInt('*R', f32(3e38), f32(10));
    expect(r.regs.accu1).toBe(0x7f800000);
    expect(r.regs.stw).toMatchObject({ cc1: true, cc0: false, ov: true, os: true });
  });

  it('SQRT -1 → NaN e bit', () => {
    const r = runInt('SQRT', 0, f32(-1));
    expect(Number.isNaN(toF(r.regs.accu1))).toBe(true);
    expect(r.regs.stw).toMatchObject({ cc1: true, cc0: true, ov: true, os: true });
  });

  it('denormalizzato → CC 00 con OV e OS', () => {
    // 1e-38 è sotto il minimo normalizzato (1.1754944e-38).
    const r = runInt('+R', f32(1e-38), f32(0));
    expect(cc(r)).toBe('00');
    expect(r.regs.stw).toMatchObject({ ov: true, os: true });
  });

  it('ABS non tocca la parola di stato', () => {
    const stw = { cc0: true, cc1: false, ov: true, os: false };
    const r = runAwl(prog('ABS'), { regs: { accu1: f32(-2.5), stw } });
    expect(toF(r.regs.accu1)).toBe(2.5);
    expect(r.regs.stw).toMatchObject(stw);
  });
});
