// Editor SCL: evidenziazione, completamento e diagnostiche (funzioni pure).
import { Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { el, emptyIface, m, makeCtx } from '../../awl/test/ctx';
import {
  sclComplete,
  sclLintDiagnostics,
  sclProblems,
  sclSpans,
} from '../src/editors/scl/sclExtensions';

const kinds = (text: string) => sclSpans(text).map((s) => [text.slice(s.from, s.to), s.kind]);
const ctx = makeCtx();
/** Le etichette proposte con il cursore alla fine di `text`. */
const labels = (text: string) => sclComplete(text, text.length, ctx).options.map((o) => o.label);
const applied = (text: string, label: string) => {
  const r = sclComplete(text, text.length, ctx);
  const o = r.options.find((x) => x.label === label)!;
  return text.slice(0, r.from) + o.apply;
};

describe('SCL: evidenziazione', () => {
  it('parole chiave, tipi, operatori, costanti, commenti, locali e simboli', () => {
    expect(
      kinds(
        'IF #a > 16#FF THEN "Mot".x := INT_TO_DINT(W#16#1); END_IF; // c\n(* a\nb *) s := \'t\';',
      ),
    ).toEqual([
      ['IF', 'keyword'],
      ['#a', 'local'],
      ['>', 'operator'],
      ['16#FF', 'constant'],
      ['THEN', 'keyword'],
      ['"Mot"', 'symbol'],
      ['.', 'operator'],
      [':=', 'operator'],
      ['INT_TO_DINT', 'type'],
      ['(', 'operator'],
      ['W#16#1', 'constant'],
      [')', 'operator'],
      [';', 'operator'],
      ['END_IF', 'keyword'],
      [';', 'operator'],
      ['// c', 'comment'],
      ['(* a\nb *)', 'comment'],
      [':=', 'operator'],
      ["'t'", 'constant'],
      [';', 'operator'],
    ]);
  });

  it('durate e date come costanti', () => {
    expect(
      kinds(
        't := T#5s + TIME#1m; d := D#2024-01-01; x := TOD#12:00:00 + S5T#2s; z := DT#2024-01-01-12:00:00;',
      )
        .filter(([, k]) => k === 'constant')
        .map(([t]) => t),
    ).toEqual([
      'T#5s',
      'TIME#1m',
      'D#2024-01-01',
      'TOD#12:00:00',
      'S5T#2s',
      'DT#2024-01-01-12:00:00',
    ]);
  });

  it('TRUE e i parametri per nome di una chiamata', () => {
    expect(kinds('"Fc"(in := TRUE);').filter(([, k]) => k !== 'operator')).toEqual([
      ['"Fc"', 'symbol'],
      ['in', 'param'],
      ['TRUE', 'constant'],
    ]);
  });
});

describe('SCL: completamento', () => {
  it('variabili con e senza #, tag e DB, parole chiave', () => {
    expect(labels('#Con')).toEqual(['Contatore']);
    expect(labels('x := Con')).toContain('Contatore');
    expect(applied('x := Con', 'Contatore')).toBe('x := Contatore');
    expect(labels('x := "Av')).toContain('Avvio');
    expect(applied('x := "Av', 'Avvio')).toBe('x := "Avvio"');
    expect(labels('x := Dat')).toContain('Dati');
    expect(labels('EL')).toEqual(expect.arrayContaining(['ELSE', 'ELSIF']));
  });

  it('membri dopo "DB". e #s.', () => {
    expect(labels('x := "Dati".')).toEqual(['Asse', 'Cnt', 'Altro valore', 'Vet']);
    expect(labels('x := "Dati".Asse.')).toEqual(['Pos']);
    expect(labels('#Cplx.')).toEqual(['z']);
  });

  it('chiamate con i parametri', () => {
    expect(applied('Calc', 'Calcola(…)')).toBe('"Calcola"(A := , R => )');
    expect(applied('"Nastro_', 'Nastro_DB(…)')).toBe('"Nastro_DB"(Vel := , Buf := , Ok => )');
  });

  it('dentro le parentesi di una chiamata: i parametri non ancora dati', () => {
    expect(labels('"Calcola"(')).toEqual(expect.arrayContaining(['A', 'R']));
    expect(labels('"Calcola"(A := 1, ')).toContain('R');
    expect(labels('"Calcola"(A := 1, ')).not.toContain('A');
    expect(applied('"Calcola"(A := 1, ', 'R')).toBe('"Calcola"(A := 1, R => ');
    expect(applied('Calcola(', 'A')).toBe('Calcola(A := ');
    expect(labels('"Nastro_DB"(V')).toContain('Vel');
    expect(labels('#Sub(')).toEqual(expect.arrayContaining(['Vel', 'Buf', 'Ok']));
    expect(labels('"Calcola"(A := Con')).toContain('Contatore');
    expect(labels('"Calcola"(A := Con')).not.toContain('R');
    expect(labels('x := INT_TO_DINT(')).not.toContain('A');
  });

  it('membri dopo un indice variabile', () => {
    const c = makeCtx(
      'FB',
      emptyIface({
        static: [
          m('a', {
            kind: 'array',
            dims: [{ lo: 1, hi: 3 }],
            element: { kind: 'struct', members: [m('x', el('Int'))] },
          }),
        ],
      }),
    );
    const at = (text: string) => sclComplete(text, text.length, c);
    expect(at('#a[#i].').options.map((o) => o.label)).toEqual(['x']);
    expect(at('y := #a[#b[#i] + 1].').options.map((o) => o.label)).toEqual(['x']);
    const r = at('#a[#i + 1].x');
    expect(r.from).toBe('#a[#i + 1].'.length);
  });

  it('niente nei commenti e nelle stringhe', () => {
    expect(labels('// #Con')).toEqual([]);
    expect(labels("x := '#Con")).toEqual([]);
    expect(labels('(* #Con')).toEqual([]);
  });
});

describe('SCL: diagnostiche', () => {
  it('il controllo AWL anche quando il traduttore ha errori altrove', () => {
    const small = makeCtx('FB', undefined, {
      timers: 16,
      counters: 16,
      mBytes: 16,
      inputBytes: 16,
      outputBytes: 16,
    });
    const text = '#Contatore := #nessuno;\nMW100 := 1;\n#Pos := 1.0;';
    const ps = sclProblems(text, small, 0, (d) => d.message);
    expect(ps.map((p) => p.line)).toEqual([1, 2]);
    expect(ps[1]!.col).toBe(1);
    // sulla riga con l'errore del traduttore non si aggiunge altro
    const same = sclProblems('MW100 := #nessuno;', small, 0, (d) => d.message);
    expect(same).toHaveLength(1);
  });

  it('tutti gli errori, sottolineati dalla colonna alla fine della parola', () => {
    const text = '#Contatore := #nessuno;\n#Pos := 1.0\n#Tmp := W#16#1;';
    const ps = sclProblems(text, ctx, 0, () => '');
    expect(ps.map((p) => p.line)).toEqual([1, 2]);
    const doc = Text.of(text.split('\n'));
    const [a, b] = sclLintDiagnostics(doc, ps);
    expect(text.slice(a!.from, a!.to)).toBe('#nessuno');
    expect(b!.from).toBe(doc.line(2).to);
  });
});
