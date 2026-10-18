import type { CpuProperties, NewId, Tag, UserConstant } from '@baaportal/project';
import {
  addressFitsType,
  defaultLiteral,
  formatAddress,
  formatType,
  incrementAddress,
  incrementName,
  parseAddress,
  parseType,
} from '@baaportal/s7-types';
import { toTsv } from '../../grid/tsv';

const DEFAULT_TYPE = 'Bool';
const DEFAULT_ADDRESS = '%M0.0';
const DEFAULT_CONSTANT_TYPE = 'Int';

// Stessa chiave di confronto dei nomi di s7-types (sameName).
const nameKey = (name: string): string => name.normalize('NFC').toLowerCase();

/** Rende unico un nome rispetto a quelli già presi (e a quelli già dati da questa funzione). */
function namer(taken: readonly string[]): (base: string) => string {
  const used = new Set(taken.map(nameKey));
  return (base) => {
    let name = base;
    while (used.has(nameKey(name))) name = incrementName(name);
    used.add(nameKey(name));
    return name;
  };
}

/** Tipo normalizzato se valido, altrimenti il testo com'è. */
export function normalizeType(text: string): string {
  const p = parseType(text);
  return p.ok ? formatType(p.type) : text;
}
/** Indirizzo normalizzato se valido, altrimenti il testo senza spazi ai bordi. */
export function normalizeAddress(text: string): string {
  const p = parseAddress(text);
  return p.ok ? formatAddress(p.address) : text.trim();
}

const BASE_ADDRESS = new Map<string, string>([
  ['Bool', '%M0.0'],
  ['Byte', '%MB0'],
  ['Char', '%MB0'],
  ['Word', '%MW0'],
  ['Int', '%MW0'],
  ['S5Time', '%MW0'],
  ['Date', '%MW0'],
  ['DWord', '%MD0'],
  ['DInt', '%MD0'],
  ['Real', '%MD0'],
  ['Time', '%MD0'],
  ['Time_Of_Day', '%MD0'],
  ['Timer', '%T0'],
  ['Counter', '%C0'],
]);

/** Indirizzo che segue quello del precedente se è compatibile col tipo, altrimenti il primo libero per il tipo. */
export function addressAfter(prev: Tag | undefined, type: string): string {
  const t = parseType(type);
  if (!t.ok) return DEFAULT_ADDRESS;
  if (prev) {
    const a = parseAddress(prev.address);
    if (a.ok) {
      const next = incrementAddress(a.address);
      if (addressFitsType(next, t.type)) return formatAddress(next);
    }
  }
  return (
    BASE_ADDRESS.get(
      t.type.kind === 'elementary' || t.type.kind === 'parameter' ? t.type.name : '',
    ) ?? DEFAULT_ADDRESS
  );
}

export function newTagAfter(prev: Tag | undefined, name: string, newId: NewId): Tag {
  const type = prev?.type ?? DEFAULT_TYPE;
  return { id: newId(), name, type, address: addressAfter(prev, type), hmi: true, comment: '' };
}

/** `count` tag subito dopo la sorgente, con nome e indirizzo incrementati. */
export function fillTags(source: Tag, count: number, taken: string[], newId: NewId): Tag[] {
  const unique = namer(taken);
  const parsed = parseAddress(source.address);
  let address = parsed.ok ? parsed.address : null;
  let name = source.name;
  const out: Tag[] = [];
  for (let i = 0; i < count; i++) {
    name = unique(incrementName(name));
    if (address) address = incrementAddress(address);
    out.push({
      ...source,
      id: newId(),
      name,
      address: address ? formatAddress(address) : source.address,
    });
  }
  return out;
}

const isTruthy = (text: string | undefined): boolean =>
  text === undefined || !/^(false|0)$/i.test(text.trim());
const cell = (row: string[], i: number): string | undefined => {
  const v = row[i];
  return v === undefined || v === '' ? undefined : v;
};

/** Colonne nell'ordine visibile: Nome, Tipo di dati, Indirizzo, Ritenzione (ignorata), HMI, Commento. */
export function tagsFromTsv(rows: string[][], taken: string[], newId: NewId): Tag[] {
  const unique = namer(taken);
  return rows.map((r) => {
    const name = r[0] ?? '';
    const type = cell(r, 1);
    const address = cell(r, 2);
    return {
      id: newId(),
      name: name === '' ? '' : unique(name),
      type: type === undefined ? DEFAULT_TYPE : normalizeType(type),
      address: address === undefined ? DEFAULT_ADDRESS : normalizeAddress(address),
      hmi: isTruthy(r[4]),
      comment: r[5] ?? '',
    };
  });
}

export function tagsToTsv(tags: Tag[], retain: (t: Tag) => boolean): string {
  const flag = (b: boolean) => (b ? 'TRUE' : 'FALSE');
  return toTsv(
    tags.map((t) => [t.name, t.type, t.address, flag(retain(t)), flag(t.hmi), t.comment]),
  );
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;

/** Copia di righe prese dagli appunti: id nuovi, nomi unici; ciò che non è un tag è scartato. */
export function cloneTags(rows: unknown[], taken: string[], newId: NewId): Tag[] {
  const unique = namer(taken);
  const out: Tag[] = [];
  for (const r of rows) {
    if (!isRecord(r) || typeof r.name !== 'string') continue;
    out.push({
      id: newId(),
      name: r.name === '' ? '' : unique(r.name),
      type: typeof r.type === 'string' ? r.type : DEFAULT_TYPE,
      address: typeof r.address === 'string' ? r.address : DEFAULT_ADDRESS,
      hmi: r.hmi !== false,
      comment: typeof r.comment === 'string' ? r.comment : '',
    });
  }
  return out;
}

export function cloneConstants(rows: unknown[], taken: string[], newId: NewId): UserConstant[] {
  const unique = namer(taken);
  const out: UserConstant[] = [];
  for (const r of rows) {
    if (!isRecord(r) || typeof r.name !== 'string') continue;
    out.push({
      id: newId(),
      name: r.name === '' ? '' : unique(r.name),
      type: typeof r.type === 'string' ? r.type : DEFAULT_CONSTANT_TYPE,
      value: typeof r.value === 'string' ? r.value : '',
      comment: typeof r.comment === 'string' ? r.comment : '',
    });
  }
  return out;
}

/** Ritentiva: M sotto `mBytes`, T e C sotto i rispettivi numeri; ogni altra cosa (anche un indirizzo non valido) no. */
export function isRetentive(tag: Tag, props: CpuProperties): boolean {
  const p = parseAddress(tag.address);
  if (!p.ok) return false;
  const a = p.address;
  if ('number' in a)
    return a.number < (a.area === 'T' ? props.retentivity.timers : props.retentivity.counters);
  return a.area === 'M' && a.byte < props.retentivity.mBytes;
}

/** Valore iniziale proposto per un tipo (vuoto se il tipo non è valido). */
export function defaultValueOf(type: string): string {
  const p = parseType(type);
  return (p.ok ? defaultLiteral(p.type) : null) ?? '';
}

export function newConstantAfter(
  prev: UserConstant | undefined,
  name: string,
  newId: NewId,
): UserConstant {
  const type = prev?.type ?? DEFAULT_CONSTANT_TYPE;
  return { id: newId(), name, type, value: defaultValueOf(type), comment: '' };
}

/** Riempimento: si incrementa solo il nome. */
export function fillConstants(
  source: UserConstant,
  count: number,
  taken: string[],
  newId: NewId,
): UserConstant[] {
  const unique = namer(taken);
  let name = source.name;
  return Array.from({ length: count }, () => {
    name = unique(incrementName(name));
    return { ...source, id: newId(), name };
  });
}

/** Colonne: Nome, Tipo di dati, Valore, Commento. */
export function constantsFromTsv(rows: string[][], taken: string[], newId: NewId): UserConstant[] {
  const unique = namer(taken);
  return rows.map((r) => {
    const name = r[0] ?? '';
    const type = cell(r, 1);
    const normalized = type === undefined ? DEFAULT_CONSTANT_TYPE : normalizeType(type);
    return {
      id: newId(),
      name: name === '' ? '' : unique(name),
      type: normalized,
      value: cell(r, 2) ?? defaultValueOf(normalized),
      comment: r[3] ?? '',
    };
  });
}
