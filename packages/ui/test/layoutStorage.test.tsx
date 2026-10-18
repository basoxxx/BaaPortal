import { describe, expect, it } from 'vitest';
import { DEFAULT_PANELS, LAYOUT_KEY, loadLayout, saveLayout } from '../src/project/layoutStorage';
import { DEFAULT_PANELS as STORE_DEFAULTS } from '../src/state/store';

function fakeStorage(raw: string | null): Storage {
  return {
    getItem: () => raw,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  };
}
function throwingStorage(): Storage {
  const boom = () => {
    throw new Error('SecurityError');
  };
  return { getItem: boom, setItem: boom, removeItem: boom, clear: boom, key: boom, length: 0 };
}

describe('layoutStorage', () => {
  it('riesporta i valori predefiniti dello store', () => {
    expect(DEFAULT_PANELS).toBe(STORE_DEFAULTS);
  });

  it.each([
    null,
    'non-json',
    '{"navigation":{"open":true,"pinned":true,"size":500}}',
    '{"navigation":{"open":"si"}}',
  ])('layout %j non valido -> DEFAULT_PANELS', (raw) => {
    expect(loadLayout(fakeStorage(raw))).toEqual(DEFAULT_PANELS);
  });

  it('un campo errato riporta ai predefiniti solo quel pannello', () => {
    const raw = JSON.stringify({
      navigation: { open: false, pinned: false, size: 33 },
      details: { open: false, pinned: true, size: 99 },
    });
    const layout = loadLayout(fakeStorage(raw));
    expect(layout.navigation).toEqual({ open: false, pinned: false, size: 33 });
    expect(layout.details).toEqual(DEFAULT_PANELS.details);
    expect(layout.inspector).toEqual(DEFAULT_PANELS.inspector);
  });

  it('storage assente o che lancia eccezioni -> DEFAULT_PANELS, saveLayout non lancia', () => {
    expect(loadLayout(null)).toEqual(DEFAULT_PANELS);
    expect(loadLayout(throwingStorage())).toEqual(DEFAULT_PANELS);
    expect(() => saveLayout(throwingStorage(), DEFAULT_PANELS)).not.toThrow();
    expect(() => saveLayout(null, DEFAULT_PANELS)).not.toThrow();
  });

  it('andata e ritorno di un layout valido', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    } as Storage;
    const panels = {
      navigation: { open: false, pinned: true, size: 15 },
      details: { open: true, pinned: false, size: 40 },
      inspector: { open: true, pinned: true, size: 5 },
      taskCards: { open: false, pinned: false, size: 80 },
    };
    saveLayout(storage, panels);
    expect(store.has(LAYOUT_KEY)).toBe(true);
    expect(loadLayout(storage)).toEqual(panels);
  });
});
