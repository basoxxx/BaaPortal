// Esporta e importa i testi di progetto multilingua (tappa 7D) in csv e xlsx.
import {
  listTextEntries,
  projectLanguageList,
  type Project,
  type TranslationInput,
} from '@baaportal/project';
import { detectSeparator, escapeFormula, parseCsv, quote, unescapeFormula } from '../tags/csv';
import { readXlsx, writeXlsx } from '../xlsx/ooxml';

export const TEXT_FIXED_COLUMNS = ['Key', 'Object', 'Field'] as const;

export interface ParsedTexts {
  translations: TranslationInput[];
  errors: { line: number; code: 'COLONNA_MANCANTE' | 'RIGA_ILLEGGIBILE' }[];
}

/** Righe da esportare: intestazione, poi chiave, oggetto, campo, lingua di modifica e le altre lingue. */
function textRows(p: Project): string[][] {
  const langs = projectLanguageList(p);
  const rows: string[][] = [[...TEXT_FIXED_COLUMNS, ...langs]];
  for (const e of listTextEntries(p)) {
    const own = p.texts && Object.hasOwn(p.texts, e.key) ? p.texts[e.key]! : {};
    rows.push([
      e.key,
      e.object,
      e.field,
      e.source,
      ...langs.slice(1).map((l) => (Object.hasOwn(own, l) ? own[l]! : '')),
    ]);
  }
  // Formule neutralizzate in scrittura; chi importa le ripristina.
  return rows.map((r) => r.map(escapeFormula));
}

export function textsToCsv(p: Project): string {
  const sep = ';';
  return (
    '﻿' +
    textRows(p)
      .map((l) => l.map((v) => quote(v, sep)).join(sep))
      .join('\r\n') +
    '\r\n'
  );
}

export function textsToXlsx(p: Project): Uint8Array {
  return writeXlsx([{ name: 'Project texts', rows: textRows(p) }]);
}

/** Dalle righe lette (la prima è l'intestazione): solo le colonne delle lingue indicate, celle vuote ignorate. */
function build(
  rows: { line: number; cells: string[]; unreadable?: boolean }[],
  languages: readonly string[],
): ParsedTexts {
  const out: ParsedTexts = { translations: [], errors: [] };
  const [header, ...body] = rows;
  const names = header?.cells.map((c) => c.trim()) ?? [];
  const iKey = names.indexOf('Key');
  const cols = languages.map((l) => [l, names.indexOf(l)] as const).filter(([, i]) => i >= 0);
  if (iKey < 0 || cols.length === 0) {
    out.errors.push({ line: header?.line ?? 1, code: 'COLONNA_MANCANTE' });
    return out;
  }
  for (const r of body) {
    if (r.unreadable) {
      out.errors.push({ line: r.line, code: 'RIGA_ILLEGGIBILE' });
      continue;
    }
    const key = unescapeFormula(r.cells[iKey] ?? '');
    if (!key) continue;
    for (const [lang, i] of cols) {
      const text = unescapeFormula(r.cells[i] ?? '');
      if (text !== '') out.translations.push({ key, lang, text });
    }
  }
  return out;
}

/** Legge un csv di testi: `languages` sono le lingue di traduzione del progetto (non quella di modifica). */
export function parseTextsCsv(text: string, languages: readonly string[]): ParsedTexts {
  const records = parseCsv(text, detectSeparator(text.replace(/^﻿/, '')));
  return build(records, languages);
}

/** Come `parseTextsCsv`, da xlsx; lancia `XlsxFormatError` se il file non è un xlsx leggibile. */
export function parseTextsXlsx(bytes: Uint8Array, languages: readonly string[]): ParsedTexts {
  const sheet = readXlsx(bytes)[0];
  return build(
    (sheet?.rows ?? []).map((cells, i) => ({ line: i + 1, cells })),
    languages,
  );
}
