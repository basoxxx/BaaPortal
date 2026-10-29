import type { TagTable } from '@baaportal/project';
import { TAG_COLUMNS } from './columns';
import { buildTagRows, toLogicalAddress, type ParsedTags } from './rows';

export interface CsvRecord {
  /** Numero di riga nel file (1 = prima riga) dove il record inizia. */
  line: number;
  cells: string[];
  /** Virgolette non chiuse: il record è illeggibile. */
  unreadable: boolean;
}

const SEPARATORS = [';', ',', '\t'] as const;

/** Separatore più frequente nella riga d'intestazione, fuori dalle virgolette. */
function detectSeparator(text: string): string {
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
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const out: CsvRecord[] = [];
  let cells: string[] = [];
  let field = '';
  let quoted = false;
  let fieldWasQuoted = false;
  let line = 1;
  let startLine = 1;

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
    } else field += ch;
  }
  if (quoted) endRecord(true);
  else if (field !== '' || cells.length > 0 || fieldWasQuoted) endRecord(false);
  return out;
}

export function parseTagsCsv(text: string): ParsedTags {
  const records = parseCsv(text, detectSeparator(text.replace(/^\ufeff/, '')));
  const [header, ...rows] = records;
  if (!header) return { tags: [], constants: [], errors: [] };
  return buildTagRows(
    header.cells,
    rows.map((r) => ({ ...r, cells: r.cells.map(unescapeFormula) })),
  );
}

// Protezione dalle formule (OWASP, CSV injection): una cella che comincia con =, +, -, @, tab o CR
// (dopo eventuali apici) si esporta con un apice in più. In lettura se ne toglie uno solo alle celle
// fatte così: un apice iniziale seguito da altro (`'ciao`) è un valore e resta com'è.
const FORMULA = /^'*[=+\-@\t\r]/;
const ESCAPED = /^'+[=+\-@\t\r]/;
const escapeFormula = (v: string): string => (FORMULA.test(v) ? `'${v}` : v);
const unescapeFormula = (v: string): string => (ESCAPED.test(v) ? v.slice(1) : v);

const quote = (v: string, sep: string): string =>
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
