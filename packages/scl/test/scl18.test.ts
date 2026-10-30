// SCL della versione 1.8: TIME, S5TIME, DATE, TIME_OF_DAY, CHAR; STRING, STRUCT, ARRAY e UDT
// interi; parametri per posizione; bit OK (BR) nelle conversioni che escono dal tipo; scrittura
// negli ingressi di una FC. Forma dell'AWL, diagnostiche e, con indirizzi in M, risultati nel
// simulatore (TEMP, DB, FB e multi-istanze si eseguono in `project/test/sclTipi.test.ts`).
import { describe, expect, it } from 'vitest';
import { checkBlockCode } from '@baaportal/awl';
import { tempEndByte } from '@baaportal/mc7';
import type { DataType } from '@baaportal/s7-types';
import { sclToAwl } from '../src/index.js';
import { el, emptyIface, m, makeCtx } from '../../awl/test/ctx.js';
import { runAwl } from '../../sim/test/helpers.js';

const str = (length: number): DataType => ({ kind: 'string', length });
const struct = (...members: ReturnType<typeof m>[]): DataType => ({ kind: 'struct', members });
const arr = (lo: number, hi: number, element: DataType): DataType => ({
  kind: 'array',
  dims: [{ lo, hi }],
  element,
});

const fc = makeCtx(
  'FC',
  emptyIface({
    input: [m('i', el('Int')), m('ps', struct(m('a', el('Int'))))],
    output: [m('o', el('Int'))],
    temp: [
      m('t', el('Time')),
      m('s5', el('S5Time')),
      m('d', el('Date')),
      m('tod', el('Time_Of_Day')),
      m('c', el('Char')),
      m('n', el('Int')),
      m('s', str(8)),
      m('u', str(4)),
      m('a', struct(m('x', el('Int')), m('y', el('Real')))),
      m('b', struct(m('x', el('Int')), m('y', el('Real')))),
      m('z', struct(m('x', el('Int')))),
      m('v', arr(1, 3, el('DInt'))),
    ],
    returnType: { kind: 'void' },
  }),
);
const out = (text: string, ctx = fc) => sclToAwl(text, ctx, tempEndByte(ctx.owner.iface.temp, ctx));
const ok = (text: string, ctx = fc) => {
  const r = out(text, ctx);
  expect(r.diagnostics).toEqual([]);
  expect(checkBlockCode([r.source], ctx, 'international')).toEqual([]);
  return r.source.replace(/\s+/g, ' ');
};
const diag = (text: string, ctx = fc) => {
  const r = out(text, ctx);
  expect(r.source).toBe('');
  return r.diagnostics[0]!.message;
};

describe('sclToAwl 1.8: forma dell AWL', () => {
  it('costanti TIME, S5TIME, DATE, TOD e CHAR nella forma AWL', () => {
    const s = ok(
      "t := T#1m30s + TIME#250ms; s5 := S5TIME#2s; d := DATE#2024-1-5; tod := TIME_OF_DAY#8:5:0; c := 'A';",
    );
    expect(s).toContain('L T#1M30S');
    expect(s).toContain('L T#250MS');
    expect(s).toContain('+D');
    expect(s).toContain('L S5T#2S');
    expect(s).toContain('L D#2024-01-05');
    expect(s).toContain('L TOD#08:05:00.000');
    expect(s).toContain("L 'A'");
  });

  it('confronti: TIME, DATE e TOD a 32 bit, CHAR e S5TIME a 16', () => {
    expect(ok('M0.0 := t > T#1s;')).toContain('>D');
    expect(ok('M0.0 := d < D#2100-1-1;')).toContain('<D');
    expect(ok('M0.0 := tod >= TOD#12:0:0;')).toContain('>=D');
    expect(ok("M0.0 := c < 'a';")).toContain('<I');
    expect(ok('M0.0 := s5 = S5T#1s;')).toContain('==I');
  });

  it('valore osservato: TIME come DINT, CHAR come BYTE', () => {
    const r = out("t := T#1s; c := 'x';");
    expect(r.lines.filter((l) => l.value).map((l) => l.value)).toEqual(['DINT', 'BYTE']);
  });

  it('STRUCT e ARRAY interi: L/T di doppie parole e parole', () => {
    // a e b: INT + REAL = 6 byte (2 parole di riempimento: 8); v: 12 byte
    expect(ok('b := a;')).toMatch(/L %LD\d+; T %LD\d+; L %LW\d+; T %LW\d+;/);
    expect(ok('v := v;').match(/T %LD/g)).toHaveLength(3);
  });

  it('STRING: costante a pezzi, variabile con un ciclo', () => {
    const s = ok("s := 'abcdefg';");
    expect(s).toContain('L 8');
    expect(s).toContain('L 7');
    expect(s).toContain('L DW#16#61626364');
    expect(s).toContain('L W#16#6566');
    expect(s).toContain('L B#16#67');
    expect(ok('u := s;')).toContain('%LB[AR1,P#');
    expect(ok("M0.0 := s = 'ab' OR s <> u;")).toMatch(/A %L58.0; ON %L59.0/);
    expect(ok('n := LEN(s);')).toMatch(/L %LB\d+; T #n/);
  });

  it('DINT_TO_INT, ROUND e TRUNC mettono BR a 0 se il valore non ci sta', () => {
    const s = ok('n := DINT_TO_INT(MD0);');
    expect(s).toContain('L L#32767');
    expect(s).toContain('CLR; SAVE');
    expect(ok('MD4 := TRUNC(DWORD_TO_REAL(MD8));')).toContain('JO');
  });
});

describe('sclToAwl 1.8: diagnostiche', () => {
  it('tipi nuovi', () => {
    expect(diag('t := 5;')).toContain('DINT_TO_TIME');
    expect(diag('n := TIME_TO_DINT(t);')).toContain('Tipi diversi');
    expect(diag('t := t * t;')).toContain('TIME_TO_DINT');
    expect(diag('M0.0 := s5 < S5T#1s;')).toContain('S5TIME');
    expect(diag('d := d + d;')).toContain('confronti');
    expect(diag("c := 'ab';")).toContain('un solo carattere');
    expect(diag('t := T#5x;')).toContain('Costante non valida');
    expect(diag('d := D#2024-13-01;')).toContain('Costante non valida');
  });

  it('copie intere', () => {
    expect(diag('z := a;')).toContain('Tipi diversi');
    expect(diag('a := n;')).toContain('Tipi diversi');
    expect(diag('a := ps;')).toContain('parametri complessi delle FC');
    expect(diag("s := 'troppo lunga';")).toContain('ne tiene 8');
    expect(ok("M0.0 := s < 'a';")).toContain('<I');
    expect(diag('M0.0 := s = n;')).toContain('solo con una STRING');
    expect(diag('n := LEN(n);')).toContain('LEN');
    expect(diag("s := 'a$b';")).toContain('$');
  });

  it('ingressi di una FC', () => {
    expect(diag('i := 1;')).toContain('ingresso della FC');
    expect(diag('FOR i := 1 TO 3 DO END_FOR;')).toContain('ingresso della FC');
    expect(diag('"Calcola"(A := 1, R => i);')).toContain('ingresso della FC');
    expect(ok('o := i;')).toContain('T #o');
  });

  it('parametri per posizione', () => {
    const ctx = makeCtx(
      'FC',
      emptyIface({ temp: [m('n', el('Int'))], returnType: { kind: 'void' } }),
    );
    expect(ok('"Calcola"(n + 1, n);', ctx)).toContain('R := #n');
    expect(ok('n := ConRet(1.5) + 1;', ctx)).toContain('X := 1.5');
    expect(diag('"Calcola"(1);', ctx)).toContain('per nome');
    expect(diag('"Calcola"(1, R => n);', ctx)).toContain('non si mescolano');
    expect(diag('n := Nessuna(1);', ctx)).toContain('Funzione non supportata');
  });

  it('parametri complessi', () => {
    const ctx = makeCtx(
      'FB',
      emptyIface({
        temp: [m('x', str(10)), m('k', struct(m('a', el('Int'))))],
        inOut: [m('io', str(4))],
      }),
    );
    expect(diag('x := io;', ctx)).toContain('IN_OUT');
    expect(diag('"Nastro_DB"(Buf := k);', ctx)).toContain('IN_OUT');
  });
});

// ---- esecuzione nel simulatore, con indirizzi in M ----

const abs = makeCtx('FC', emptyIface({ returnType: { kind: 'void' } }));
/** BR a 1 prima del testo, copiato in M 50.0 dopo. */
const run = (text: string, setup: (v: DataView) => void = () => undefined): DataView => {
  const r = sclToAwl(text, abs, 0);
  expect(r.diagnostics).toEqual([]);
  const res = runAwl(['SET\nSAVE', `${r.source}\nA BR\n= M 50.0`], {
    setup: (mem) => setup(new DataView(mem.M.buffer, mem.M.byteOffset, mem.M.byteLength)),
  });
  return new DataView(res.mem.M.buffer, res.mem.M.byteOffset, res.mem.M.byteLength);
};
const br = (v: DataView) => v.getUint8(50) & 1;

describe('sclToAwl 1.8: risultati nel simulatore', () => {
  it('TIME: somma, differenza, meno, confronti e conversioni', () => {
    const v = run(
      [
        'MD0 := TIME_TO_DINT(T#1m30s + T#250ms);',
        'MD4 := TIME_TO_DINT(DINT_TO_TIME(MD0) - T#2m);',
        'MD8 := TIME_TO_DINT(-DINT_TO_TIME(MD0));',
        'M12.0 := DINT_TO_TIME(MD0) > T#1m;',
        'M12.1 := DINT_TO_TIME(MD4) < T#0ms;',
        'M12.2 := DINT_TO_TIME(MD0) = T#90s250ms;',
        'M12.3 := DINT_TO_TIME(MD0) <> T#90s250ms;',
        'MD14 := TIME_TO_DINT(T#-1d2h);',
      ].join('\n'),
    );
    expect([v.getInt32(0), v.getInt32(4), v.getInt32(8)]).toEqual([90250, -29750, -90250]);
    expect(v.getUint8(12) & 15).toBe(0b0111);
    expect(v.getInt32(14)).toBe(-93_600_000);
    expect(br(v)).toBe(1);
  });

  it('CHAR: costanti, confronti e conversioni', () => {
    const v = run(
      [
        "MW0 := CHAR_TO_INT('A');",
        "M2.0 := BYTE_TO_CHAR(MB3) < 'a';",
        "M2.1 := INT_TO_CHAR(MW0 + 1) = 'B';",
        'MB4 := CHAR_TO_BYTE(INT_TO_CHAR(MW0 + 33));',
        "M2.2 := BYTE_TO_CHAR(MB3) >= 'Z';",
      ].join('\n'),
      (v) => v.setUint8(3, 0x5a),
    );
    expect(v.getInt16(0)).toBe(65);
    expect(v.getUint8(2) & 7).toBe(0b111);
    expect(v.getUint8(4)).toBe(0x62);
  });

  it('DATE e TOD si confrontano senza segno', () => {
    const v = run(
      [
        'M0.0 := D#2100-01-01 > D#2024-01-01;',
        'M0.1 := D#2168-12-31 > D#2079-06-06;',
        'M0.2 := TOD#23:59:59.999 > TOD#0:0:0;',
        'M0.3 := D#2024-01-01 = D#2024-1-1;',
      ].join('\n'),
    );
    expect(v.getUint8(0) & 15).toBe(15);
  });

  it('DINT_TO_INT: nel campo BR resta 1, fuori i bit bassi e BR a 0', () => {
    const inRange = run('MW0 := DINT_TO_INT(MD4);', (v) => v.setInt32(4, -32768));
    expect([inRange.getInt16(0), br(inRange)]).toEqual([-32768, 1]);
    const high = run('MW0 := DINT_TO_INT(MD4);', (v) => v.setInt32(4, 70000));
    expect([high.getInt16(0), br(high)]).toEqual([4464, 0]);
    const low = run('MW0 := DINT_TO_INT(MD4) + 1;', (v) => v.setInt32(4, -32769));
    // -32769 tiene i bit bassi 16#7FFF; + 1 dà -32768
    expect([low.getInt16(0), br(low)]).toEqual([-32768, 0]);
    const edge = run('MW0 := DINT_TO_INT(MD4);', (v) => v.setInt32(4, 32767));
    expect([edge.getInt16(0), br(edge)]).toEqual([32767, 1]);
  });

  it('ROUND e TRUNC: fuori dal campo DINT BR a 0', () => {
    const good = run('MD0 := ROUND(DWORD_TO_REAL(MD4));', (v) => v.setFloat32(4, -2.5e9 / 2));
    expect([good.getInt32(0), br(good)]).toEqual([-1_250_000_000, 1]);
    const bad = run('MD0 := TRUNC(DWORD_TO_REAL(MD4));', (v) => v.setFloat32(4, 3e9));
    expect(br(bad)).toBe(0);
    const nested = run('MW0 := DINT_TO_INT(ROUND(DWORD_TO_REAL(MD4)));', (v) =>
      v.setFloat32(4, 12.6),
    );
    expect([nested.getInt16(0), br(nested)]).toEqual([13, 1]);
  });
});
