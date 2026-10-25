import { describe, expect, it } from 'vitest';
import { lex } from '../src';

const kinds = (s: string) => lex(s).map((t) => [t.kind, t.text]);

describe('lexer', () => {
  it('riconosce etichetta, parole, numeri e commento', () => {
    expect(kinds('M001: A I 0.0 // avvio')).toEqual([
      ['label', 'M001:'],
      ['word', 'A'],
      ['word', 'I'],
      ['number', '0.0'],
      ['comment', '// avvio'],
    ]);
  });

  it("un'etichetta può iniziare con _ (etichette automatiche del KOP)", () => {
    expect(kinds('_001: NOP 0')).toEqual([
      ['label', '_001:'],
      ['word', 'NOP'],
      ['number', '0'],
    ]);
  });

  it('le costanti solo AWL sono un unico token literal', () => {
    for (const c of [
      'B#16#FF',
      'W#16#FFFF',
      'DW#16#FFFF_FFFF',
      '2#1010',
      'L#-5',
      'C#123',
      'S5T#1S_500MS',
      "'ABCD'",
      'B#(1,2,3,4)',
      'P#M 0.0',
      'P#DB10.DBX 0.0 BYTE 10',
      'P#2.0',
      'T#1H_2M',
    ]) {
      expect(kinds(`L ${c}`)).toEqual([
        ['word', 'L'],
        ['literal', c],
      ]);
    }
    expect(kinds('L 1.5e+002')).toEqual([
      ['word', 'L'],
      ['number', '1.5e+002'],
    ]);
  });

  it('simboli, locali e stringhe non chiuse', () => {
    expect(kinds('A "DB".a.b[1] = #"nome x"')).toEqual([
      ['word', 'A'],
      ['symbol', '"DB"'],
      ['punct', '.'],
      ['word', 'a'],
      ['punct', '.'],
      ['word', 'b'],
      ['punct', '['],
      ['number', '1'],
      ['punct', ']'],
      ['punct', '='],
      ['local', '#"nome x"'],
    ]);
    expect(kinds('A "aperto')).toEqual([
      ['word', 'A'],
      ['unknown', '"aperto'],
    ]);
  });

  it('posizioni esatte con LF e CRLF', () => {
    const src = 'A I0.0\r\n  = Q0.0\nBE';
    for (const t of lex(src)) {
      expect(src.slice(t.range.from.offset, t.range.to.offset)).toBe(t.text);
    }
    const eq = lex(src).find((t) => t.text === '=')!;
    expect(eq.range.from).toEqual({ line: 1, col: 2, offset: 10 });
    const be = lex(src).find((t) => t.text === 'BE')!;
    expect(be.range.from).toEqual({ line: 2, col: 0, offset: 17 });
    expect(lex(src).filter((t) => t.kind === 'newline')).toHaveLength(2);
  });

  it('non lancia mai su input casuale', () => {
    const alphabet = 'AIQM0123456789.#"\'%[]()=<>+-*/:;,_ \t\r\nPBWDLCTE//';
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let n = 0; n < 300; n++) {
      let s = '';
      for (let k = rnd() * 60; k > 0; k--) s += alphabet[Math.floor(rnd() * alphabet.length)];
      for (const t of lex(s)) expect(s.slice(t.range.from.offset, t.range.to.offset)).toBe(t.text);
    }
  });
});
