import { describe, expect, it } from 'vitest';
import { AWL_CODES, type AwlDiagnostic } from '@baaportal/awl';
import en from '../src/i18n/en.json';
import it_ from '../src/i18n/it.json';
import { awlSpans, toLintDiagnostics } from '../src/editors/awl/awlExtensions';

const kinds = (text: string) => awlSpans(text).map((s) => [text.slice(s.from, s.to), s.kind]);

describe('evidenziazione AWL', () => {
  it('decorazioni per tipo di token', () => {
    expect(kinds('A "Avvio" // x')).toEqual([
      ['A', 'instruction'],
      ['"Avvio"', 'symbol'],
      ['// x', 'comment'],
    ]);
  });

  it('indirizzi, locali, costanti ed etichette', () => {
    expect(kinds('m1: U E 0.0\nL 5\nL T#5S\nT #tmp')).toEqual([
      ['m1:', 'label'],
      ['U', 'instruction'],
      ['E', 'address'],
      ['0.0', 'address'],
      ['L', 'instruction'],
      ['5', 'constant'],
      ['L', 'instruction'],
      ['T#5S', 'constant'],
      ['T', 'instruction'],
      ['#tmp', 'local'],
    ]);
  });

  it('i parametri di CALL: il valore dopo := è una costante o un indirizzo', () => {
    expect(kinds('CALL FC1(a:=5, b:=#x)')).toEqual([
      ['CALL', 'instruction'],
      ['FC1', 'address'],
      ['a', 'param'],
      ['5', 'constant'],
      ['b', 'param'],
      ['#x', 'local'],
    ]);
  });
});

describe('diagnostiche come intervalli di CodeMirror', () => {
  const diag = (from: number, to: number): AwlDiagnostic => ({
    severity: 'error',
    code: 'SYNTAX',
    network: 0,
    range: {
      from: { line: 0, col: from, offset: from },
      to: { line: 0, col: to, offset: to },
    },
  });
  it('limita gli intervalli al documento e non lascia intervalli vuoti', () => {
    const out = toLintDiagnostics([diag(2, 2), diag(5, 99), diag(40, 50)], 10, () => 'm');
    expect(out.map((d) => [d.from, d.to])).toEqual([
      [2, 3],
      [5, 10],
      [10, 10],
    ]);
    expect(out[0]).toMatchObject({ severity: 'error', message: 'm', source: 'SYNTAX' });
  });
});

describe('messaggi delle diagnostiche', () => {
  it('ogni codice ha un messaggio in italiano e in inglese', () => {
    const lookup = (o: unknown, code: string) =>
      (o as { awl: { diag: Record<string, string> } }).awl.diag[code];
    for (const code of AWL_CODES) {
      expect(lookup(it_, code), `it ${code}`).toBeTruthy();
      expect(lookup(en, code), `en ${code}`).toBeTruthy();
    }
    const diag = (o: unknown) => Object.keys((o as { awl: { diag: object } }).awl.diag).sort();
    expect(diag(it_)).toEqual([...AWL_CODES].sort());
    expect(diag(en)).toEqual([...AWL_CODES].sort());
  });
});
