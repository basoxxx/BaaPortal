import { Text } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { awlDecorations, awlSpans } from '../src/editors/awl/awlExtensions';
import { sourceDecorations, sourceSpans } from '../src/editors/source/sourceExtensions';

const kinds = (text: string) => awlSpans(text).map((s) => [text.slice(s.from, s.to), s.kind]);

/** Le decorazioni come [da, a, classe]. */
function marks(set: DecorationSet): [number, number, string][] {
  const out: [number, number, string][] = [];
  const it = set.iter();
  while (it.value) {
    out.push([it.from, it.to, String(it.value.spec.class)]);
    it.next();
  }
  return out;
}

describe('evidenziazione: istruzioni scritte con simboli e parametri di CALL', () => {
  it('= e le altre istruzioni con simboli sono istruzioni', () => {
    expect(kinds('= #Marcia\n==I\n+I\n)\nA(\n<>R\n+AR1 P#2.0\n+ 5')).toEqual([
      ['=', 'instruction'],
      ['#Marcia', 'local'],
      ['==I', 'instruction'],
      ['+I', 'instruction'],
      [')', 'instruction'],
      ['A(', 'instruction'],
      ['<>R', 'instruction'],
      ['+AR1', 'instruction'],
      ['P#2.0', 'constant'],
      ['+', 'instruction'],
      ['5', 'constant'],
    ]);
  });

  it('mnemonico tedesco ed etichette', () => {
    expect(kinds('M1: U E 0.0\n= A 4.0')).toEqual([
      ['M1:', 'label'],
      ['U', 'instruction'],
      ['E', 'address'],
      ['0.0', 'address'],
      ['=', 'instruction'],
      ['A', 'address'],
      ['4.0', 'address'],
    ]);
  });

  it('i nomi dei parametri di CALL hanno un tipo loro, su una o più righe', () => {
    expect(kinds('CALL FC1(a:=5, b:=#x)')).toEqual([
      ['CALL', 'instruction'],
      ['FC1', 'address'],
      ['a', 'param'],
      ['5', 'constant'],
      ['b', 'param'],
      ['#x', 'local'],
    ]);
    const multi = kinds('CALL "Nastro"\n(\n   Avvio := TRUE,\n   "Fine x" => #F\n)');
    expect(multi.filter(([, k]) => k === 'param')).toEqual([
      ['Avvio', 'param'],
      ['"Fine x"', 'param'],
    ]);
    expect(multi.filter(([, k]) => k === 'instruction')).toEqual([['CALL', 'instruction']]);
    // La ')' che chiude un elenco di parametri non è l'istruzione ')'; quella dopo A( sì.
    expect(kinds('CALL FC1\n(\n  a := 1\n);\nA(\nO M0.0\n)').filter(([t]) => t === ')')).toEqual([
      [')', 'instruction'],
    ]);
  });

  it('nella sorgente il tipo prima di := non è un parametro', () => {
    const text = 'VAR\n  Velocita : Int := 100;\nEND_VAR';
    const spans = sourceSpans(text).map((s) => [text.slice(s.from, s.to), s.kind]);
    expect(spans).toContainEqual(['Int', 'address']);
    expect(spans.some(([, k]) => k === 'param')).toBe(false);
  });
});

describe('evidenziazione: solo le righe visibili', () => {
  const source = (lines: number) => {
    const unit = [
      'FUNCTION_BLOCK "Nastro"',
      'VAR_INPUT',
      '  Avvio : Bool; // ingresso',
      'END_VAR',
      'BEGIN',
      'NETWORK',
      'TITLE = Marcia',
      '\tA #Avvio;',
      '\tCALL "Somma"',
      '\t(  A := #Velocita,',
      '\t   RET_VAL => #Velocita',
      '\t);',
      '\t= %Q0.0;',
      'END_FUNCTION_BLOCK',
    ];
    const out: string[] = [];
    while (out.length < lines) out.push(...unit);
    return out.slice(0, lines);
  };

  it('le decorazioni di un intervallo sono quelle del testo intero in quelle righe', () => {
    const lines = source(200);
    const doc = Text.of(lines);
    const text = doc.toString();
    const from = doc.line(41).from + 3;
    const to = doc.line(80).from + 5;
    const lineFrom = doc.line(41).from;
    const lineTo = doc.line(80).to;
    const whole = sourceSpans(text)
      .filter((s) => s.from >= lineFrom && s.to <= lineTo && s.to > s.from)
      .map((s): [number, number, string] => [s.from, s.to, `baa-awl-${s.kind}`]);
    expect(marks(sourceDecorations(doc, [{ from, to }]))).toEqual(whole);
    // Due intervalli che si toccano non duplicano nulla.
    const two = marks(
      sourceDecorations(doc, [
        { from, to: doc.line(60).from },
        { from: doc.line(60).from, to },
      ]),
    );
    expect(two).toEqual(whole);
    const awlWhole = awlSpans(text)
      .filter((s) => s.from >= lineFrom && s.to <= lineTo && s.to > s.from)
      .map((s): [number, number, string] => [s.from, s.to, `baa-awl-${s.kind}`]);
    expect(marks(awlDecorations(doc, [{ from, to }]))).toEqual(awlWhole);
  });

  it(
    'una sorgente di 50 000 righe: le decorazioni della parte visibile in meno di 2 s',
    { timeout: 30_000 },
    () => {
      const doc = Text.of(source(50_000));
      expect(doc.lines).toBe(50_000);
      const from = doc.line(25_000).from;
      const to = doc.line(25_060).to;
      const t0 = performance.now();
      const set = sourceDecorations(doc, [{ from, to }]);
      const ms = performance.now() - t0;
      expect(marks(set).length).toBeGreaterThan(50);
      // Obiettivo 200 ms; la soglia è larga per i runner della CI.
      expect(ms).toBeLessThan(2000);
    },
  );

  it(
    'il calcolo sul testo intero resta lineare: 50 000 righe in meno di 2 s',
    { timeout: 30_000 },
    () => {
      const text = source(50_000).join('\n');
      const t0 = performance.now();
      const spans = sourceSpans(text);
      const ms = performance.now() - t0;
      expect(spans.length).toBeGreaterThan(50_000);
      expect(ms).toBeLessThan(2000);
    },
  );
});
