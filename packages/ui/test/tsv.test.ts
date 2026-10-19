import { describe, expect, it } from 'vitest';
import { parseTsv, toTsv } from '../src/grid/tsv';

describe('toTsv', () => {
  it('unisce celle con tab e righe con \\r\\n, senza a capo finale', () => {
    expect(toTsv([['a', 'b'], ['c']])).toBe('a\tb\r\nc');
  });
  it('mette tra virgolette i campi con tab, a capo, CR o virgolette, raddoppiando le virgolette', () => {
    expect(toTsv([['x"y', 'a\tb', 'c\nd', 'e\rf', 'semplice']])).toBe(
      '"x""y"\t"a\tb"\t"c\nd"\t"e\rf"\tsemplice',
    );
  });
  it('nessuna riga: stringa vuota', () => {
    expect(toTsv([])).toBe('');
  });
});

describe('parseTsv', () => {
  it('\\r\\n, riga vuota finale, virgolette e tab', () => {
    expect(parseTsv('a\tb\r\n"c\td"\te\r\n')).toEqual([
      ['a', 'b'],
      ['c\td', 'e'],
    ]);
    expect(parseTsv(toTsv([['x"y', 'z\nw']]))).toEqual([['x"y', 'z\nw']]);
  });
  it('accetta anche \\n e conserva le celle vuote intermedie', () => {
    expect(parseTsv('a\t\tc\nd\te')).toEqual([
      ['a', '', 'c'],
      ['d', 'e'],
    ]);
  });
  it('ignora una sola riga vuota finale; il testo vuoto non dà righe', () => {
    expect(parseTsv('a\n\n')).toEqual([['a'], ['']]);
    expect(parseTsv('')).toEqual([]);
  });
  it('una virgoletta nel mezzo di un campo non quotato resta letterale', () => {
    expect(parseTsv('5" tubo\tb')).toEqual([['5" tubo', 'b']]);
  });
});
