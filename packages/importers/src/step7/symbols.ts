// Tabella dei simboli esportata dall'editor dei simboli di STEP 7 V5.5 (SDF, SEQ, DIF, ASC).
import {
  addressFitsType,
  formatAddress,
  formatType,
  parseAddress,
  parseType,
} from '@baaportal/s7-types';
import { parseCsv } from '../tags/csv';
import type { ParsedTags, RowError, TagRow } from '../tags/rows';
import { splitLines } from '../awlSource/text';

export type Step7SymbolFormat = 'sdf' | 'seq' | 'dif' | 'asc';
export type Step7BlockKind = 'OB' | 'FB' | 'FC' | 'DB' | 'UDT' | 'VAT' | 'SFC' | 'SFB';

/** Simbolo di un blocco (`"Motore" FB 10`): dà il nome al blocco con quel numero. */
export interface BlockSymbol {
  line: number;
  name: string;
  kind: Step7BlockKind;
  number: number;
  comment: string;
}

export interface ParsedSymbols extends ParsedTags {
  blocks: BlockSymbol[];
}

/** Riga letta, prima della verifica di indirizzo e tipo. */
interface RawSymbol {
  line: number;
  name: string;
  address: string;
  type: string;
  comment: string;
}

const BLOCK_REF = /^(OB|FB|FC|DB|UDT|VAT|SFC|SFB)\s*(\d+)$/i;
/** Prefisso del tipo di record (`126,`) delle righe SEQ e ASC. */
const RECORD_PREFIX = /^\d+,/;
const HEADER_WORDS = new Set([
  'symbol',
  'symbol name',
  'address',
  'operand',
  'adresse',
  'symbolname',
]);
const TYPE_WORDS = new Set([
  'BOOL',
  'BYTE',
  'WORD',
  'DWORD',
  'CHAR',
  'INT',
  'DINT',
  'REAL',
  'S5TIME',
  'TIME',
  'DATE',
  'TOD',
  'TIME_OF_DAY',
  'TIMER',
  'COUNTER',
]);

const isAddress = (text: string): boolean => BLOCK_REF.test(text.trim()) || parseAddress(text).ok;
const isType = (text: string): boolean => {
  const t = text.trim().toUpperCase();
  return TYPE_WORDS.has(t) || BLOCK_REF.test(t);
};

/**
 * Celle di una riga in un simbolo: l'indirizzo è la cella che si legge come indirizzo, il simbolo la
 * prima delle altre; se la cella dopo il simbolo è un tipo è il tipo, il resto è il commento. Così vale
 * l'ordine dell'SDF (simbolo, indirizzo, tipo, commento) e anche quello con l'indirizzo in testa.
 */
function fromCells(line: number, cells: string[]): RawSymbol | null {
  const trimmed = cells.map((c) => c.trim());
  // Ordine dell'SDF se la seconda cella è un indirizzo: un simbolo come `T1` sembra un indirizzo.
  const at =
    trimmed.length > 1 && isAddress(trimmed[1]!)
      ? 1
      : trimmed.findIndex((c) => c !== '' && isAddress(c));
  if (at < 0) return null;
  const rest = trimmed.filter((_, i) => i !== at);
  const name = rest[0] ?? '';
  // Nell'ordine fisso la terza cella è sempre il tipo (anche sbagliato: lo segnala la verifica).
  const hasType = rest[1] !== undefined && (at === 1 || isType(rest[1]));
  const comment = rest
    .slice(hasType ? 2 : 1)
    .filter((c) => c !== '')
    .join(' ');
  return { line, name, address: trimmed[at]!, type: hasType ? rest[1]! : '', comment };
}

const isHeader = (cells: string[]): boolean =>
  cells.some((c) => HEADER_WORDS.has(c.trim().toLowerCase()));

const ADDRESS_TEXT = String.raw`(?:%?[A-Za-z]{1,3}\s*\d+(?:\.\d+)?)`;
const TYPE_TEXT = String.raw`(?:(?:OB|FB|FC|DB|UDT|VAT|SFC|SFB)\s*\d+|[A-Za-z_][A-Za-z0-9_]*)`;
const FIXED_REST = new RegExp(String.raw`^\s*(${ADDRESS_TEXT})\s+(${TYPE_TEXT})(?:\s+(.*))?$`);
const FREE_LINE = new RegExp(String.raw`^(.+?)\s+(${ADDRESS_TEXT})\s+(${TYPE_TEXT})(?:\s+(.*))?$`);
/** Larghezza della colonna del simbolo nel formato ASC. */
const ASC_NAME_WIDTH = 24;

/** Riga a colonne fisse (ASC): simbolo nelle prime 24 colonne, poi indirizzo, tipo e commento. */
function fixedLine(line: number, text: string): RawSymbol | null {
  const fixed = FIXED_REST.exec(text.slice(ASC_NAME_WIDTH));
  if (fixed && text.slice(0, ASC_NAME_WIDTH).trim() !== '' && isAddress(fixed[1]!)) {
    return {
      line,
      name: text.slice(0, ASC_NAME_WIDTH).trim(),
      address: fixed[1]!,
      type: fixed[2]!,
      comment: (fixed[3] ?? '').trim(),
    };
  }
  // Colonne di larghezza diversa: il primo indirizzo seguito da un tipo chiude il nome.
  const free = FREE_LINE.exec(text.trim());
  if (free && isAddress(free[2]!)) {
    return {
      line,
      name: free[1]!.trim(),
      address: free[2]!,
      type: free[3]!,
      comment: (free[4] ?? '').trim(),
    };
  }
  return null;
}

type Lines = { rows: (RawSymbol | null)[]; lines: number[]; broken?: number };

function sdfRows(text: string): Lines {
  const rows: (RawSymbol | null)[] = [];
  const lines: number[] = [];
  for (const r of parseCsv(text, ',')) {
    if (rows.length === 0 && isHeader(r.cells)) continue;
    rows.push(r.unreadable ? null : fromCells(r.line, r.cells));
    lines.push(r.line);
  }
  return { rows, lines };
}

/** SEQ (separato da tabulazioni) e ASC (colonne fisse): una riga per simbolo, con `126,` in testa. */
function lineRows(text: string, tabbed: boolean): Lines {
  const rows: (RawSymbol | null)[] = [];
  const lines: number[] = [];
  splitLines(text).forEach((raw, i) => {
    if (raw.trim() === '') return;
    const body = raw.replace(RECORD_PREFIX, '');
    const cells = body.split('\t');
    if (rows.length === 0 && isHeader(cells)) return;
    rows.push(tabbed && cells.length > 1 ? fromCells(i + 1, cells) : fixedLine(i + 1, body));
    lines.push(i + 1);
  });
  return { rows, lines };
}

/** Stringa DIF tra virgolette (`""` vale `"`). */
const difString = (text: string): string => {
  const t = text.trim();
  return t.startsWith('"') && t.endsWith('"') && t.length >= 2
    ? t.slice(1, -1).replace(/""/g, '"')
    : t;
};

/**
 * DIF (Data Interchange Format): intestazione fino a `DATA`, poi coppie di righe per cella:
 * `-1,0` + `BOT` apre una riga, `1,0` + `"testo"` è una stringa, `0,n` + `V` un numero, `EOD` chiude.
 */
function difRows(text: string): Lines {
  const all = splitLines(text);
  const rows: (RawSymbol | null)[] = [];
  const lines: number[] = [];
  let i = all.findIndex((l) => l.trim().toUpperCase() === 'DATA');
  if (i < 0) return { rows, lines, broken: 1 };
  i += 3; // DATA, `0,0`, `""`
  let cells: string[] | null = null;
  let rowLine = 0;
  const close = (): void => {
    if (cells === null) return;
    if (!(rows.length === 0 && isHeader(cells)) && cells.some((c) => c.trim() !== '')) {
      rows.push(fromCells(rowLine, cells));
      lines.push(rowLine);
    }
    cells = null;
  };
  for (; i < all.length; i += 2) {
    const head = all[i]!.trim();
    const value = all[i + 1] ?? '';
    const [kind, num] = head.split(',');
    if (kind === '-1') {
      const word = value.trim().toUpperCase();
      if (word === 'EOD') break;
      if (word === 'BOT') {
        close();
        cells = [];
        rowLine = i + 1;
      }
    } else if (kind === '1') cells?.push(difString(value));
    else if (kind === '0') cells?.push(value.trim().toUpperCase() === 'V' ? (num ?? '') : '');
    else return { rows, lines, broken: i + 1 };
  }
  close();
  return { rows, lines };
}

/** Tipo dato dall'indirizzo quando il file non lo scrive. */
function typeOfAddress(address: string): string {
  const p = parseAddress(address);
  if (!p.ok) return '';
  const a = p.address;
  if ('number' in a) return a.area === 'T' ? 'Timer' : 'Counter';
  return { X: 'Bool', B: 'Byte', W: 'Word', D: 'DWord' }[a.size];
}

/**
 * Legge una tabella dei simboli esportata da STEP 7 V5.5. I simboli di operandi (I, Q, M, PI, PQ, T, C,
 * con mnemonici tedeschi o internazionali) diventano variabili; quelli di blocchi (OB, FB, FC, DB, UDT,
 * VAT, SFC, SFB) vanno in `blocks`. Una riga sbagliata va negli errori col suo numero e non ferma le altre.
 */
export function parseStep7Symbols(text: string, format: Step7SymbolFormat): ParsedSymbols {
  const read =
    format === 'sdf'
      ? sdfRows(text)
      : format === 'dif'
        ? difRows(text)
        : lineRows(text, format === 'seq');
  const tags: TagRow[] = [];
  const blocks: BlockSymbol[] = [];
  const errors: RowError[] = [];
  if (read.broken !== undefined) {
    errors.push({ line: read.broken, code: 'RIGA_ILLEGGIBILE' });
  }
  const seen = new Set<string>();
  read.rows.forEach((raw, n) => {
    const line = read.lines[n]!;
    if (!raw) {
      errors.push({ line, code: 'RIGA_ILLEGGIBILE' });
      return;
    }
    if (raw.name === '') {
      errors.push({ line, code: 'NOME_VUOTO' });
      return;
    }
    const key = raw.name.toLowerCase();
    if (seen.has(key)) {
      errors.push({ line, code: 'NOME_DOPPIO', detail: raw.name });
      return;
    }
    const block = BLOCK_REF.exec(raw.address.trim());
    if (block) {
      seen.add(key);
      blocks.push({
        line,
        name: raw.name,
        kind: block[1]!.toUpperCase() as Step7BlockKind,
        number: Number(block[2]),
        comment: raw.comment,
      });
      return;
    }
    const address = parseAddress(raw.address);
    const typeText = raw.type.trim() === '' ? typeOfAddress(raw.address) : raw.type.trim();
    const type = parseType(typeText);
    if (!type.ok) {
      errors.push({ line, code: 'TIPO_NON_VALIDO', detail: typeText });
      return;
    }
    if (!address.ok || !addressFitsType(address.address, type.type)) {
      errors.push({ line, code: 'INDIRIZZO_NON_VALIDO', detail: raw.address.trim() });
      return;
    }
    seen.add(key);
    tags.push({
      line,
      name: raw.name,
      path: '',
      type: formatType(type.type),
      address: formatAddress(address.address),
      comment: raw.comment,
      hmi: true,
    });
  });
  return { tags, constants: [], blocks, errors };
}
