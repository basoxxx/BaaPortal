// Errori multipli: il parser e la traduzione riportano tutti gli errori che trovano, ognuno alla
// sua riga, ripartendo dopo il `;` o dalla fine del costrutto.
import { describe, expect, it } from 'vitest';
import { MAX_ERRORS, sclToAwl } from '../src/index.js';
import { el, emptyIface, m, makeCtx } from '../../awl/test/ctx.js';

const ctx = makeCtx(
  'FB',
  emptyIface({ static: [m('a', el('Int')), m('b', el('Int')), m('x', el('Bool'))] }),
);
const diags = (text: string) => sclToAwl(text, ctx, 0).diagnostics;
const lines = (text: string) => diags(text).map((d) => d.line);

describe('sclToAwl: errori multipli', () => {
  it('un errore per istruzione, in ordine', () => {
    expect(lines('a := ;\nb := 1;\nb := (2 + ;\na := z;')).toEqual([1, 3, 4]);
  });

  it('il ; mancante va sulla riga dove manca e non nasconde la riga dopo', () => {
    const d = diags('a := 1\nb := zz;');
    expect(d[0]).toMatchObject({ line: 1, col: 7, message: 'Manca «;» dopo «1»' });
    expect(d[1]).toMatchObject({ line: 2, message: 'Operando sconosciuto: zz' });
    expect(d).toHaveLength(2);
  });

  it('dentro i costrutti: corpo letto anche con intestazione sbagliata', () => {
    const text = [
      'IF a + THEN',
      '  b := q1;',
      'ELSIF x THEN',
      '  b := ;',
      'END_IF;',
      'WHILE DO',
      '  a := q2;',
      'END_WHILE;',
      'FOR a := 1 TO DO',
      '  EXIT;',
      'END_FOR;',
      'CASE a OF',
      '  1: b := q3;',
      '  x: b := 1;',
      'END_CASE;',
    ].join('\n');
    expect(lines(text)).toEqual([1, 2, 4, 6, 7, 9, 13, 14]);
  });

  it('errori del lexer e della traduzione insieme, senza doppioni', () => {
    const d = diags('a := 2#12;\nb := @;\nx := 1;');
    expect(d.map((e) => [e.line, e.message])).toEqual([
      [1, 'Costante non valida: 2#12'],
      [2, 'Carattere non valido: @'],
      [3, "Tipi diversi: serve BOOL, c'è INT"],
    ]);
  });

  it(`al massimo ${MAX_ERRORS} errori`, () => {
    expect(diags('a := ;\n'.repeat(80))).toHaveLength(MAX_ERRORS);
  });

  it('END_IF senza IF non blocca il parser', () => {
    expect(lines('END_IF;\na := q;')).toEqual([1, 2]);
  });
});
