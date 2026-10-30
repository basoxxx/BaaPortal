// Osservazione dei blocchi SCL: l'istruzione che porta il valore di ogni riga (`value` nelle
// righe di `sclToAwl`) e lo stato per riga SCL dalle celle dell'AWL generato (`sclLineStatus`).
import { describe, expect, it } from 'vitest';
import type { DataType } from '@baaportal/s7-types';
import { sclLineStatus, sclToAwl, type SclCell, type SclLine } from '../src/index.js';
import { el, emptyIface, m, makeCtx } from '../../awl/test/ctx.js';

const arr = (lo: number, hi: number, element: DataType): DataType => ({
  kind: 'array',
  dims: [{ lo, hi }],
  element,
});
const ctx = makeCtx(
  'FB',
  emptyIface({
    input: [m('i', el('Int'))],
    static: [
      m('a', el('Int')),
      m('d', el('DInt')),
      m('r', el('Real')),
      m('x', el('Bool')),
      m('y', el('Bool')),
      m('w', el('Word')),
      m('bt', el('Byte')),
      m('v', arr(1, 5, el('Int'))),
      m('sub', { kind: 'named', name: 'Nastro' }),
    ],
  }),
);

/** Programmi che toccano ogni forma di istruzione: il loro AWL non deve cambiare. */
const CORPUS = [
  'a := 1;\nd := INT_TO_DINT(a) * 70000;\nr := DINT_TO_REAL(d) / 2.5;\nx := a > 3 AND NOT y;',
  'w := w AND 16#FF00 OR W#16#1;\nbt := NOT bt;\nx := (a = 1 OR y) XOR x;',
  'IF a < 10 THEN\n  a := 1;\nELSIF a < 20 THEN\n  a := 2;\nELSE\n  a := 3;\nEND_IF;',
  'CASE a OF\n  1, 2: d := 10;\n  3..5: d := 20;\nELSE\n  d := 30;\nEND_CASE;',
  'CASE a + 1 OF\n  1: x := TRUE;\nEND_CASE;',
  'FOR a := 1 TO 10 DO\n  d := d + 1;\n  IF d > 100 THEN EXIT; END_IF;\nEND_FOR;',
  'FOR d := 10 TO INT_TO_DINT(i) BY -2 DO\n  CONTINUE;\nEND_FOR;',
  'WHILE a < 5 DO\n  a := a + 1;\nEND_WHILE;',
  'REPEAT\n  a := a - 1;\n  IF a = 3 THEN CONTINUE; END_IF;\nUNTIL a <= 0\nEND_REPEAT;',
  'v[a] := v[i] + 1;\nx := v[a] > 2;',
  '"Calcola"(A := a + 1, R => a);\na := ConRet(X := r) + 1;\n#sub(Vel := a);\nRETURN;',
];

describe('sclToAwl: `value` non cambia l’AWL', () => {
  it.each(CORPUS.map((t, k) => [k, t] as const))('programma %i', (_k, text) => {
    const out = sclToAwl(text, ctx, 2);
    expect(out.diagnostics).toEqual([]);
    expect({
      source: out.source,
      lines: out.lines.map((l) => [l.line, l.sclLine]),
    }).toMatchSnapshot();
  });
});

/** Celle per riga AWL: `absent` = fuori dalla finestra (nessuna cella). */
function statusOf(
  text: string,
  cell: (l: SclLine, awl: string) => SclCell | 'absent',
  opts: { nullUnknown?: boolean } = {},
) {
  const out = sclToAwl(text, ctx, 2);
  expect(out.diagnostics).toEqual([]);
  const src = out.source.split('\n');
  const cells = new Map<number, SclCell>();
  for (const l of out.lines) {
    const c = cell(l, src[l.line]!.trim());
    if (c !== 'absent') cells.set(l.line, c);
  }
  return sclLineStatus(out.lines, cells, opts);
}
/** Riga eseguita; per difetto ACCU1 = 99 e RLO = 0, così si vede quale riga ha dato il valore. */
const ran = (rlo = false, accu1 = 99) => ({ rlo, accu1 });

describe('sclLineStatus', () => {
  it('assegnazioni: il valore solo dalla T o dalla = della riga', () => {
    const st = statusOf('a := 5;\nr := 1.5;\nx := a > 3;', (_l, awl) =>
      awl === 'T #a;'
        ? ran(false, 5)
        : awl === 'T #r;'
          ? ran(false, 0x3fc00000)
          : awl === '= #x;'
            ? ran(true)
            : ran(),
    );
    expect(st.get(1)).toEqual({ state: 'run', values: [{ ty: 'INT', cell: ran(false, 5) }] });
    expect(st.get(2)).toEqual({
      state: 'run',
      values: [{ ty: 'REAL', cell: ran(false, 0x3fc00000) }],
    });
    expect(st.get(3)).toEqual({ state: 'run', values: [{ ty: 'BOOL', cell: ran(true) }] });
  });

  it('IF: condizione vera e falsa dall’istruzione prima del salto; ramo non eseguito', () => {
    const text = 'IF a < 10 THEN\n  a := 1;\nELSE\n  a := 2;\nEND_IF;';
    // condizione falsa: la JCN rimette RLO a 1, ma conta il <I
    const st = statusOf(text, (l, awl) =>
      awl.startsWith('JCN') ? ran(true) : l.sclLine === 2 ? null : ran(false),
    );
    expect(st.get(1)).toEqual({ state: 'run', values: [{ ty: 'BOOL', cell: ran(false) }] });
    expect(st.get(2)).toEqual({ state: 'notRun', values: [{ ty: 'INT', cell: null }] });
    expect(st.get(4)!.state).toBe('run');
    const yes = statusOf(text, (l) => (l.sclLine === 4 ? null : ran(true)));
    expect(yes.get(1)!.values[0]!.cell).toEqual(ran(true));
    expect(yes.get(4)!.state).toBe('notRun');
  });

  it('CASE: il selettore, semplice o calcolato', () => {
    const text = 'CASE a OF\n  1: d := 10;\nEND_CASE;';
    const st = statusOf(text, (_l, awl) => (awl === 'L #a;' ? ran(false, 1) : ran()));
    expect(st.get(1)!.values).toEqual([{ ty: 'INT', cell: ran(false, 1) }]);
    const calc = statusOf('CASE a + 1 OF\n  1: d := 10;\nEND_CASE;', (_l, awl) =>
      awl === 'T %LW2;' ? ran(false, 4) : ran(),
    );
    expect(calc.get(1)!.values).toEqual([{ ty: 'INT', cell: ran(false, 4) }]);
  });

  it('FOR: la variabile al controllo in cima al ciclo', () => {
    let seen = 0;
    const st = statusOf('FOR d := 1 TO 10 DO\n  a := 0;\nEND_FOR;', (_l, awl) =>
      awl === 'L #d;' && seen++ === 0 ? ran(false, 11) : ran(),
    );
    expect(st.get(1)!.values).toEqual([{ ty: 'DINT', cell: ran(false, 11) }]);
  });

  it('WHILE non eseguito: condizione falsa, corpo grigio', () => {
    const st = statusOf('WHILE a < 5 DO\n  a := a + 1;\nEND_WHILE;', (l) =>
      l.sclLine === 2 ? null : ran(false),
    );
    expect(st.get(1)).toEqual({ state: 'run', values: [{ ty: 'BOOL', cell: ran(false) }] });
    expect(st.get(2)!.state).toBe('notRun');
  });

  it('finestra tagliata: senza la cella dell’istruzione che decide, sconosciuto', () => {
    // il calcolo c'è, la T è fuori finestra: nessun valore inventato
    const st = statusOf('a := i + 1;', (_l, awl) => (awl === 'T #a;' ? 'absent' : ran(false, 7)));
    expect(st.get(1)).toEqual({ state: 'unknown', values: [{ ty: 'INT' }] });
  });

  it('null: non elaborato; con nullUnknown (risposta parziale, in attesa) sconosciuto', () => {
    expect(statusOf('a := 1;', () => null).get(1)!.state).toBe('notRun');
    const wait = statusOf('a := 1;', () => null, { nullUnknown: true });
    expect(wait.get(1)).toEqual({ state: 'unknown', values: [{ ty: 'INT' }] });
  });

  it('righe senza valore (chiamate, etichette di CASE): decide la prima istruzione', () => {
    const text = 'CASE a OF\n  1:\n    "Calcola"(A := a, R => a);\nEND_CASE;';
    const st = statusOf(text, (_l, awl) => (awl.startsWith('_') ? null : ran()));
    expect(st.get(2)).toEqual({ state: 'notRun', values: [] });
    expect(st.get(3)).toEqual({ state: 'run', values: [] });
    const out = statusOf(text, (l) => (l.sclLine === 3 ? 'absent' : ran()));
    expect(out.get(3)).toEqual({ state: 'unknown', values: [] });
  });
});
