// SCL della versione 1.1: stringhe di bit, costanti in base e tipizzate, EXIT/CONTINUE, CASE a
// intervalli, chiamate di blocchi, ARRAY e STRUCT. Forma dell'AWL, diagnostiche e, con indirizzi
// assoluti, risultati nel simulatore (le chiamate si eseguono in `project/test/sclBlock.test.ts`).
import { describe, expect, it } from 'vitest';
import { checkBlockCode } from '@baaportal/awl';
import type { DataType } from '@baaportal/s7-types';
import { sclToAwl } from '../src/index.js';
import { el, emptyIface, m, makeCtx } from '../../awl/test/ctx.js';
import { runAwl } from '../../sim/test/helpers.js';

const arr = (lo: number, hi: number, element: DataType): DataType => ({
  kind: 'array',
  dims: [{ lo, hi }],
  element,
});
const ctx = makeCtx(
  'FB',
  emptyIface({
    input: [m('i', el('Int'))],
    inOut: [m('io', { kind: 'struct', members: [m('z', el('Int'))] })],
    static: [
      m('a', el('Int')),
      m('d', el('DInt')),
      m('r', el('Real')),
      m('x', el('Bool')),
      m('w', el('Word')),
      m('dw', el('DWord')),
      m('bt', el('Byte')),
      m('v', arr(1, 5, el('Int'))),
      m('s', { kind: 'struct', members: [m('k', el('Bool')), m('n', arr(0, 2, el('Real')))] }),
      m('sub', { kind: 'named', name: 'Nastro' }),
    ],
  }),
);
const TEMP_END = 2;

const ok = (text: string) => {
  const out = sclToAwl(text, ctx, TEMP_END);
  expect(out.diagnostics).toEqual([]);
  expect(checkBlockCode([out.source], ctx, 'international')).toEqual([]);
  return out.source;
};
const diag = (text: string) => {
  const out = sclToAwl(text, ctx, TEMP_END);
  expect(out.source).toBe('');
  return out.diagnostics[0]!;
};
const has = (s: string, ...parts: string[]) => {
  const flat = s.replace(/\s+/g, ' ');
  for (const t of parts) expect(flat).toContain(t);
};

describe('sclToAwl 1.1: AWL generato', () => {
  it('BYTE, WORD, DWORD: logica a parola, NOT, confronti, costanti', () => {
    const s = ok(
      'w := w AND 16#FF00 OR W#16#1; dw := dw XOR DW#16#FFFF0000; bt := NOT bt; w := NOT w; dw := NOT dw; x := w <> 2#1010 AND bt = B#16#7F;',
    );
    has(s, 'AW', 'OW', 'XOD', 'L W#16#FF00', 'L DW#16#FFFF0000', 'XOW W#16#FF', 'INVI', 'INVD');
    has(s, 'L W#16#A', '<>I', 'L B#16#7F', '==I');
  });

  it('costanti tipizzate e in base: INT#, DINT#, L#, 8#', () => {
    const s = ok('a := INT#-5 + 8#17; d := DINT#5 + L#-7; d := 16#7FFF_FFFF;');
    has(s, 'L -5', 'L 15', 'L L#5', 'L L#-7', 'L L#2147483647');
  });

  it('conversioni fra stringhe di bit e interi', () => {
    const s = ok(
      'w := INT_TO_WORD(a); a := WORD_TO_INT(w); a := DINT_TO_INT(d); bt := WORD_TO_BYTE(w); dw := WORD_TO_DWORD(BYTE_TO_WORD(bt)); a := DINT_TO_INT(ROUND(r));',
    );
    has(s, 'AW W#16#FF', 'AD DW#16#FFFF', 'RND');
  });

  it('EXIT e CONTINUE nei tre cicli', () => {
    ok(`
      FOR a := 1 TO 10 DO IF x THEN EXIT; END_IF; CONTINUE; END_FOR;
      WHILE a > 0 DO a := a - 1; IF x THEN CONTINUE; END_IF; EXIT; END_WHILE;
      REPEAT IF x THEN CONTINUE; END_IF; EXIT; UNTIL a > 3 END_REPEAT;
    `);
  });

  it('CASE con intervalli', () => {
    has(ok('CASE a OF 1..5: d := 1; 7, 9..12: d := 2; END_CASE;'), '>=I', '<=I', 'A(', 'L 12');
  });

  it('ARRAY e STRUCT con indici costanti, DB globali e di istanza', () => {
    const s = ok(
      'v[1] := v[5] + "Dati".Vet[3]; s.k := NOT s.k; s.n[2] := "Dati".Asse.Pos; a := "Nastro_DB".Cnt; a := sub.Cnt;',
    );
    has(s, '#v[1]', '#v[5]', '"Dati".Vet[3]', '#s.k', '#s.n[2]', '"Dati".Asse.Pos');
    has(s, '"Nastro_DB".Cnt', '#sub.Cnt');
  });

  it('chiamate: FC con ingressi e uscite, valore di ritorno, FB con DB e multi-istanza', () => {
    const s = ok(
      '"Calcola"(A := a + 1, R => a); a := ConRet(X := r) + 1; "Nastro_DB"(Vel := 5, Ok => x); #sub(Vel := a);',
    );
    has(s, 'CALL %FC1', 'A := %LW2', 'R := #a', 'CALL %FC6', 'RET_VAL := %LW2', 'X := #r');
    has(s, 'CALL %FB2, %DB3', 'Vel := 5', 'Ok := #x', 'CALL #sub');
  });

  it('lines: una CALL su più righe va alla riga della chiamata', () => {
    const out = sclToAwl('a := 1;\n"Calcola"(A := 2,\n  R => a);', ctx, TEMP_END);
    const call = out.source.split('\n').findIndex((l) => l.includes('CALL'));
    expect(out.lines[0]!.sclLine).toBe(1);
    expect(out.lines[call]!.sclLine).toBe(2);
    expect(out.lines.at(-1)!.sclLine).toBe(2);
  });
});

describe('sclToAwl 1.1: temporanei BYTE e MD', () => {
  const byteFc = {
    name: 'FByte',
    kind: 'FC' as const,
    number: 20,
    iface: emptyIface({
      input: [m('B', el('Byte')), m('X', el('Bool'))],
      returnType: el('Byte'),
    }),
  };
  const byteFb = {
    name: 'FBy',
    kind: 'FB' as const,
    number: 21,
    iface: emptyIface({ input: [m('B', el('Byte'))], output: [m('O', el('Byte'))] }),
  };
  const byteIdb = { name: 'FBy_DB', kind: 'IDB' as const, number: 21, instanceOf: 'FBy' };
  const bctx = {
    ...ctx,
    block: (ref: Parameters<typeof ctx.block>[0]) =>
      [byteFc, byteFb, byteIdb].find((b) =>
        'name' in ref ? b.name === ref.name : b.kind === ref.kind && b.number === ref.number,
      ) ?? ctx.block(ref),
  };
  const bok = (text: string) => {
    const out = sclToAwl(text, bctx, TEMP_END);
    expect(out.diagnostics).toEqual([]);
    expect(checkBlockCode([out.source], bctx, 'international')).toEqual([]);
    return out.source;
  };

  it('un BYTE calcolato o restituito passa come LB a un parametro BYTE', () => {
    const s = bok(
      'bt := "FByte"(B := bt AND 16#0F, X := x); "FBy_DB"(B := NOT bt, O => bt); x := "FByte"(B := bt, X := TRUE) = 16#FF;',
    );
    has(s, 'B := %LB2', 'RET_VAL := %LB', 'T %LB2');
  });

  it('i temporanei a parola dopo un BYTE restano su indirizzi pari', () => {
    const s = bok('a := WORD_TO_INT(BYTE_TO_WORD("FByte"(B := bt, X := x))) + ConRet(X := r);');
    has(s, 'RET_VAL := %LB2', 'RET_VAL := %LW4');
    expect(s).not.toMatch(/L[WD] [0-9]*[13579]\b/);
  });

  it('MD non diventa REAL dal contesto; la conversione è esplicita', () => {
    expect(diag('r := MD0;').message).toMatch(/DINT_TO_REAL.*DWORD_TO_REAL/);
    expect(diag('r := MD0 * 2;').message).toContain('Tipi diversi');
    ok('MD0 := r;');
    ok('r := DWORD_TO_REAL(MD0); MD4 := REAL_TO_DWORD(r);');
  });
});

describe('sclToAwl 1.1: diagnostiche', () => {
  it('stringhe di bit, costanti, cicli', () => {
    expect(diag('w := w + 1;').message).toContain('WORD');
    expect(diag('x := w < 1;').message).toContain('solo = e <>');
    expect(diag('a := a AND 1;').message).toContain('AND');
    expect(diag('w := a;').message).toContain('INT_TO_WORD');
    expect(diag('a := ROUND(r);').message).toContain('DINT_TO_INT');
    expect(diag('a := r;').message).toContain('DINT_TO_INT(ROUND');
    expect(diag('bt := 256;').line).toBe(1);
    expect(diag('a := 2#102;').message).toContain('Costante non valida');
    expect(diag('a := INT#40000;').message).toContain('fuori intervallo');
    expect(diag('a := 1;\nEXIT;')).toMatchObject({
      line: 2,
      message: expect.stringContaining('EXIT'),
    });
    expect(diag('CONTINUE;').message).toContain('FOR, WHILE o REPEAT');
  });

  it('ARRAY e STRUCT', () => {
    expect(diag('a := v[a];').message).toContain('Indice variabile non supportato');
    expect(diag('a := v[6];').message).toContain('fuori da [1..5]');
    expect(diag('a := v;').message).toContain('non supportato');
    expect(diag('a := s.nessuno;').message).toContain('Membro sconosciuto');
    expect(diag('a := io.z;').message).toContain('IN_OUT');
    expect(diag('a := "Dati";').message).toContain('membro');
  });

  it('chiamate', () => {
    expect(diag('"Calcola"(A := 1);').message).toContain('Manca il parametro R');
    expect(diag('"Calcola"(A := 1, R := a);').message).toContain('=>');
    expect(diag('"Calcola"(A => a, R => a);').message).toContain(':=');
    expect(diag('"Calcola"(A := 1, R => a, Z := 1);').message).toContain('non ha il parametro Z');
    expect(diag('"Calcola"(A := 1.5, R => a);').message).toContain('Tipi diversi');
    expect(diag('"Calcola"(A := 1, R => d);').message).toContain('Tipi diversi');
    expect(diag('a := "Calcola"(A := 1, R => a);').message).toContain('non restituisce');
    expect(diag('"Nastro"(Vel := 1);').message).toContain('DB di istanza');
    expect(diag('"Nessuno"();').message).toContain('Blocco sconosciuto');
    expect(diag('"Calcola"(1);').message).toContain('per nome');
  });
});

// ---- esecuzione nel simulatore, con indirizzi assoluti ----

const abs = makeCtx('FC', emptyIface({ returnType: { kind: 'void' } }));
const run = (text: string, setup: (v: DataView) => void = () => undefined): DataView => {
  const out = sclToAwl(text, abs, 0);
  expect(out.diagnostics).toEqual([]);
  const r = runAwl([out.source], {
    setup: (mem) => setup(new DataView(mem.M.buffer, mem.M.byteOffset, mem.M.byteLength)),
  });
  return new DataView(r.mem.M.buffer, r.mem.M.byteOffset, r.mem.M.byteLength);
};

describe('sclToAwl 1.1: risultati nel simulatore', () => {
  it('logica a parola, NOT di un BYTE, costanti esadecimali', () => {
    const v = run(
      'MW10 := MW0 AND W#16#0FF0 OR 16#F000; MD12 := MD4 XOR DW#16#FFFF0000; MB16 := NOT MB2; M17.0 := NOT MB2 = 16#F0; M17.1 := MW0 <> W#16#1234; MD20 := NOT MD4;',
      (v) => {
        v.setUint16(0, 0x1234);
        v.setUint8(2, 0x0f);
        v.setUint32(4, 0x12345678);
      },
    );
    expect(v.getUint16(10)).toBe(0xf230);
    expect(v.getUint32(12)).toBe(0xedcb5678);
    expect(v.getUint8(16)).toBe(0xf0);
    expect(v.getUint8(17) & 3).toBe(1);
    expect(v.getUint32(20)).toBe(0xedcba987);
  });

  it('DINT_TO_INT tiene i 16 bit bassi (anche nei confronti); i passaggi a DWORD azzerano il resto', () => {
    for (const [d, want] of [
      [70000, 4464],
      [32767, 32767],
      [32768, -32768],
      [-32769, 32767],
      [-5, -5],
    ] as const) {
      const v = run('MW0 := DINT_TO_INT(MD4); M2.0 := DINT_TO_INT(MD4) < 0;', (v) =>
        v.setInt32(4, d),
      );
      expect(v.getInt16(0)).toBe(want);
      expect(v.getUint8(2) & 1).toBe(want < 0 ? 1 : 0);
    }
    const v = run(
      'MD10 := WORD_TO_DWORD(INT_TO_WORD(DINT_TO_INT(MD4))); MD14 := BYTE_TO_DWORD(WORD_TO_BYTE(DWORD_TO_WORD(MD4))); MW18 := BYTE_TO_WORD(MB7);',
      (v) => v.setUint32(4, 0x12348765),
    );
    expect(v.getUint32(10)).toBe(0x8765);
    expect(v.getUint32(14)).toBe(0x65);
    expect(v.getUint16(18)).toBe(0x65);
  });

  it('REAL verso INT con ROUND e TRUNC, anche oltre INT', () => {
    const v = run(
      'MW0 := DINT_TO_INT(ROUND(DWORD_TO_REAL(MD4))); MW2 := DINT_TO_INT(TRUNC(DWORD_TO_REAL(MD4))); MW8 := DINT_TO_INT(ROUND(DWORD_TO_REAL(MD12)));',
      (v) => {
        v.setFloat32(4, -2.6);
        v.setFloat32(12, 40000.4);
      },
    );
    expect(v.getInt16(0)).toBe(-3);
    expect(v.getInt16(2)).toBe(-2);
    expect(v.getInt16(8)).toBe(40000 - 65536);
  });

  it('EXIT esce solo dal ciclo interno; CONTINUE salta al passo dopo', () => {
    const v = run(
      'FOR MW0 := 1 TO 3 DO FOR MW2 := 1 TO 10 DO IF MW2 > 2 THEN EXIT; END_IF; MW4 := MW4 + 1; END_FOR; MW6 := MW6 + 1; END_FOR;' +
        'FOR MW8 := 1 TO 10 DO IF MW8 > 4 THEN CONTINUE; END_IF; MW10 := MW10 + 1; END_FOR;' +
        'WHILE TRUE DO MW12 := MW12 + 1; IF MW12 < 3 THEN CONTINUE; END_IF; EXIT; END_WHILE;' +
        'REPEAT MW14 := MW14 + 1; IF MW14 < 5 THEN CONTINUE; END_IF; MW16 := MW16 + 1; IF MW14 = 7 THEN EXIT; END_IF; UNTIL MW14 > 100 END_REPEAT; MW18 := 1;',
    );
    // l'EXIT interno lascia MW2 a 3 e non ferma il FOR esterno
    expect([v.getInt16(4), v.getInt16(6), v.getInt16(2)]).toEqual([6, 3, 3]);
    expect([v.getInt16(8), v.getInt16(10)]).toEqual([11, 4]);
    expect(v.getInt16(12)).toBe(3);
    expect([v.getInt16(14), v.getInt16(16), v.getInt16(18)]).toEqual([7, 3, 1]);
  });

  it('CONTINUE in REPEAT controlla la condizione', () => {
    const v = run('REPEAT MW0 := MW0 + 1; CONTINUE; MW2 := 1; UNTIL MW0 >= 4 END_REPEAT;');
    expect([v.getInt16(0), v.getInt16(2)]).toEqual([4, 0]);
  });

  it('CASE a intervalli: gli estremi sono compresi', () => {
    const t =
      'CASE MW0 OF -3..-1: MW10 := 3; 1..5: MW10 := 1; 6, 8..10: MW10 := 2; ELSE MW10 := 9; END_CASE;';
    for (const [sel, want] of [
      [-4, 9],
      [-3, 3],
      [-1, 3],
      [0, 9],
      [1, 1],
      [5, 1],
      [6, 2],
      [7, 9],
      [8, 2],
      [10, 2],
      [11, 9],
    ] as const)
      expect(run(t, (v) => v.setInt16(0, sel)).getInt16(10)).toBe(want);
    const d = 'CASE MD0 OF 70000..70002: MW10 := 1; ELSE MW10 := 2; END_CASE;';
    expect(run(d, (v) => v.setInt32(0, 70002)).getInt16(10)).toBe(1);
    expect(run(d, (v) => v.setInt32(0, 70003)).getInt16(10)).toBe(2);
  });
});
