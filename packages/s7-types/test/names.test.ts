import { describe, expect, it } from 'vitest';
import { incrementName, sameName, validateS7Name } from '../src';

describe('nomi', () => {
  it.each([
    ['', 'EMPTY'],
    [' a', 'LEADING_TRAILING_SPACE'],
    ['a ', 'LEADING_TRAILING_SPACE'],
    ['a"b', 'INVALID_CHARS'],
    ['a\tb', 'INVALID_CHARS'],
    ['x'.repeat(129), 'TOO_LONG'],
  ])('validateS7Name(%j) → %s', (n, reason) => {
    expect(validateS7Name(n)).toEqual({ ok: false, reason });
  });
  it('accetta spazi interni, accenti e simboli', () => {
    for (const n of ['Motore 1', 'Velocità nastro', 'Nastro#2', 'Valvola-A', 'x'.repeat(128)])
      expect(validateS7Name(n)).toEqual({ ok: true });
  });
  it.each([
    ['Motore', 'Motore_1'],
    ['Motore_1', 'Motore_2'],
    ['Tag_9', 'Tag_10'],
    ['A_01', 'A_02'],
  ])('incrementName(%s) → %s', (a, b) => {
    expect(incrementName(a)).toBe(b);
  });
  it('sameName non distingue maiuscole, anche accentate', () => {
    expect(sameName('Motore', 'MOTORE')).toBe(true);
    expect(sameName('Velocità', 'VELOCITÀ')).toBe(true);
    expect(sameName('Motore', 'Motore1')).toBe(false);
  });
});
