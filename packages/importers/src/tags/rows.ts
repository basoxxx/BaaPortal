import {
  addressFitsType,
  formatAddress,
  formatType,
  parseAddress,
  parseType,
} from '@baaportal/s7-types';

export interface TagRow {
  line: number;
  name: string;
  path: string;
  type: string;
  address: string;
  comment: string;
  hmi: boolean;
}
export interface ConstantRow {
  line: number;
  name: string;
  path: string;
  type: string;
  value: string;
  comment: string;
}
/** Codici: COLONNA_MANCANTE, TIPO_NON_VALIDO, INDIRIZZO_NON_VALIDO, NOME_VUOTO, NOME_DOPPIO, RIGA_ILLEGGIBILE. */
export interface RowError {
  line: number;
  /** Solo per xlsx: foglio da cui viene l'errore. */
  sheet?: 'tags' | 'constants';
  code: string;
  detail?: string;
}
export interface ParsedTags {
  tags: TagRow[];
  constants: ConstantRow[];
  errors: RowError[];
}

/** Riga grezza di una tabella (csv o foglio): numero di riga nel file e celle. */
export interface RawRecord {
  line: number;
  cells: string[];
  unreadable?: boolean;
}

/** Indirizzo nel formato del progetto (`%MW10`, già normalizzato) -> forma logica (`%MW10`). */
export function toLogicalAddress(address: string): string {
  const p = parseAddress(address);
  return p.ok ? formatAddress(p.address) : address.trim();
}

/** Inverso: accetta l'indirizzo con e senza `%`; se non si riconosce lo lascia com'è. */
export function fromLogicalAddress(text: string): string {
  const p = parseAddress(text);
  return p.ok ? formatAddress(p.address) : text.trim();
}

const TRUE_WORDS = new Set(['true', 'vero', '1', 'sì', 'si', 'yes']);
const FALSE_WORDS = new Set(['false', 'falso', '0', 'no']);
/** Ciò che non si riconosce vale vero (predefinito dell'editor). */
export function parseFlag(text: string | undefined): boolean {
  const w = (text ?? '').trim().toLowerCase();
  return TRUE_WORDS.has(w) ? true : FALSE_WORDS.has(w) ? false : true;
}

/** Posizione di ogni colonna per nome (maiuscole/minuscole indifferenti). */
export function columnIndex(header: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  header.forEach((h, i) => {
    const key = h.trim().toLowerCase();
    if (key !== '' && !map.has(key)) map.set(key, i);
  });
  return map;
}

/** Riga con tutte le celle vuote (Excel lascia `;;;;`): non è un errore, si salta. */
const isBlankRecord = (r: RawRecord): boolean => r.cells.every((c) => c.trim() === '');

const REQUIRED = ['Name', 'Data Type', 'Logical Address'] as const;

type RowResult<T> = { row: T } | { code: string; detail?: string };

/**
 * Ciclo comune a variabili e costanti: colonne obbligatorie, righe illeggibili,
 * righe vuote, nome vuoto e nome doppio. `build` valida il resto della riga.
 */
function buildRows<T extends { name: string }>(
  header: readonly string[],
  records: readonly RawRecord[],
  required: readonly string[],
  build: (at: (name: string) => string, name: string) => RowResult<T>,
): { rows: T[]; errors: RowError[] } {
  const cols = columnIndex(header);
  const missing = required.filter((c) => !cols.has(c.toLowerCase()));
  if (missing.length > 0) {
    return {
      rows: [],
      errors: missing.map((c) => ({ line: 1, code: 'COLONNA_MANCANTE', detail: c })),
    };
  }
  const rows: T[] = [];
  const errors: RowError[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    const line = r.line;
    if (r.unreadable) {
      errors.push({ line, code: 'RIGA_ILLEGGIBILE' });
      continue;
    }
    if (isBlankRecord(r)) continue;
    const at = (name: string): string => {
      const i = cols.get(name.toLowerCase());
      return (i === undefined ? undefined : r.cells[i]) ?? '';
    };
    const name = at('Name').trim();
    if (name === '') {
      errors.push({ line, code: 'NOME_VUOTO' });
      continue;
    }
    if (seen.has(name.toLowerCase())) {
      errors.push({ line, code: 'NOME_DOPPIO', detail: name });
      continue;
    }
    const res = build(at, name);
    if ('row' in res) {
      seen.add(name.toLowerCase());
      rows.push({ ...res.row, line } as T);
    } else errors.push({ line, ...res });
  }
  return { rows, errors };
}

/**
 * Valida le righe di una tabella variabili. Un errore di riga non blocca le altre;
 * se manca una colonna obbligatoria non si importa nulla.
 */
export function buildTagRows(header: readonly string[], records: readonly RawRecord[]): ParsedTags {
  const { rows, errors } = buildRows<TagRow>(header, records, REQUIRED, (at, name) => {
    const typeText = at('Data Type').trim();
    const type = parseType(typeText);
    if (!type.ok) return { code: 'TIPO_NON_VALIDO', detail: typeText };
    const addressText = at('Logical Address').trim();
    const address = parseAddress(addressText);
    if (!address.ok || !addressFitsType(address.address, type.type)) {
      return { code: 'INDIRIZZO_NON_VALIDO', detail: addressText };
    }
    return {
      row: {
        line: 0,
        name,
        path: at('Path').trim(),
        type: formatType(type.type),
        address: formatAddress(address.address),
        comment: at('Comment'),
        hmi: parseFlag(at('Hmi Accessible')),
      },
    };
  });
  return { tags: rows, constants: [], errors };
}

const REQUIRED_CONSTANTS = ['Name', 'Data Type', 'Value'] as const;

/** Come `buildTagRows`, per il foglio delle costanti utente. Codici in più: VALORE_VUOTO. */
export function buildConstantRows(
  header: readonly string[],
  records: readonly RawRecord[],
): ParsedTags {
  const { rows, errors } = buildRows<ConstantRow>(
    header,
    records,
    REQUIRED_CONSTANTS,
    (at, name) => {
      const typeText = at('Data Type').trim();
      const type = parseType(typeText);
      if (!type.ok) return { code: 'TIPO_NON_VALIDO', detail: typeText };
      const value = at('Value').trim();
      if (value === '') return { code: 'VALORE_VUOTO', detail: name };
      return {
        row: {
          line: 0,
          name,
          path: at('Path').trim(),
          type: formatType(type.type),
          value,
          comment: at('Comment'),
        },
      };
    },
  );
  return { tags: [], constants: rows, errors };
}
