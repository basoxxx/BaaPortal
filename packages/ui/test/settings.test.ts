import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../src/settings/settings';

beforeEach(() => localStorage.clear());

describe('settings', () => {
  it('nessuna chiave → DEFAULT_SETTINGS', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toEqual({
      general: { language: 'it', author: '', recoveryMinutes: 1 },
      appearance: { uiScale: 100 },
      editor: { mnemonic: 'int', fontSize: 13, tabSize: 4, autocomplete: true, lineNumbers: true },
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
