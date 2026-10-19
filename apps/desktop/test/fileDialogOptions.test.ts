import { describe, expect, it } from 'vitest';
import { parseOpenOptions, parseSaveOptions } from '../src/main/fileDialogOptions';

const awl = [{ name: 'Sorgenti AWL', extensions: ['awl', 'txt'] }];

describe('parseOpenOptions', () => {
  it('accetta filtri validi e multi opzionale', () => {
    expect(parseOpenOptions({ filters: awl })).toEqual({ filters: awl, multi: false });
    expect(parseOpenOptions({ filters: awl, multi: true }).multi).toBe(true);
  });
  it.each([
    null,
    'x',
    {},
    { filters: 'x' },
    { filters: [null] },
    { filters: [{ name: 1, extensions: ['awl'] }] },
    { filters: [{ name: 'a', extensions: 'awl' }] },
    { filters: [{ name: 'a', extensions: [1] }] },
    { filters: [{ name: 'a', extensions: ['.awl'] }] },
    { filters: [{ name: 'a', extensions: ['a/b'] }] },
    { filters: [{ name: 'a', extensions: ['a\\b'] }] },
    { filters: [{ name: 'a', extensions: [''] }] },
    { filters: awl, multi: 'si' },
    { filters: [{ name: 'a' }] },
  ])('rifiuta %j', (v) => {
    expect(() => parseOpenOptions(v)).toThrow();
  });

  const filter = (i: number) => ({ name: `F${i}`, extensions: ['awl'] });
  it('al più 20 filtri, 50 estensioni per filtro, testi di al più 255 caratteri', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => filter(i));
    expect(parseOpenOptions({ filters: twenty }).filters).toHaveLength(20);
    expect(() => parseOpenOptions({ filters: [...twenty, filter(20)] })).toThrow();
    const ext = (n: number) => Array.from({ length: n }, (_, i) => `e${i}`);
    expect(
      parseOpenOptions({ filters: [{ name: 'a', extensions: ext(50) }] }).filters,
    ).toHaveLength(1);
    expect(() => parseOpenOptions({ filters: [{ name: 'a', extensions: ext(51) }] })).toThrow();
    const long = 'x'.repeat(255);
    expect(
      parseOpenOptions({ filters: [{ name: long, extensions: [long] }] }).filters,
    ).toHaveLength(1);
    expect(() =>
      parseOpenOptions({ filters: [{ name: `${long}x`, extensions: ['awl'] }] }),
    ).toThrow();
    expect(() =>
      parseOpenOptions({ filters: [{ name: 'a', extensions: [`${long}x`] }] }),
    ).toThrow();
  });

  it('rifiuta NUL nel nome di un filtro', () => {
    expect(() =>
      parseOpenOptions({ filters: [{ name: 'a\u0000b', extensions: ['awl'] }] }),
    ).toThrow();
  });
});

describe('parseSaveOptions', () => {
  it('accetta un nome di file', () => {
    expect(parseSaveOptions({ defaultName: 'a.awl', filters: awl }).defaultName).toBe('a.awl');
  });
  it.each(['', '../a.awl', 'x/a.awl', 'x\\a.awl', 5, undefined, 'a\u0000.awl', 'x'.repeat(256)])(
    'rifiuta defaultName %j',
    (n) => {
      expect(() => parseSaveOptions({ defaultName: n, filters: awl })).toThrow();
    },
  );
  it('un nome di 255 caratteri va bene', () => {
    expect(
      parseSaveOptions({ defaultName: 'x'.repeat(255), filters: awl }).defaultName,
    ).toHaveLength(255);
  });
  it.each([
    { defaultName: 'a.awl', filters: 'x' },
    { defaultName: 'a.awl', filters: { name: 'a', extensions: ['awl'] } },
    { defaultName: 'a.awl' },
    { defaultName: 'a.awl', filters: [{ name: 'a' }] },
    { defaultName: 'a.awl', filters: Array.from({ length: 21 }, () => awl[0]) },
  ])('rifiuta i filtri di %j', (v) => {
    expect(() => parseSaveOptions(v)).toThrow();
  });
});
