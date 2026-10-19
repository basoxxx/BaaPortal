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
  ])('rifiuta %j', (v) => {
    expect(() => parseOpenOptions(v)).toThrow();
  });
});

describe('parseSaveOptions', () => {
  it('accetta un nome di file', () => {
    expect(parseSaveOptions({ defaultName: 'a.awl', filters: awl }).defaultName).toBe('a.awl');
  });
  it.each(['', '../a.awl', 'x/a.awl', 'x\\a.awl', 5, undefined])('rifiuta defaultName %j', (n) => {
    expect(() => parseSaveOptions({ defaultName: n, filters: awl })).toThrow();
  });
});
