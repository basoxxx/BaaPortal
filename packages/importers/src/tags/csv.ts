import type { TagTable } from '@baaportal/project';
import { CONSTANT_COLUMNS, TAG_COLUMNS } from './columns';
import {
  buildConstantRows,
  buildTagRows,
  columnIndex,
  toLogicalAddress,
  type ParsedTags,
} from './rows';

export interface CsvRecord {
  /** Numero di riga nel file (1 = prima riga) dove il record inizia. */
  line: number;
  cells: string[];
  /** Virgolette non chiuse: il record è illeggibile. */
  unreadable: boolean;
}

const SEPARATORS = [';', ',', '\t'] as const;

/** Separatore più frequente nella riga d'intestazione, fuori dalle virgolette. */
export function detectSeparator(text: string): string {
  const counts = new Map<string, number>(SEPARATORS.map((s) => [s, 0]));
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && counts.has(ch)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let best: string = ';';
  let bestCount = 0;
  for (const [s, n] of counts) {
    if (n > bestCount) {
      best = s;
      bestCount = n;
    }
  }
  return best;
}

/** Legge un csv (RFC 4180) in record; ignora le righe vuote. */
export function parseCsv(input: string, separator: string): CsvRecord[] {
  return parseFrom(input.charCodeAt(0) === 0xfeff ? input.slice(1) : input, separator, 1);
}

/**
 * Come `parseCsv`, con la prima riga di `text` numerata `firstLine`. Un record con le virgolette
 * mai chiuse è illeggibile solo nella sua riga: la lettura riparte dalla riga dopo.
 */
function parseFrom(text: string, separator: string, firstLine: number): CsvRecord[] {
  const out: CsvRecord[] = [];
  let recordStart = 0;
  let cells: string[] = [];
  let field = '';
  let quoted = false;
  let fieldWasQuoted = false;
  let line = firstLine;
  let startLine = firstLine;

  const endRecord = (unreadable: boolean): void => {
    cells.push(field);
    const empty = cells.length === 1 && cells[0] === '' && !fieldWasQuoted;
    if (!empty) out.push({ line: startLine, cells, unreadable });
    cells = [];
    field = '';
    fieldWasQuoted = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      fieldWasQuoted = true;
    } else if (ch === separator) {
      cells.push(field);
      field = '';
      fieldWasQuoted = false;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRecord(false);
      line++;
      startLine = line;
      recordStart = i + 1;
    } else field += ch;
  }
  if (quoted) {
    // Il resto del file non si inghiotte: errore su questa riga, poi si riparte dalla successiva.
    out.push({ line: startLine, cells: [], unreadable: true });
    const eol = /\r\n|\r|\n/.exec(text.slice(recordStart));
    if (eol) {
      const rest = text.slice(recordStart + eol.index + eol[0].length);
      out.push(...parseFrom(rest, separator, startLine + 1));
    }
  } else if (field !== '' || cells.length > 0 || fieldWasQuoted) endRecord(false);
  return out;
}

export function parseTagsCsv(text: string): ParsedTags {
  const records = parseCsv(text, detectSeparator(text.replace(/^\ufeff/, '')));
  const [header, ...rows] = records;
  if (!header) return { tags: [], constants: [], errors: [] };
  const body = rows.map((r) => ({ ...r, cells: r.cells.map(unescapeFormula) }));
  // Un csv con la colonna Value e senza l'indirizzo è il file delle costanti (`…_costanti.csv`).
  const cols = columnIndex(header.cells);
  if (cols.has('value') && !cols.has('logical address')) {
    const p = buildConstantRows(header.cells, body);
    return { ...p, errors: p.errors.map((e) => ({ ...e, sheet: 'constants' as const })) };
  }
  return buildTagRows(header.cells, body);
}

// Protezione dalle formule (OWASP, CSV injection): una cella che comincia con =, +, -, @, tab o CR
// (dopo eventuali apici) si esporta con un apice in più. In lettura se ne toglie uno solo alle celle
// fatte così: un apice iniziale seguito da altro (`'ciao`) è un valore e resta com'è.
const FORMULA = /^'*[=+\-@\t\r]/;
const ESCAPED = /^'+[=+\-@\t\r]/;
export const escapeFormula = (v: string): string => (FORMULA.test(v) ? `'${v}` : v);
export const unescapeFormula = (v: string): string => (ESCAPED.test(v) ? v.slice(1) : v);

export const quote = (v: string, sep: string): string =>
  /["\r\n]/.test(v) || v.includes(sep) ? `"${v.replace(/"/g, '""')}"` : v;

export function tagsToCsv(table: TagTable): string {
  const sep = ';';
  const flag = (b: boolean): string => (b ? 'True' : 'False');
  const lines: string[][] = [[...TAG_COLUMNS]];
  for (const t of table.tags) {
    lines.push(
      [
        t.name,
        table.name,
        t.type,
        toLogicalAddress(t.address),
        t.comment,
        flag(t.hmi),
        flag(t.hmi),
        flag(t.hmi),
      ].map(escapeFormula),
    );
  }
  return '\ufeff' + lines.map((l) => l.map((v) => quote(v, sep)).join(sep)).join('\r\n') + '\r\n';
}

/** Le costanti utente di una tabella in csv (il csv ha un solo foglio: stanno in un file a parte). */
export function constantsToCsv(table: TagTable): string {
  const sep = ';';
  const lines: string[][] = [
    [...CONSTANT_COLUMNS],
    ...table.constants.map((c) =>
      [c.name, table.name, c.type, c.value, c.comment].map(escapeFormula),
    ),
  ];
  return '\ufeff' + lines.map((l) => l.map((v) => quote(v, sep)).join(sep)).join('\r\n') + '\r\n';
}
