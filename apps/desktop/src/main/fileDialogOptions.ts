import type { FileFilter } from '@baaportal/ui';

// Gli argomenti arrivano dal renderer via IPC: si validano prima di passarli a dialog.*.
const MAX_FILTERS = 20;
const MAX_EXTENSIONS = 50;
const MAX_TEXT = 255;
const EXTENSION = /^[A-Za-z0-9_-]+$|^\*$/;

/** Testo breve senza NUL (che taglierebbe la stringa passata al sistema). */
const shortText = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= MAX_TEXT && !v.includes('\u0000');

function parseFilters(v: unknown): FileFilter[] {
  if (!Array.isArray(v) || v.length > MAX_FILTERS) throw new Error('Filtri del dialogo non validi');
  return v.map((f: unknown) => {
    const o = f as { name?: unknown; extensions?: unknown } | null;
    if (
      typeof o !== 'object' ||
      o === null ||
      !shortText(o.name) ||
      !Array.isArray(o.extensions) ||
      o.extensions.length > MAX_EXTENSIONS ||
      !o.extensions.every((x) => shortText(x) && EXTENSION.test(x))
    )
      throw new Error('Filtri del dialogo non validi');
    return { name: o.name, extensions: o.extensions as string[] };
  });
}

export function parseOpenOptions(v: unknown): { filters: FileFilter[]; multi: boolean } {
  const o = v as { filters?: unknown; multi?: unknown } | null;
  if (typeof o !== 'object' || o === null) throw new Error('Opzioni del dialogo non valide');
  if (o.multi !== undefined && typeof o.multi !== 'boolean')
    throw new Error('Opzioni del dialogo non valide');
  return { filters: parseFilters(o.filters), multi: o.multi === true };
}

export function parseSaveOptions(v: unknown): { defaultName: string; filters: FileFilter[] } {
  const o = v as { defaultName?: unknown; filters?: unknown } | null;
  if (typeof o !== 'object' || o === null) throw new Error('Opzioni del dialogo non valide');
  if (!shortText(o.defaultName) || o.defaultName === '' || /[\\/]/.test(o.defaultName))
    throw new Error('Nome di file predefinito non valido');
  return { defaultName: o.defaultName, filters: parseFilters(o.filters) };
}
