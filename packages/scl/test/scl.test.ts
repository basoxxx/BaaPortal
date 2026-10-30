// Traduzione SCL → AWL: forma dell'AWL generato, diagnostiche e, con indirizzi assoluti, il
// risultato vero eseguito dal simulatore (ordine degli operandi, TEMP, cicli, CASE).
import { describe, expect, it } from 'vitest';
import { checkBlockCode, parseNetwork } from '@baaportal/awl';
import { sclToAwl } from '../src/index.js';
import { el, emptyIface, m, makeCtx } from '../../awl/test/ctx.js';
import { runAwl } from '../../sim/test/helpers.js';

// interfaccia finta del piano: a,b: INT; d: DINT; r: REAL; x,y: BOOL
const ctx = makeCtx(
  'FB',
  emptyIface({
    static: [
      m('a', el('Int')),
      m('b', el('Int')),
      m('d', el('DInt')),
      m('r', el('Real')),
      m('x', el('Bool')),
      m('y', el('Bool')),
    ],
    temp: [m('t', el('Word'))],
  }),
);
const TEMP_END = 2;

const ok = (text: string) => {
  const out = sclToAwl(text, ctx, TEMP_END);
  expect(out.diagnostics).toEqual([]);
  expect(parseNetwork(out.source, 'international').errors).toEqual([]);
  expect(checkBlockCode([out.source], ctx, 'international')).toEqual([]);
  return out.source;
};
const diag = (text: string) => {
  const out = sclToAwl(text, ctx, TEMP_END);
  expect(out.source).toBe('');
  expect(out.diagnostics.length).toBeGreaterThan(0);
  return out.diagnostics[0]!;
};

describe('sclToAwl: AWL generato', () => {
  it('x := a > b AND y', () => {
    const s = ok('x := a > b AND y;');
    for (const t of ['L #a', 'L #b', '>I', 'A #y', '= #x']) expect(s).toContain(t);
  });

  it('d := d + 70000 usa L#', () => {
    const s = ok('d := d + 70000;');
    for (const t of ['L #d', 'L L#70000', '+D', 'T #d']) expect(s).toContain(t);
  });

  it('IF/ELSIF/ELSE, FOR BY -1, WHILE, CASE passano il controllo AWL', () => {
    ok(`
      IF x THEN a := 1;
      ELSIF y AND a < 3 THEN a := 2;
      ELSE a := 3;
      END_IF;
      FOR a := 10 TO 0 BY -1 DO b := b + a; END_FOR;
      WHILE b > 0 DO b := b - 1; END_WHILE;
      REPEAT b := b + 1; UNTIL b >= 5 END_REPEAT;
      CASE a OF
        1, 2: b := 10;
        3: b := 20;
      ELSE b := 30;
      END_CASE;
      RETURN;
    `);
  });

  it('parole chiave senza maiuscole, commenti // e (* *), #nome', () => {
    const s = ok('(* commento\n su due righe *)\nif #x then // fine riga\n  #y := true;\nend_if;');
    expect(s).toContain('SET');
    expect(s).toContain('= #y');
  });

  it('conversioni', () => {
    const s = ok(
      'd := INT_TO_DINT(a); r := INT_TO_REAL(a) + DINT_TO_REAL(d); d := ROUND(r) + TRUNC(r);',
    );
    for (const t of ['ITD', 'DTR', 'RND', 'TRUNC', '+R']) expect(s).toContain(t);
  });

  it('un letterale intero con un REAL diventa REAL; RETURN è BEU', () => {
    const s = ok('r := r * 2; RETURN;');
    expect(s).toContain('L 2.0');
    expect(s).toContain('BEU');
  });

  it('la destra complessa va in una TEMP dopo tempEnd', () => {
    const s = ok('a := a - (b - 1);');
    expect(s).toContain('T %LW2');
    expect(s).toContain('L %LW2');
  });

  it('mappa delle righe verso il testo SCL', () => {
    const out = sclToAwl('x := y;\n\na := b;', ctx, TEMP_END);
    expect(out.lines[0]).toEqual({ line: 0, sclLine: 1 });
    expect(out.lines.at(-1)).toEqual({
      line: out.source.split('\n').length - 1,
      sclLine: 3,
      value: 'INT',
    });
  });

  it('7 parentesi booleane annidate vanno ancora', () => {
    let s = 'x AND y';
    for (let i = 0; i < 7; i++) s = `(${s}) ${i % 2 ? 'AND' : 'OR'} y`;
    ok(`x := ${s};`);
  });
});

describe('sclToAwl: diagnostiche', () => {
  it('tipi diversi: a := d', () => {
    const d = diag('a := d;');
    expect(d.line).toBe(1);
    expect(d.message).toMatch(/DINT_TO_INT|tipi diversi/i);
  });

  it('operando sconosciuto', () => {
    const d = diag('z := 1;');
    expect(d).toMatchObject({ line: 1, message: 'Operando sconosciuto: z' });
    expect(diag('x := y;\na := "Nessuno";').line).toBe(2);
  });

  it('8 parentesi booleane annidate', () => {
    let s = 'x AND y';
    for (let i = 0; i < 8; i++) s = `(${s}) ${i % 2 ? 'AND' : 'OR'} y`;
    expect(diag(`\nx := ${s};`)).toMatchObject({
      line: 2,
      message: expect.stringContaining('Espressione troppo annidata'),
    });
  });

  it("IF senza END_IF: riga dell'IF", () => {
    const d = diag('x := y;\nIF x THEN a := 1;\n\n');
    expect(d.line).toBe(2);
    expect(d.message).toContain('END_IF');
  });

  it('errori di sintassi e costrutti fuori dal sottoinsieme', () => {
    expect(diag('a := (1 + ;').line).toBe(1);
    expect(diag('x := y\na := 1;')).toMatchObject({
      line: 1,
      col: 7,
      message: 'Manca «;» dopo «y»',
    });
    expect(diag('a := a MOD 2;').message).toContain('INT_TO_DINT');
    expect(diag('CASE a OF 1..3: b := 1; 3: b := 2; END_CASE;').message).toContain('ripetuto');
    expect(diag('CASE a OF 5..3: b := 1; END_CASE;').message).toContain('vuoto');
    expect(diag('CASE a OF 1: b := 1; 1: b := 2; END_CASE;').message).toContain('ripetuto');
    expect(diag('a := 1.5;').line).toBe(1);
    expect(diag('a := 40000;').message).toMatch(/DINT|tipi diversi/i);
    expect(diag('FOR a := 1 TO 3 BY b DO END_FOR;').message).toContain('BY');
    expect(diag('EXIT;').message).toContain('EXIT');
    expect(diag('x := a;').line).toBe(1);
    expect(diag('a := MB10;').message).toContain('BYTE');
    expect(diag('"MAXV" := 1;').line).toBe(1);
  });
});

// ---- esecuzione nel simulatore, con indirizzi assoluti ----

const abs = makeCtx('FC', emptyIface({ returnType: { kind: 'void' } }));
type Mem = { M: Uint8Array };
const view = (mem: Mem) => new DataView(mem.M.buffer, mem.M.byteOffset, mem.M.byteLength);
const run = (
  text: string,
  init: Record<number, number> = {},
  dints: Record<number, number> = {},
) => {
  const out = sclToAwl(text, abs, 0);
  expect(out.diagnostics).toEqual([]);
  const r = runAwl([out.source], {
    setup: (mem) => {
      for (const [at, v] of Object.entries(init)) view(mem).setInt16(Number(at), v);
      for (const [at, v] of Object.entries(dints)) view(mem).setInt32(Number(at), v);
    },
  });
  return {
    w: (at: number) => view(r.mem).getInt16(at),
    dw: (at: number) => view(r.mem).getInt32(at),
    bit: (byte: number, b: number) => (r.mem.M[byte]! >> b) & 1,
  };
};

describe('sclToAwl: risultati nel simulatore', () => {
  const M = { 0: 100, 2: 30, 4: 5, 6: 50, 8: 20 };

  it('- e / con la destra complessa: ordine degli operandi', () => {
    const r = run(
      'MW10 := MW0 - (MW2 - MW4); MW12 := MW0 / (MW2 - MW4); MW14 := MW0 - MW2 - MW4;',
      M,
    );
    expect(r.w(10)).toBe(75);
    expect(r.w(12)).toBe(4);
    expect(r.w(14)).toBe(65);
  });

  it('più TEMP annidate senza sovrapposizioni', () => {
    const r = run(
      'MW10 := (MW0 - (MW2 - MW4)) - (MW6 - (MW8 - MW4)); MW12 := -(MW0 - MW2) * (MW4 - (MW6 / (MW8 - MW4)));',
      M,
    );
    expect(r.w(10)).toBe(75 - 35);
    expect(r.w(12)).toBe(-70 * (5 - 3));
  });

  it('DINT e REAL con destra complessa', () => {
    const r = run(
      'MD20 := INT_TO_DINT(MW0) - (70000 - INT_TO_DINT(MW2)); MD24 := ROUND(DINT_TO_REAL(MD40) / (DINT_TO_REAL(MD44) - 1.5)); MD28 := 100000 MOD INT_TO_DINT(MW2);',
      M,
      { 40: 10, 44: 4 },
    );
    expect(r.dw(20)).toBe(100 - 69970);
    expect(r.dw(24)).toBe(4);
    expect(r.dw(28)).toBe(10);
  });

  it('logica booleana con OR, AND, XOR, NOT e confronti', () => {
    const expr = 'M30.0 := (M31.0 OR M31.1) AND NOT (M31.2 XOR M31.3) AND MW0 > MW2;';
    for (let v = 0; v < 16; v++) {
      const [a, b, c, d] = [v & 1, (v >> 1) & 1, (v >> 2) & 1, (v >> 3) & 1];
      const out = sclToAwl(expr, abs, 0);
      const r = runAwl([out.source], {
        setup: (mem) => {
          mem.M[31] = v;
          view(mem).setInt16(0, 100);
          view(mem).setInt16(2, 30);
        },
      });
      expect((r.mem.M[30]! & 1) === 1).toBe(Boolean(a | b) && !(c ^ d));
    }
  });

  it('IF/ELSIF/ELSE prende un ramo solo', () => {
    const t = 'IF MW0 < 10 THEN MW10 := 1; ELSIF MW0 < 20 THEN MW10 := 2; ELSE MW10 := 3; END_IF;';
    expect(run(t, { 0: 5 }).w(10)).toBe(1);
    expect(run(t, { 0: 15 }).w(10)).toBe(2);
    expect(run(t, { 0: 25 }).w(10)).toBe(3);
  });

  it('CASE non ricade nei rami successivi', () => {
    const t =
      'MW12 := 0; CASE MW0 OF 1, 2: MW10 := 10; 3: MW10 := 20; ELSE MW10 := 30; END_CASE; MW12 := 1;';
    for (const [sel, want] of [
      [1, 10],
      [2, 10],
      [3, 20],
      [7, 30],
    ] as const) {
      const r = run(t, { 0: sel });
      expect(r.w(10)).toBe(want);
      expect(r.w(12)).toBe(1);
    }
    expect(run('CASE MW0 OF 1: MW10 := 5; END_CASE;', { 0: 2, 10: 9 }).w(10)).toBe(9);
  });

  it('FOR, anche ai limiti di INT, termina', () => {
    expect(run('FOR MW0 := 1 TO 10 BY 2 DO MW2 := MW2 + 1; END_FOR;', { 2: 0 }).w(2)).toBe(5);
    expect(run('FOR MW0 := 3 TO 1 DO MW2 := MW2 + 1; END_FOR;', { 2: 0 }).w(2)).toBe(0);
    const up = run('FOR MW0 := 32760 TO 32767 DO MW2 := MW2 + 1; END_FOR;', { 2: 0 });
    expect(up.w(2)).toBe(8);
    expect(up.w(0)).toBe(32767);
    const down = run('FOR MW0 := -32760 TO -32768 BY -1 DO MW2 := MW2 + 1; END_FOR;', { 2: 0 });
    expect(down.w(2)).toBe(9);
    const dint = run('FOR MD4 := 2147483640 TO 2147483647 DO MW2 := MW2 + 1; END_FOR;', { 2: 0 });
    expect(dint.w(2)).toBe(8);
    // la fine si calcola una volta sola
    expect(
      run('MW4 := 3; FOR MW0 := 1 TO MW4 DO MW4 := 10; MW2 := MW2 + 1; END_FOR;', { 2: 0 }).w(2),
    ).toBe(3);
  });

  it('WHILE e REPEAT', () => {
    expect(run('WHILE MW0 < 5 DO MW0 := MW0 + 1; END_WHILE;', { 0: 0 }).w(0)).toBe(5);
    expect(run('WHILE MW0 < 5 DO MW0 := MW0 + 1; END_WHILE;', { 0: 9 }).w(0)).toBe(9);
    expect(run('REPEAT MW0 := MW0 + 1; UNTIL MW0 >= 5 END_REPEAT;', { 0: 9 }).w(0)).toBe(10);
  });

  it('RETURN salta il resto', () => {
    expect(run('MW0 := 1; IF MW0 = 1 THEN RETURN; END_IF; MW0 := 2;').w(0)).toBe(1);
  });

  it('assegnazioni BOOL con TRUE e FALSE, indirizzi I/Q/M', () => {
    const r = run('M1.0 := TRUE; M1.1 := FALSE; M1.2 := NOT M1.0 OR %M1.0;');
    expect([r.bit(1, 0), r.bit(1, 1), r.bit(1, 2)]).toEqual([1, 0, 1]);
  });
});
