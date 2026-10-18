import { describe, expect, it } from 'vitest';
import en from '../src/i18n/en.json';
import it_ from '../src/i18n/it.json';
import { commands } from '../src/commands/commands';

function flat(obj: unknown, prefix = ''): [string, string][] {
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    typeof v === 'string' ? [[prefix + k, v] as [string, string]] : flat(v, prefix + k + '.'),
  );
}
const flatKeys = (o: unknown) =>
  flat(o)
    .map(([k]) => k)
    .sort();
const flatValues = (o: unknown) => flat(o).map(([, v]) => v);

describe('i18n', () => {
  it('it.json ed en.json hanno esattamente le stesse chiavi', () => {
    expect(flatKeys(en)).toEqual(flatKeys(it_));
  });
  it('nessun valore vuoto', () => {
    expect(flatValues(it_).filter((v) => v.trim() === '')).toEqual([]);
    expect(flatValues(en).filter((v) => v.trim() === '')).toEqual([]);
  });
  it('ogni comando ha un testo in entrambe le lingue', () => {
    const keys = new Set(flatKeys(it_));
    for (const c of Object.values(commands)) expect(keys.has(c.labelKey)).toBe(true);
  });
});
