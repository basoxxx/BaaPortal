import { useCallback, useSyncExternalStore } from 'react';

export interface Settings {
  general: {
    language: 'it' | 'en';
    author: string;
    /** 0 = salvataggio di recupero disattivato. */
    recoveryMinutes: 1 | 2 | 5 | 10 | 0;
  };
  appearance: { uiScale: 90 | 100 | 110 | 125 };
  editor: {
    mnemonic: 'de' | 'int';
    fontSize: 11 | 12 | 13 | 14 | 16;
    tabSize: 2 | 4 | 8;
    autocomplete: boolean;
    lineNumbers: boolean;
  };
  /** `prerelease: null` segue il canale della build. */
  updates: { checkOnStartup: boolean; prerelease: boolean | null };
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export const SETTINGS_KEY = 'baa.settings.v1';
// Chiavi precedenti alle impostazioni: si leggono solo finché la chiave nuova manca.
const LEGACY_LANG = 'baa.lang';
const LEGACY_MNEMONIC = 'baa.mnemonic';
const LEGACY_AUTHOR = 'baa.lastAuthor';

export const DEFAULT_SETTINGS: Settings = {
  general: { language: 'it', author: '', recoveryMinutes: 1 },
  appearance: { uiScale: 100 },
  editor: { mnemonic: 'int', fontSize: 13, tabSize: 4, autocomplete: true, lineNumbers: true },
  updates: { checkOnStartup: true, prerelease: null },
};

export const RECOVERY_MINUTES = [1, 2, 5, 10, 0] as const;
export const UI_SCALES = [90, 100, 110, 125] as const;
export const FONT_SIZES = [11, 12, 13, 14, 16] as const;
export const TAB_SIZES = [2, 4, 8] as const;

function pick<T>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Porta un valore qualsiasi a impostazioni valide: i campi non validi tornano al predefinito, uno per uno. */
export function normalizeSettings(raw: unknown): Settings {
  const r = obj(raw);
  const g = obj(r.general);
  const a = obj(r.appearance);
  const e = obj(r.editor);
  const u = obj(r.updates);
  const d = DEFAULT_SETTINGS;
  return {
    general: {
      language: pick(g.language, ['it', 'en'], d.general.language),
      author: typeof g.author === 'string' ? g.author : d.general.author,
      recoveryMinutes: pick(g.recoveryMinutes, RECOVERY_MINUTES, d.general.recoveryMinutes),
    },
    appearance: { uiScale: pick(a.uiScale, UI_SCALES, d.appearance.uiScale) },
    editor: {
      mnemonic: pick(e.mnemonic, ['de', 'int'], d.editor.mnemonic),
      fontSize: pick(e.fontSize, FONT_SIZES, d.editor.fontSize),
      tabSize: pick(e.tabSize, TAB_SIZES, d.editor.tabSize),
      autocomplete: bool(e.autocomplete, d.editor.autocomplete),
      lineNumbers: bool(e.lineNumbers, d.editor.lineNumbers),
    },
    updates: {
      checkOnStartup: bool(u.checkOnStartup, d.updates.checkOnStartup),
      prerelease: typeof u.prerelease === 'boolean' ? u.prerelease : null,
    },
  };
}

function mergeSettings(base: Settings, patch: DeepPartial<Settings>): Settings {
  return normalizeSettings({
    general: { ...base.general, ...patch.general },
    appearance: { ...base.appearance, ...patch.appearance },
    editor: { ...base.editor, ...patch.editor },
    updates: { ...base.updates, ...patch.updates },
  });
}

// Se il localStorage non è disponibile le impostazioni valgono comunque per questa sessione.
let memoryRaw: string | null = null;

function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageAvailable(): boolean {
  try {
    localStorage.getItem(SETTINGS_KEY);
    return true;
  } catch {
    return false;
  }
}

function parse(raw: string | null): Settings {
  if (raw === null) {
    const lang = readKey(LEGACY_LANG);
    const mnemonic = readKey(LEGACY_MNEMONIC);
    const author = readKey(LEGACY_AUTHOR);
    return normalizeSettings({
      general: {
        ...(lang !== null ? { language: lang } : {}),
        ...(author !== null ? { author } : {}),
      },
      editor: { ...(mnemonic !== null ? { mnemonic: mnemonic === 'german' ? 'de' : 'int' } : {}) },
    });
  }
  try {
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return normalizeSettings(null);
  }
}

function currentRaw(): string | null {
  if (!storageAvailable()) return memoryRaw;
  return readKey(SETTINGS_KEY);
}

// L'istantanea resta la stessa finché i dati di partenza non cambiano (serve a useSyncExternalStore).
let cache: { key: string; value: Settings } | null = null;

export function getSettings(): Settings {
  const raw = currentRaw();
  const key =
    raw !== null
      ? `n:${raw}`
      : `l:${readKey(LEGACY_LANG)}|${readKey(LEGACY_MNEMONIC)}|${readKey(LEGACY_AUTHOR)}`;
  if (cache?.key !== key) cache = { key, value: parse(raw) };
  return cache.value;
}

export function loadSettings(): Settings {
  return getSettings();
}

const listeners = new Set<() => void>();

export function subscribeSettings(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function saveSettings(s: Settings): void {
  const clean = normalizeSettings(s);
  const raw = JSON.stringify(clean);
  memoryRaw = raw;
  try {
    localStorage.setItem(SETTINGS_KEY, raw);
  } catch {
    /* storage non disponibile: restano le impostazioni in memoria */
  }
  for (const l of listeners) l();
}

/** Applica una modifica parziale e la salva; tutti i componenti che usano le impostazioni si aggiornano. */
export function updateSettings(patch: DeepPartial<Settings>): void {
  saveSettings(mergeSettings(getSettings(), patch));
}

export function useSettings(): [Settings, (patch: DeepPartial<Settings>) => void] {
  const s = useSyncExternalStore(subscribeSettings, getSettings, () => DEFAULT_SETTINGS);
  return [s, useCallback((patch: DeepPartial<Settings>) => updateSettings(patch), [])];
}

/** Scala e carattere degli editor come variabili CSS su :root di un documento (anche una finestra staccata). */
export function applyDisplaySettings(doc: Document, s: Settings): void {
  const root = doc.documentElement;
  root.style.setProperty('--baa-ui-scale', String(s.appearance.uiScale / 100));
  root.style.setProperty('--baa-editor-font-size', `${s.editor.fontSize}px`);
}
