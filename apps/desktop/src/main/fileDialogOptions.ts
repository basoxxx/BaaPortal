import type { FileFilter } from '@baaportal/ui';

// Gli argomenti arrivano dal renderer via IPC: si validano prima di passarli a dialog.*.
function parseFilters(v: unknown): FileFilter[] {
  if (!Array.isArray(v)) throw new Error('Filtri del dialogo non validi');
  return v.map((f: unknown) => {
    const o = f as { name?: unknown; extensions?: unknown } | null;
    if (
      typeof o !== 'object' ||
      o === null ||
      typeof o.name !== 'string' ||
      !Array.isArray(o.extensions) ||
      !o.extensions.every((x) => typeof x === 'string' && /^[A-Za-z0-9_-]+$|^\*$/.test(x))
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
  if (typeof o.defaultName !== 'string' || o.defaultName === '' || /[\\/]/.test(o.defaultName))
    throw new Error('Nome di file predefinito non valido');
  return { defaultName: o.defaultName, filters: parseFilters(o.filters) };
}
