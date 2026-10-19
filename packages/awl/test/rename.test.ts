import { describe, expect, it } from 'vitest';
import { renameInSource, type RenameTarget } from '../src';

const ren = (
  src: string,
  t: RenameTarget,
  to: string,
  m: 'international' | 'german' = 'international',
) => renameInSource(src, t, to, m);

describe('renameInSource', () => {
  it('tocca solo i riferimenti giusti', () => {
    const src = 'A "Avvio" // "Avvio" nel commento\nA "Avvio1"\nL "Dati".Asse.Pos';
    expect(ren(src, { kind: 'symbol', oldName: 'avvio' }, 'Start')).toBe(
      'A "Start" // "Avvio" nel commento\nA "Avvio1"\nL "Dati".Asse.Pos',
    );
    expect(
      ren(
        src,
        { kind: 'member', root: 'symbol', rootName: 'Dati', path: ['Asse'], oldName: 'Pos' },
        'Posizione',
      ),
    ).toContain('"Dati".Asse.Posizione');
  });

  it('simboli: operandi, DB simbolico, CALL, istanza, parametri, blocchi', () => {
    const src = [
      'A "Avvio"',
      'L "Dati".DBW 4',
      'L "Dati".Asse.Pos',
      'OPN "Dati"',
      'UC "Dati"',
      'CALL "Dati", "Dati"',
      '(P := "Dati".x, Q := "Altro")',
      'A M [ "Dati".x ]',
    ].join('\n');
    expect(ren(src, { kind: 'symbol', oldName: 'DATI' }, 'Nuovo nome')).toBe(
      [
        'A "Avvio"',
        'L "Nuovo nome".DBW 4',
        'L "Nuovo nome".Asse.Pos',
        'OPN "Nuovo nome"',
        'UC "Nuovo nome"',
        'CALL "Nuovo nome", "Nuovo nome"',
        '(P := "Nuovo nome".x, Q := "Altro")',
        'A M [ "Nuovo nome".x ]',
      ].join('\n'),
    );
  });

  it('simboli con accenti e normalizzazione, commenti e stringhe intatti', () => {
    const src =
      'L "Velocità nastro" // "Velocità nastro"\r\nL \'"Velocità nastro"\'\r\nT "VELOCITÀ NASTRO"';
    expect(ren(src, { kind: 'symbol', oldName: 'velocità nastro' }, 'Vel')).toBe(
      'L "Vel" // "Velocità nastro"\r\nL \'"Velocità nastro"\'\r\nT "Vel"',
    );
  });

  it('nessuna corrispondenza: stringa identica', () => {
    const src = 'A "Avvio"\nA #x';
    expect(ren(src, { kind: 'symbol', oldName: 'Nulla' }, 'Y')).toBe(src);
    expect(ren(src, { kind: 'local', oldName: 'y' }, 'z')).toBe(src);
    expect(ren('XXX "a"', { kind: 'symbol', oldName: 'a' }, 'b')).toBe('XXX "a"');
  });

  it('locali: #x, #"a b", prima parte di un percorso', () => {
    const src = 'A #x\nL #"a b"\nL #X.y\nA "x"\nL #xx';
    expect(ren(src, { kind: 'local', oldName: 'x' }, 'nuovo')).toBe(
      'A #nuovo\nL #"a b"\nL #nuovo.y\nA "x"\nL #xx',
    );
    expect(ren(src, { kind: 'local', oldName: 'x' }, 'con spazio')).toBe(
      'A #"con spazio"\nL #"a b"\nL #"con spazio".y\nA "x"\nL #xx',
    );
    expect(ren(src, { kind: 'local', oldName: 'A B' }, 'ab')).toBe(
      'A #x\nL #ab\nL #X.y\nA "x"\nL #xx',
    );
    expect(ren('CALL "F" (p := #x)', { kind: 'local', oldName: 'x' }, 'y')).toBe(
      'CALL "F" (p := #y)',
    );
    expect(ren('CALL #x (p := 1)', { kind: 'local', oldName: 'x' }, 'y')).toBe('CALL #y (p := 1)');
  });

  it('membri: percorso esatto, radice qualsiasi, indici, quoting', () => {
    const src =
      'L "Dati".Asse.Pos\nL "Altro".Asse.Pos\nL "Dati".Pos\nL #a.Asse.Pos\nL "Dati".vet[2].Pos\nL "Dati".Asse.Pos2';
    const t = (
      root: 'symbol' | 'local',
      rootName: string | null,
      path: string[],
    ): RenameTarget => ({
      kind: 'member',
      root,
      rootName,
      path,
      oldName: 'pos',
    });
    expect(ren(src, t('symbol', 'Dati', ['Asse']), 'P')).toBe(
      'L "Dati".Asse.P\nL "Altro".Asse.Pos\nL "Dati".Pos\nL #a.Asse.Pos\nL "Dati".vet[2].Pos\nL "Dati".Asse.Pos2',
    );
    expect(ren(src, t('symbol', null, ['Asse']), 'P')).toBe(
      'L "Dati".Asse.P\nL "Altro".Asse.P\nL "Dati".Pos\nL #a.Asse.Pos\nL "Dati".vet[2].Pos\nL "Dati".Asse.Pos2',
    );
    expect(ren(src, t('local', 'a', ['Asse']), 'a b')).toBe(
      'L "Dati".Asse.Pos\nL "Altro".Asse.Pos\nL "Dati".Pos\nL #a.Asse."a b"\nL "Dati".vet[2].Pos\nL "Dati".Asse.Pos2',
    );
    expect(ren(src, t('symbol', 'Dati', ['vet']), 'Q')).toContain('L "Dati".vet[2].Q');
    expect(ren(src, t('symbol', 'Dati', []), 'Z')).toContain('L "Dati".Z\n');
  });

  it('parametri di CALL a quel blocco', () => {
    const src =
      'CALL "Nastro", "Nastro_DB"\n(Vel := #Vel, "Ok" => #Ok)\nCALL "Altro" (Vel := 1)\nL #Vel';
    expect(ren(src, { kind: 'callParam', block: 'nastro', oldName: 'vel' }, 'Velocita')).toBe(
      'CALL "Nastro", "Nastro_DB"\n(Velocita := #Vel, "Ok" => #Ok)\nCALL "Altro" (Vel := 1)\nL #Vel',
    );
    expect(ren(src, { kind: 'callParam', block: 'Nastro', oldName: 'ok' }, 'Fatto ok')).toContain(
      '"Fatto ok" => #Ok',
    );
    expect(ren(src, { kind: 'callParam', block: 'Nastro', oldName: 'ok' }, 'Fine')).toContain(
      'Fine => #Ok',
    );
  });

  it('mnemonici tedeschi e CRLF', () => {
    const src = 'U "Avvio"\r\nSPA M1\r\nM1: U E 0.0\r\n= "Avvio"';
    expect(ren(src, { kind: 'symbol', oldName: 'Avvio' }, 'S', 'german')).toBe(
      'U "S"\r\nSPA M1\r\nM1: U E 0.0\r\n= "S"',
    );
  });

  it('membro: gli indici di array non contano', () => {
    const src = 'L "Dati".Assi[3].Pos\nL "Dati".Assi[1,2].Pos';
    expect(
      ren(
        src,
        { kind: 'member', root: 'symbol', rootName: 'Dati', path: ['Assi'], oldName: 'Pos' },
        'Posizione',
      ),
    ).toBe('L "Dati".Assi[3].Posizione\nL "Dati".Assi[1,2].Posizione');
  });

  it('nuovo nome non valido: sorgente invariato', () => {
    const src = 'A "Avvio"';
    for (const bad of ['a"b', 'a\nb', 'a\rb', 'a\u0000b', 'a\u2028b']) {
      expect(ren(src, { kind: 'symbol', oldName: 'Avvio' }, bad)).toBe(src);
    }
  });

  it('callParam: anche CALL FB n, CALL FC n e CALL #istanza', () => {
    const src = [
      'CALL "Nastro", "Nastro_DB"\n(Vel := 1)',
      'CALL FB 2, DB 3\n(Vel := 2)',
      'CALL FC 2\n(Vel := 3)',
      'CALL #sub\n(Vel := 4)',
      'CALL #altra\n(Vel := 5)',
    ].join('\n');
    const out = ren(
      src,
      {
        kind: 'callParam',
        block: 'Nastro',
        oldName: 'Vel',
        number: { kind: 'FB', number: 2 },
        instances: ['SUB'],
      },
      'Velocita',
    );
    expect(out).toBe(
      [
        'CALL "Nastro", "Nastro_DB"\n(Velocita := 1)',
        'CALL FB 2, DB 3\n(Velocita := 2)',
        'CALL FC 2\n(Vel := 3)',
        'CALL #sub\n(Velocita := 4)',
        'CALL #altra\n(Vel := 5)',
      ].join('\n'),
    );
  });
});

describe('renameInSource: P##locale', () => {
  it('rinomina locale e membro di un locale dentro P##', () => {
    const src = 'L P##Tmp\nLAR1 P##"Tmp"\nL P##Tmp2\nL P##Sub.Vel\nL P#M0.0';
    expect(ren(src, { kind: 'local', oldName: 'tmp' }, 'Temp')).toBe(
      'L P##Temp\nLAR1 P##Temp\nL P##Tmp2\nL P##Sub.Vel\nL P#M0.0',
    );
    expect(
      ren(
        src,
        { kind: 'member', root: 'local', rootName: 'Sub', path: [], oldName: 'Vel' },
        'Velocita',
      ),
    ).toBe('L P##Tmp\nLAR1 P##"Tmp"\nL P##Tmp2\nL P##Sub.Velocita\nL P#M0.0');
    // Un simbolo globale con lo stesso nome non è un locale.
    expect(ren('L P##Tmp', { kind: 'symbol', oldName: 'Tmp' }, 'X')).toBe('L P##Tmp');
  });
});
