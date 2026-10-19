import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { convertMnemonics, parseNetwork, type Mnemonic } from '../src';

const fixtures = readdirSync(new URL('./fixtures', import.meta.url))
  .filter((f) => f.endsWith('.awl'))
  .map((f) => [
    f,
    readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'),
    f.startsWith('german') ? 'german' : 'international',
  ]) as [string, string, Mnemonic][];

describe('convertMnemonics', () => {
  it('converte istruzioni, aree e condizioni di stato', () => {
    expect(
      convertMnemonics(
        'A I0.0\nA Q 0.1\nSD T 1\nA BR\nL PIW 256\nA C 3',
        'international',
        'german',
      ),
    ).toBe('U E0.0\nU A 0.1\nSE T 1\nU BIE\nL PEW 256\nU Z 3');
  });

  it('ritorno al mnemonico internazionale e posizione degli operandi', () => {
    expect(convertMnemonics('U E 0.0\nSE T 1\nL AW 4\nZV Z 2', 'german', 'international')).toBe(
      'A I 0.0\nSD T 1\nL QW 4\nCU C 2',
    );
  });

  it('commenti, stringhe, simboli e locali restano intatti; % e maiuscole conservati', () => {
    const s = '"U" // U E0.0\nU %E0.0 // A\n= #A\nu "E" ';
    expect(convertMnemonics(s, 'german', 'international')).toBe(
      '"U" // U E0.0\nA %I0.0 // A\n= #A\na "E" ',
    );
  });

  it('token sconosciuti e righe con errori non si toccano', () => {
    expect(convertMnemonics('XYZ E0.0\nU E0.0 qq', 'german', 'international')).toBe(
      'XYZ E0.0\nA I0.0 qq',
    );
  });

  it('stessa lingua: testo invariato', () => {
    expect(convertMnemonics('A I0.0', 'international', 'international')).toBe('A I0.0');
  });

  it.each(fixtures)('fixture %s: andata e ritorno identici', (_n, src, m) => {
    const other: Mnemonic = m === 'german' ? 'international' : 'german';
    const there = convertMnemonics(src, m, other);
    expect(parseNetwork(there, other).errors).toEqual([]);
    expect(convertMnemonics(there, other, m)).toBe(src);
    if (m === 'international') expect(there).not.toBe(src);
  });
});
