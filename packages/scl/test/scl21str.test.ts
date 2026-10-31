// SCL 2.1: funzioni STRING (CONCAT, LEFT, RIGHT, MID, FIND, INSERT, DELETE, REPLACE) e confronti
// `<`/`>` fra STRING, eseguite nel simulatore e confrontate con un modello delle FC IEC di STEP 7
// (casi limite: STRING vuote, lunghezza massima, posizioni 0, negative e oltre la fine).
import { describe, expect, it } from 'vitest';
import { checkBlockCode } from '@baaportal/awl';
import { encodeCode, tempEndByte } from '@baaportal/mc7';
import type { DataType } from '@baaportal/s7-types';
import { sclToAwl } from '../src/index.js';
import { emptyIface, m, makeCtx } from '../../awl/test/ctx.js';
import {
  CounterBank,
  Program,
  SimMemory,
  TimerBank,
  memorySizesFor,
  newRegisters,
  runBlock,
} from '../../sim/src/index.js';

/** Come `runAwl` dei test del simulatore, ma con 1024 byte di dati locali (le STRING di appoggio). */
function runAwl(networks: string[]): { mem: SimMemory } {
  const r = encodeCode(networks);
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const starts = r.add.networks.map((_, i) =>
    r.add.networks.slice(0, i).reduce((a, b) => a + b, 0),
  );
  const mem = new SimMemory(memorySizesFor('cpu-315-2-pn-dp'));
  const program = new Program();
  program.put({ kind: 'OB', number: 1, code: r.mc7, localBytes: 1024, networkStarts: starts });
  runBlock(
    {
      mem,
      regs: newRegisters(),
      program,
      now: () => 0,
      timers: new TimerBank(256, () => 0),
      counters: new CounterBank(256),
      maxCycleMs: 1000,
      cycleStart: 0,
      trace: () => undefined,
    },
    'OB',
    1,
  );
  return { mem };
}

const str = (length: number): DataType => ({ kind: 'string', length });
// a: L 0, b: L 12, r: L 24 (STRING[6]), big: L 32 (STRING[30]); i numeri in MW 60
const ctx = makeCtx(
  'FC',
  emptyIface({
    temp: [m('a', str(10)), m('b', str(10)), m('r', str(6)), m('big', str(30))],
    returnType: { kind: 'void' },
  }),
);
const tempEnd = tempEndByte(ctx.owner.iface.temp, ctx);

/** Esegue il testo dopo `a := …; b := …;` e rende L, la STRING in `at` e BR. */
function run(text: string, a: string, b: string, at = 24) {
  const src = `a := '${a}'; b := '${b}';\n${text}`;
  const r = sclToAwl(src, ctx, tempEnd);
  expect(r.diagnostics).toEqual([]);
  expect(checkBlockCode([r.source], ctx, 'international')).toEqual([]);
  const res = runAwl(['SET\nSAVE', `${r.source}\nA BR\n= M 50.0`]);
  const L = res.mem.L;
  const s = String.fromCharCode(...L.subarray(at + 2, at + 2 + L[at + 1]!));
  return {
    s,
    max: L[at]!,
    br: res.mem.M[50]! & 1,
    n: (res.mem.M[60]! << 8) | res.mem.M[61]!,
    M: res.mem.M,
  };
}

type R = { s: string; ok: boolean };
const bad: R = { s: '', ok: false };
const fit = (s: string, max: number): R => ({ s: s.slice(0, max), ok: s.length <= max });
/** Il modello: le FC IEC di STEP 7 (FC 2, 20, 32, 26, 17, 4, 31) come le descrive il manuale. */
const model = {
  CONCAT: (a: string, b: string, max: number) => fit(a + b, max),
  LEFT: (a: string, l: number, max: number) => (l < 0 ? bad : fit(a.slice(0, l), max)),
  RIGHT: (a: string, l: number, max: number) =>
    l < 0 ? bad : fit(a.slice(a.length - Math.min(l, a.length)), max),
  MID: (a: string, l: number, p: number, max: number) =>
    l <= 0 || p <= 0 || p > a.length ? bad : fit(a.substr(p - 1, l), max),
  INSERT: (a: string, b: string, p: number, max: number) =>
    p < 0 ? bad : fit(a.slice(0, p) + b + a.slice(p), max),
  DELETE: (a: string, l: number, p: number, max: number) =>
    l < 0 || p < 0
      ? bad
      : l === 0 || p === 0 || p > a.length
        ? fit(a, max)
        : fit(a.slice(0, p - 1) + a.slice(p - 1 + l), max),
  REPLACE: (a: string, b: string, l: number, p: number, max: number) => {
    if (l < 0 || p < 0) return bad;
    if (l === 0) return fit(a, max);
    const p0 = Math.min(Math.max(p, 1) - 1, a.length);
    return fit(a.slice(0, p0) + b + a.slice(p0 + l), max);
  },
};

const A = ['', 'a', 'abc', 'abcdefghij'];
const B = ['', 'X', 'XYZ'];
const NUM = [-1, 0, 1, 2, 3, 10, 11];

describe('SCL 2.1: funzioni STRING nel simulatore', () => {
  it('CONCAT: risultato troncato alla destinazione, BR a 0', () => {
    for (const a of A)
      for (const b of B)
        for (const [dst, at, max] of [
          ['r', 24, 6],
          ['big', 32, 30],
        ] as const) {
          const got = run(`${dst} := CONCAT(a, b);`, a, b, at);
          const want = model.CONCAT(a, b, max);
          expect([got.s, got.br, got.max], `${a}+${b}→${dst}`).toEqual([want.s, +want.ok, max]);
        }
  });

  it('LEFT e RIGHT', () => {
    for (const a of A)
      for (const l of NUM)
        for (const f of ['LEFT', 'RIGHT'] as const) {
          const got = run(`r := ${f}(a, ${l});`, a, '');
          const want = model[f](a, l, 6);
          expect([got.s, got.br], `${f}('${a}', ${l})`).toEqual([want.s, +want.ok]);
        }
  });

  it('MID e DELETE', () => {
    for (const a of A)
      for (const l of NUM)
        for (const p of NUM)
          for (const f of ['MID', 'DELETE'] as const) {
            const got = run(`big := ${f}(a, ${l}, ${p});`, a, '', 32);
            const want = model[f](a, l, p, 30);
            expect([got.s, got.br], `${f}('${a}', ${l}, ${p})`).toEqual([want.s, +want.ok]);
          }
  });

  it('INSERT e REPLACE', () => {
    for (const a of A)
      for (const b of B)
        for (const p of NUM) {
          const ins = run(`r := INSERT(a, b, ${p});`, a, b);
          const want = model.INSERT(a, b, p, 6);
          expect([ins.s, ins.br], `INSERT('${a}', '${b}', ${p})`).toEqual([want.s, +want.ok]);
          for (const l of [-1, 0, 1, 2, 20]) {
            const got = run(`big := REPLACE(a, b, ${l}, ${p});`, a, b, 32);
            const w = model.REPLACE(a, b, l, p, 30);
            expect([got.s, got.br], `REPLACE('${a}', '${b}', ${l}, ${p})`).toEqual([w.s, +w.ok]);
          }
        }
  });

  it('FIND: posizione da 1, 0 se manca o se IN2 è vuota', () => {
    const cases: [string, string][] = [
      ['abcdefghij', 'cde'],
      ['abcdefghij', 'a'],
      ['abcdefghij', 'j'],
      ['abcdefghij', 'ij'],
      ['abcdefghij', 'jk'],
      ['abc', 'abcd'],
      ['', 'a'],
      ['abc', ''],
      ['aab', 'ab'],
    ];
    for (const [a, b] of cases) {
      const got = run('MW60 := FIND(a, b);', a, b);
      expect(got.n, `FIND('${a}', '${b}')`).toBe(b === '' ? 0 : a.indexOf(b) + 1);
      expect(got.br).toBe(1);
    }
  });

  it('< > <= >= fra STRING: per codice, la più corta prima', () => {
    const words = ['', 'a', 'ab', 'abc', 'abd', 'b', 'B', 'aa'];
    for (const a of words)
      for (const b of words) {
        const got = run(
          'M0.0 := a < b; M0.1 := a > b; M0.2 := a <= b; M0.3 := a >= b; M0.4 := a = b;',
          a,
          b,
        );
        const bits = got.M[0]! & 31;
        const want =
          +(a < b) | (+(a > b) << 1) | (+(a <= b) << 2) | (+(a >= b) << 3) | (+(a === b) << 4);
        expect(bits, `'${a}' ? '${b}'`).toBe(want);
        expect(got.br).toBe(1);
      }
  });

  it('annidate, con costanti, e la destinazione fra i parametri', () => {
    expect(run("r := CONCAT(LEFT(a, 2), RIGHT('xyz', 1));", 'abc', '').s).toBe('abz');
    expect(run('a := CONCAT(b, a); r := LEFT(a, 6);', 'abc', 'XY').s).toBe('XYabc');
    expect(run("a := REPLACE(a, 'Q', 1, 2); r := a;", 'abc', '').s).toBe('aQc');
    expect(run("MW60 := LEN(CONCAT(a, 'xy')) + FIND(CONCAT(a, b), 'cX');", 'abc', 'X').n).toBe(8);
    expect(run("M0.0 := CONCAT(a, b) = 'abcX';", 'abc', 'X').M[0]! & 1).toBe(1);
    expect(run('r := CONCAT(IN1 := a, IN2 := b);', 'ab', 'c').s).toBe('abc');
  });
});

describe('SCL 2.1: funzioni STRING, diagnostiche', () => {
  const diag = (text: string) => sclToAwl(text, ctx, tempEnd).diagnostics[0]?.message ?? '';
  it('parametri e uso', () => {
    expect(diag('r := LEFT(a);')).toContain('LEFT vuole 2 parametri');
    expect(diag('r := MID(a, 1);')).toContain('MID vuole 3 parametri');
    expect(diag('MW0 := CONCAT(a, b);')).toContain('dà una STRING');
    expect(diag('r := LEFT(a, 1.5);')).toContain('Tipi diversi');
    expect(diag('r := LEFT(MW0, 1);')).toContain('vuole una STRING');
    expect(diag('MW0 := FIND(a, MW0);')).toContain('vuole una STRING');
  });
});

describe('SCL 2.1: LEN di una funzione STRING in una condizione', () => {
  it('la funzione si calcola prima, fuori da A( … )', () => {
    const r = sclToAwl(
      'M1.0 := M0.0 AND LEN(CONCAT(a, LEFT(b, "ConRet"(1.0)))) > 3;',
      ctx,
      tempEnd,
    );
    expect(r.diagnostics).toEqual([]);
    expect(checkBlockCode([r.source], ctx, 'international')).toEqual([]);
    const inner = r.source.slice(r.source.indexOf('A('));
    expect(inner.slice(0, inner.indexOf('\n)'))).not.toMatch(/CALL|\bJ[A-Z]*\b|LOOP/);
  });

  it('nel simulatore', () => {
    for (const [a, b, want] of [
      ['ab', 'XYZ', 1],
      ['a', 'XYZ', 0],
    ] as const) {
      const res = run(`M0.0 := TRUE;\nM1.0 := M0.0 AND LEN(CONCAT(a, LEFT(b, 2))) > 3;`, a, b);
      expect(res.M[1]! & 1, `${a}+${b}`).toBe(want);
    }
  });
});
