import type { DataType } from './types';

export type LiteralError = 'SYNTAX' | 'OUT_OF_RANGE' | 'TOO_LONG' | 'NO_VALUE';
type Result = { ok: true; canonical: string } | { ok: false; error: LiteralError };

const ok = (canonical: string): Result => ({ ok: true, canonical });
const fail = (error: LiteralError): Result => ({ ok: false, error });

const pad = (n: number, w: number): string => String(n).padStart(w, '0');

// ---- Bool ----

function parseBool(text: string): Result {
  const v = text.toLowerCase();
  if (v === 'true' || v === '1') return ok('true');
  if (v === 'false' || v === '0') return ok('false');
  return fail('SYNTAX');
}

// ---- Byte / Word / DWord ----

const BIT_WIDTH = { Byte: 8, Word: 16, DWord: 32 } as const;
const TYPED_PREFIX = { Byte: 'b#', Word: 'w#', DWord: 'dw#' } as const;

function parseBits(name: keyof typeof BIT_WIDTH, text: string): Result {
  const max = (1n << BigInt(BIT_WIDTH[name])) - 1n;
  let value: bigint;
  let s = text.toLowerCase();
  const tuple = /^b#\(([^)]*)\)$/.exec(s);
  if (tuple) {
    const parts = (tuple[1] as string).split(',').map((p) => p.trim());
    if (parts.length !== 2 && parts.length !== 4) return fail('SYNTAX');
    value = 0n;
    for (const p of parts) {
      if (!/^\d+$/.test(p)) return fail('SYNTAX');
      const b = BigInt(p);
      if (b > 255n) return fail('OUT_OF_RANGE');
      value = (value << 8n) | b;
    }
  } else {
    if (s.startsWith(TYPED_PREFIX[name])) s = s.slice(TYPED_PREFIX[name].length);
    // Nelle forme 16# e 2# le cifre si possono separare con un solo '_' (`2#0000_0001`, `16#FF_FF`).
    if (/^\d+$/.test(s)) value = BigInt(s);
    else if (/^16#[0-9a-f](?:_?[0-9a-f])*$/.test(s))
      value = BigInt(`0x${s.slice(3).replace(/_/g, '')}`);
    else if (/^2#[01](?:_?[01])*$/.test(s)) value = BigInt(`0b${s.slice(2).replace(/_/g, '')}`);
    else return fail('SYNTAX');
  }
  if (value > max) return fail('OUT_OF_RANGE');
  return ok(`16#${value.toString(16).toUpperCase()}`);
}

// ---- Int / DInt ----

function parseInteger(text: string, bits: 16 | 32, allowL: boolean): Result {
  const s = allowL && /^l#/i.test(text) ? text.slice(2) : text;
  if (!/^[+-]?\d+$/.test(s)) return fail('SYNTAX');
  const v = BigInt(s);
  const limit = 1n << BigInt(bits - 1);
  if (v < -limit || v >= limit) return fail('OUT_OF_RANGE');
  return ok(v.toString());
}

// ---- Real ----

function parseReal(text: string): Result {
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return fail('SYNTAX');
  const n = Number(text);
  // fuori intervallo solo se non è un REAL finito: il massimo float32 (3.4028235e+38) vale
  if (!Number.isFinite(Math.fround(n))) return fail('OUT_OF_RANGE');
  return ok(Number.isInteger(n) && Math.abs(n) < 1e21 ? `${n}.0` : String(n));
}

// ---- Durate (S5Time, Time) ----

const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000, ms: 1 } as const;
type Unit = keyof typeof UNIT_MS;
const UNIT_ORDER: Unit[] = ['d', 'h', 'm', 's', 'ms'];

// Somma i componenti `<numero><unità>` (con `_` facoltativo); le unità devono andare dalla maggiore alla minore.
function parseComponents(body: string, units: Unit[]): number | null {
  const re = /(\d+)(ms|d|h|m|s)(_?)/iy;
  let pos = 0;
  let total = 0;
  let last = -1;
  let sep = false;
  while (pos < body.length) {
    re.lastIndex = pos;
    const m = re.exec(body);
    if (!m) return null;
    const unit = (m[2] as string).toLowerCase() as Unit;
    const idx = UNIT_ORDER.indexOf(unit);
    if (!units.includes(unit) || idx <= last) return null;
    last = idx;
    total += Number(m[1]) * UNIT_MS[unit];
    sep = m[3] === '_';
    pos = re.lastIndex;
  }
  return last < 0 || sep ? null : total;
}

function formatComponents(ms: number, units: Unit[]): string {
  let rest = ms;
  let out = '';
  for (const u of units) {
    const n = Math.floor(rest / UNIT_MS[u]);
    rest -= n * UNIT_MS[u];
    if (n > 0) out += `${n}${u.toUpperCase()}`;
  }
  return out === '' ? '0MS' : out;
}

const S5_UNITS: Unit[] = ['h', 'm', 's', 'ms'];
const S5_MAX_MS = 9_990_000; // 2H46M30S

function parseS5Time(text: string): Result {
  const m = /^s5t(?:ime)?#(.*)$/i.exec(text);
  if (!m) return fail('SYNTAX');
  const total = parseComponents(m[1] as string, S5_UNITS);
  if (total === null) return fail('SYNTAX');
  if (total > S5_MAX_MS || total % 10 !== 0) return fail('OUT_OF_RANGE');
  return ok(`S5T#${formatComponents(total, S5_UNITS)}`);
}

const TIME_MIN_MS = -2_147_483_648;
const TIME_MAX_MS = 2_147_483_647;

function parseTime(text: string): Result {
  const m = /^t(?:ime)?#(-?)(.*)$/i.exec(text);
  if (!m) return fail('SYNTAX');
  const abs = parseComponents(m[2] as string, UNIT_ORDER);
  if (abs === null) return fail('SYNTAX');
  const total = m[1] === '-' ? -abs : abs;
  if (total < TIME_MIN_MS || total > TIME_MAX_MS) return fail('OUT_OF_RANGE');
  return ok(`T#${total < 0 ? '-' : ''}${formatComponents(abs, UNIT_ORDER)}`);
}

// ---- Date, Time_Of_Day, Date_And_Time ----

// Controlla che la data esista davvero ricostruendola con Date.UTC.
function validDate(y: number, mo: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function validTime(h: number, mi: number, s: number): boolean {
  return h < 24 && mi < 60 && s < 60;
}

const fraction = (f: string | undefined): string => (f ?? '').padEnd(3, '0');

function parseDate(text: string): Result {
  const m = /^(?:d|date)#(\d{4})-(\d{1,2})-(\d{1,2})$/i.exec(text);
  if (!m) return fail('SYNTAX');
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1990 || y > 2168 || !validDate(y, mo, d)) return fail('OUT_OF_RANGE');
  return ok(`D#${y}-${pad(mo, 2)}-${pad(d, 2)}`);
}

function parseTimeOfDay(text: string): Result {
  const m = /^(?:tod|time_of_day)#(\d{1,2}):(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/i.exec(text);
  if (!m) return fail('SYNTAX');
  const [h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!validTime(h, mi, s)) return fail('OUT_OF_RANGE');
  return ok(`TOD#${pad(h, 2)}:${pad(mi, 2)}:${pad(s, 2)}.${fraction(m[4])}`);
}

/** Anno a due cifre di STEP 7 (`DT#90-1-1-0:0:0.000`): 90-99 → 1990-1999, 00-89 → 2000-2089. */
const fullYear = (text: string): number => {
  const y = Number(text);
  return text.length === 2 ? (y >= 90 ? 1900 + y : 2000 + y) : y;
};

function parseDateAndTime(text: string): Result {
  const m =
    /^(?:dt|date_and_time)#(\d{4}|\d{2})-(\d{1,2})-(\d{1,2})-(\d{1,2}):(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/i.exec(
      text,
    );
  if (!m) return fail('SYNTAX');
  const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map((i) =>
    i === 1 ? fullYear(m[1]!) : Number(m[i]),
  );
  if (y! < 1990 || y! > 2089 || !validDate(y!, mo!, d!) || !validTime(h!, mi!, s!))
    return fail('OUT_OF_RANGE');
  return ok(
    `DT#${y}-${pad(mo!, 2)}-${pad(d!, 2)}-${pad(h!, 2)}:${pad(mi!, 2)}:${pad(s!, 2)}.${fraction(m[7])}`,
  );
}

// ---- Char e String ----

const SIMPLE_ESCAPES = new Set(["'", '$', 'L', 'N', 'P', 'R', 'T']);

// Conta i caratteri del testo tra apici; un'escape vale un carattere.
function countChars(text: string): { count: number } | { error: LiteralError } {
  if (text.length < 2 || !text.startsWith("'") || !text.endsWith("'")) return { error: 'SYNTAX' };
  const inner = Array.from(text.slice(1, -1));
  let count = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i] as string;
    if (c === "'") return { error: 'SYNTAX' };
    if (c === '$') {
      const next = inner[i + 1];
      if (next === undefined) return { error: 'SYNTAX' };
      if (SIMPLE_ESCAPES.has(next.toUpperCase())) {
        i += 1;
      } else if (/^[0-9a-fA-F]{2}$/.test(next + (inner[i + 2] ?? ''))) {
        i += 2;
      } else {
        return { error: 'SYNTAX' };
      }
    } else if ((c.codePointAt(0) as number) > 0xff) {
      return { error: 'OUT_OF_RANGE' };
    }
    count++;
  }
  return { count };
}

function parseChar(text: string): Result {
  const r = countChars(text);
  if ('error' in r) return fail(r.error);
  if (r.count === 0) return fail('SYNTAX');
  return r.count > 1 ? fail('TOO_LONG') : ok(text);
}

function parseString(length: number, text: string): Result {
  const r = countChars(text);
  if ('error' in r) return fail(r.error);
  return r.count > length ? fail('TOO_LONG') : ok(text);
}

// ---- Valori iniziali di un array ----

/** Le parti separate da ',' fuori dagli apici e dalle parentesi; null se le parentesi non tornano. */
function splitTopLevel(text: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '$') i++;
      else if (c === "'") quoted = false;
    } else if (c === "'") quoted = true;
    else if (c === '(') depth++;
    else if (c === ')') {
      if (--depth < 0) return null;
    } else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (depth !== 0 || quoted) return null;
  parts.push(text.slice(start));
  return parts;
}

/** Numero di elementi di un array (prodotto delle dimensioni). */
const arraySize = (type: Extract<DataType, { kind: 'array' }>): number =>
  type.dims.reduce((n, d) => n * (d.hi - d.lo + 1), 1);

/**
 * Valori iniziali di un array come li scrive la sorgente: `1, 2, 3`, la ripetizione `4(0)` o un misto
 * (`2(1), 3`). Ogni valore vale per il tipo degli elementi; gli elementi non possono essere più della
 * dimensione dell'array (meno sì: gli altri tengono il valore predefinito).
 */
function parseArrayInitializer(type: Extract<DataType, { kind: 'array' }>, text: string): Result {
  const el = type.element;
  if (el.kind !== 'elementary' && el.kind !== 'string' && el.kind !== 'dateAndTime')
    return fail('NO_VALUE');
  const parts = splitTopLevel(text);
  if (!parts) return fail('SYNTAX');
  const out: string[] = [];
  let count = 0;
  for (const raw of parts) {
    const part = raw.trim();
    const rep = /^(\d+)\s*\((.*)\)$/s.exec(part);
    const times = rep ? Number(rep[1]) : 1;
    const value = (rep ? rep[2]! : part).trim();
    if (value === '' || times === 0) return fail('SYNTAX');
    const v = parseLiteral(el, value);
    if (!v.ok) return v;
    count += times;
    out.push(rep ? `${times}(${v.canonical})` : v.canonical);
  }
  if (count > arraySize(type)) return fail('TOO_LONG');
  return ok(out.join(', '));
}

export function parseLiteral(type: DataType, text: string): Result {
  if (type.kind === 'array') return parseArrayInitializer(type, text);
  if (type.kind === 'string') return parseString(type.length, text);
  const s = text.trim();
  if (type.kind === 'dateAndTime') return parseDateAndTime(s);
  if (type.kind !== 'elementary') return fail('NO_VALUE');
  switch (type.name) {
    case 'Bool':
      return parseBool(s);
    case 'Byte':
    case 'Word':
    case 'DWord':
      return parseBits(type.name, s);
    case 'Int':
      return parseInteger(s, 16, false);
    case 'DInt':
      return parseInteger(s, 32, true);
    case 'Real':
      return parseReal(s);
    case 'S5Time':
      return parseS5Time(s);
    case 'Time':
      return parseTime(s);
    case 'Date':
      return parseDate(s);
    case 'Time_Of_Day':
      return parseTimeOfDay(s);
    case 'Char':
      return parseChar(text);
  }
}

export function defaultLiteral(type: DataType): string | null {
  if (type.kind === 'string') return "''";
  if (type.kind === 'dateAndTime') return 'DT#1990-01-01-00:00:00.000';
  if (type.kind !== 'elementary') return null;
  switch (type.name) {
    case 'Bool':
      return 'false';
    case 'Byte':
    case 'Word':
    case 'DWord':
      return '16#0';
    case 'Int':
    case 'DInt':
      return '0';
    case 'Real':
      return '0.0';
    case 'S5Time':
      return 'S5T#0MS';
    case 'Time':
      return 'T#0MS';
    case 'Date':
      return 'D#1990-01-01';
    case 'Time_Of_Day':
      return 'TOD#00:00:00.000';
    case 'Char':
      return "' '";
  }
}
