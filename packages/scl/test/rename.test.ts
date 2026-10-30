// Rinomina nel testo SCL: nomi che non sono identificatori e locali con il nome di un blocco.
import { describe, expect, it } from 'vitest';
import { renameInScl, renumberInScl, sclRenameSkipped } from '../src/index.js';

describe('renameInScl', () => {
  it('una variabile con un nome non identificatore: il testo resta com è e lo si segnala', () => {
    const src = '#A := A + 1;';
    for (const name of ['Motor Speed', 'Velocità']) {
      const target = { kind: 'local', oldName: 'A' } as const;
      expect(renameInScl(src, target, name)).toBe(src);
      expect(sclRenameSkipped(src, target, name)).toBe(true);
    }
    expect(sclRenameSkipped(src, { kind: 'local', oldName: 'B' }, 'Motor Speed')).toBe(false);
    expect(sclRenameSkipped(src, { kind: 'local', oldName: 'A' }, 'Velocita')).toBe(false);
  });

  it('un parametro con un nome non identificatore: la chiamata resta com è', () => {
    const src = '"Calcola"(A := 1);';
    const target = { kind: 'callParam', block: 'Calcola', oldName: 'A' } as const;
    expect(renameInScl(src, target, 'Motor Speed')).toBe(src);
    expect(sclRenameSkipped(src, target, 'Motor Speed')).toBe(true);
  });

  it('un membro si scrive fra virgolette', () => {
    const src = '#s.A := "Dati".A;';
    expect(
      renameInScl(
        src,
        { kind: 'member', root: 'symbol', rootName: 'Dati', path: [], oldName: 'A' },
        'Motor Speed',
      ),
    ).toBe('#s.A := "Dati"."Motor Speed";');
  });

  it('un locale con il nome di una FC: `Calcola(` resta la chiamata del blocco', () => {
    const src = 'Calcola(A := 1);\n#Calcola := Calcola + 1;';
    expect(renameInScl(src, { kind: 'local', oldName: 'Calcola' }, 'X')).toBe(
      'Calcola(A := 1);\n#X := X + 1;',
    );
    expect(renameInScl(src, { kind: 'symbol', oldName: 'Calcola' }, 'Calc')).toBe(
      'Calc(A := 1);\n#Calcola := Calcola + 1;',
    );
  });
});

describe('renumberInScl', () => {
  it('riscrive le chiamate e gli accessi ai DB, non le variabili locali con nomi come DI1, DB1, FC1', () => {
    const map: Record<string, number> = { DB1: 7, DB5: 6, FC1: 2, FB1: 9 };
    const to = (f: string, n: number) => map[`${f}${n}`];
    const src =
      'IF DI1 THEN x := DB1; END_IF;\nFC1 := FB1;\nFC1(a := 1);\nFB1();\nDB1(a := 1);\n#y := DB5.DW0;';
    expect(renumberInScl(src, to).source).toBe(
      'IF DI1 THEN x := DB1; END_IF;\nFC1 := FB1;\nFC2(a := 1);\nFB9();\nDB7(a := 1);\n#y := DB6.DW0;',
    );
  });
});
