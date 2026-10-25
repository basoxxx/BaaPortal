import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../src/settings/settings';

beforeEach(() => localStorage.clear());

describe('settings: aggiornamenti', () => {
  it('mancante o sbagliato → predefinito', () => {
    for (const bad of [undefined, 5, { checkOnStartup: 'x' }]) {
      localStorage.setItem('baa.settings.v1', JSON.stringify({ updates: bad }));
      expect(loadSettings().updates).toEqual({ checkOnStartup: true, prerelease: null });
    }
  });
  it('prerelease true/false/null conservato; «sì» → null', () => {
    for (const v of [true, false, null]) {
      localStorage.setItem(
        'baa.settings.v1',
        JSON.stringify({ updates: { checkOnStartup: false, prerelease: v } }),
      );
      expect(loadSettings().updates).toEqual({ checkOnStartup: false, prerelease: v });
    }
    localStorage.setItem('baa.settings.v1', JSON.stringify({ updates: { prerelease: 'sì' } }));
    expect(loadSettings().updates.prerelease).toBeNull();
  });
});

describe('settings', () => {
  it('nessuna chiave → DEFAULT_SETTINGS', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toEqual({
      general: { language: 'it', author: '', recoveryMinutes: 1 },
      appearance: { uiScale: 100 },
      editor: { mnemonic: 'int', fontSize: 13, tabSize: 4, autocomplete: true, lineNumbers: true },
      online: { experimental: false },
      updates: { checkOnStartup: true, prerelease: null },
    });
  });

  it('migra baa.lang=en e baa.mnemonic=int nella chiave nuova', () => {
    localStorage.setItem('baa.lang', 'en');
    localStorage.setItem('baa.mnemonic', 'international');
    localStorage.setItem('baa.lastAuthor', 'Anna');
    const s = loadSettings();
    expect(s.general.language).toBe('en');
    expect(s.editor.mnemonic).toBe('int');
    expect(s.general.author).toBe('Anna');
    localStorage.setItem('baa.mnemonic', 'german');
    expect(loadSettings().editor.mnemonic).toBe('de');
    // Con la chiave nuova presente le vecchie non contano più.
    saveSettings(s);
    expect(loadSettings().editor.mnemonic).toBe('int');
    expect(JSON.parse(localStorage.getItem('baa.settings.v1')!).general.language).toBe('en');
  });

  it('JSON rotto → default', () => {
    localStorage.setItem('baa.settings.v1', '{non json');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('campo non valido (fontSize 99) → default solo per quel campo', () => {
    localStorage.setItem(
      'baa.settings.v1',
      JSON.stringify({ editor: { fontSize: 99, tabSize: 8 }, general: { language: 'en' } }),
    );
    const s = loadSettings();
    expect(s.editor.fontSize).toBe(13);
    expect(s.editor.tabSize).toBe(8);
    expect(s.general.language).toBe('en');
  });
});

describe('settings - storage non disponibile', () => {
  it('localStorage che lancia → default, senza errori', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    const fresh = await import('../src/settings/settings');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('bloccato');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('bloccato');
    });
    try {
      expect(fresh.loadSettings()).toEqual(DEFAULT_SETTINGS);
      expect(() => fresh.saveSettings(DEFAULT_SETTINGS)).not.toThrow();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
