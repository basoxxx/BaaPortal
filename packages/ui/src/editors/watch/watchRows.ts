// Tabelle di controllo: risoluzione delle righe, formati di visualizzazione e validazione dei valori di comando.
import type { WatchFormat, WatchResolution, WatchRow, WatchTarget } from '@baaportal/project';
import {
  MAX_WATCH_ITEMS,
  type WatchItem,
  type WatchValue,
  type WriteItemReq,
} from '../../sim/protocol';

type Size = WatchTarget['size'];
type Sign = 'signed' | 'unsigned' | 'any';

/** Un motivo da mostrare: chiave i18n (sotto `watch.err.`) e parametri. */
export interface WatchRowError {
  key: string;
  params?: Record<string, string>;
}
const err = (key: string, params?: Record<string, string>): WatchRowError => ({
  key,
  ...(params ? { params } : {}),
});

export const WATCH_FORMATS: readonly WatchFormat[] = [
  'BOOL',
  'DEC',
  'HEX',
  'BIN',
  'CHAR',
  'FLOAT',
  'S5TIME',
  'TIME',
  'BCD',
];

const BYTES: Record<Size, number> = { X: 1, B: 1, W: 2, D: 4 };

const FORMATS_BY_SIZE: Record<Size, readonly WatchFormat[]> = {
  X: ['BOOL'],
  B: ['HEX', 'DEC', 'BIN', 'CHAR', 'BCD'],
  W: ['DEC', 'HEX', 'BIN', 'S5TIME', 'BCD'],
  D: ['DEC', 'HEX', 'BIN', 'FLOAT', 'TIME', 'BCD'],
};

/** I formati ammessi per un operando di dimensione `size`. */
export const formatsFor = (size: Size): readonly WatchFormat[] => FORMATS_BY_SIZE[size];

// ---- Valori ------------------------------------------------------------------------------

const pad = (n: number, w: number) => n.toString(16).toUpperCase().padStart(w, '0');

function toUnsigned(bytes: Uint8Array): number {
  let v = 0;
  for (const b of bytes) v = v * 256 + b;
  return v;
}

function fromUnsigned(v: number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = v;
  for (let i = n - 1; i >= 0; i--) {
    out[i] = x % 256;
    x = Math.floor(x / 256);
  }
  return out;
}

function decRange(size: Size, sign: Sign): [number, number] {
  const bits = BYTES[size] * 8;
  const signed: [number, number] = [-(2 ** (bits - 1)), 2 ** (bits - 1) - 1];
  const unsigned: [number, number] = [0, 2 ** bits - 1];
  if (sign === 'signed') return signed;
  if (sign === 'unsigned') return unsigned;
  // Tipo non noto (indirizzo nudo): si accetta tutto ciò che sta nella dimensione.
  return [signed[0], unsigned[1]];
}

/** Il valore intero con il segno che il formato mostra (B senza segno; W e D con segno se non noto). */
function toDec(bytes: Uint8Array, size: Size, sign: Sign): number {
  const u = toUnsigned(bytes);
  const bits = BYTES[size] * 8;
  const signed = sign === 'signed' || (sign === 'any' && size !== 'B');
  return signed && u >= 2 ** (bits - 1) ? u - 2 ** bits : u;
}

const BCD_BASE_MS = [10, 100, 1000, 10000];

function bcdDigits(bytes: Uint8Array): string | null {
  let s = '';
  for (const b of bytes) {
    const hi = b >> 4;
    const lo = b & 15;
    if (hi > 9 || lo > 9) return null;
    s += `${hi}${lo}`;
  }
  return s;
}

/** Durata in ms come `1H30M5S250MS` (senza parti nulle; zero = `0MS`). */
function durationText(ms: number, withDays: boolean): string {
  let rest = Math.abs(ms);
  const parts: string[] = [];
  const units: [string, number][] = [
    ...(withDays ? ([['D', 86_400_000]] as [string, number][]) : []),
    ['H', 3_600_000],
    ['M', 60_000],
    ['S', 1000],
    ['MS', 1],
  ];
  for (const [u, size] of units) {
    const n = Math.floor(rest / size);
    rest -= n * size;
    if (n > 0) parts.push(`${n}${u}`);
  }
  return parts.length === 0 ? '0MS' : parts.join('');
}

function floatText(f: number): string {
  if (Number.isNaN(f)) return 'NaN';
  if (!Number.isFinite(f)) return f > 0 ? 'Inf' : '-Inf';
  return String(Number(f.toPrecision(8)));
}

export type FormattedValue = { text: string } | { error: WatchRowError };

/** Il testo di un valore grezzo nel formato dato. */
export function formatValue(
  bytes: Uint8Array,
  format: WatchFormat,
  size: Size,
  sign: Sign = 'any',
): FormattedValue {
  if (!formatsFor(size).includes(format)) return { error: err('FORMAT', { format }) };
  const n = BYTES[size];
  if (bytes.length !== n) return { error: err('LENGTH') };
  switch (format) {
    case 'BOOL':
      return { text: bytes[0] ? 'TRUE' : 'FALSE' };
    case 'DEC':
      return { text: String(toDec(bytes, size, sign)) };
    case 'HEX':
      return { text: `16#${pad(toUnsigned(bytes), n * 2)}` };
    case 'BIN': {
      const bits = toUnsigned(bytes)
        .toString(2)
        .padStart(n * 8, '0');
      return { text: `2#${bits.replace(/(.{4})(?=.)/g, '$1_')}` };
    }
    case 'CHAR': {
      const c = bytes[0]!;
      return { text: c >= 32 && c <= 126 ? `'${String.fromCharCode(c)}'` : `'\\x${pad(c, 2)}'` };
    }
    case 'FLOAT':
      return {
        text: floatText(new DataView(bytes.buffer, bytes.byteOffset, 4).getFloat32(0, false)),
      };
    case 'S5TIME': {
      const digits = bcdDigits(Uint8Array.of(bytes[0]! & 0x0f, bytes[1]!));
      if (!digits) return { error: err('BCD') };
      return {
        text: `S5T#${durationText(Number(digits) * BCD_BASE_MS[(bytes[0]! >> 4) & 3]!, false)}`,
      };
    }
    case 'TIME': {
      const ms = new DataView(bytes.buffer, bytes.byteOffset, 4).getInt32(0, false);
      return { text: `T#${ms < 0 ? '-' : ''}${durationText(ms, true)}` };
    }
    case 'BCD': {
      const digits = bcdDigits(bytes);
      if (!digits) return { error: err('BCD') };
      return { text: digits.replace(/^0+(?=\d)/, '') };
    }
  }
}

export type ParsedCommand = { ok: true; data: Uint8Array } | { ok: false; error: WatchRowError };
const fail = (key: string, params?: Record<string, string>): ParsedCommand => ({
  ok: false,
  error: err(key, params),
});

const DURATION = /^(\d+)(MS|D|H|M|S)(?:_)?/i;
const UNIT_MS: Record<string, number> = { D: 86_400_000, H: 3_600_000, M: 60_000, S: 1000, MS: 1 };
const UNIT_ORDER = ['D', 'H', 'M', 'S', 'MS'];

/** Durata `1H30M` in ms; null se la sintassi non è valida (unità ripetute o fuori ordine comprese). */
function parseDuration(body: string): number | null {
  let rest = body;
  let total = 0;
  let last = -1;
  if (rest === '') return null;
  while (rest !== '') {
    const m = DURATION.exec(rest);
    if (!m) return null;
    const unit = m[2]!.toUpperCase();
    const at = UNIT_ORDER.indexOf(unit);
    if (at <= last) return null;
    last = at;
    total += Number(m[1]) * UNIT_MS[unit]!;
    rest = rest.slice(m[0].length);
  }
  return total;
}

function bcdBytes(digits: string, n: number): Uint8Array {
  const padded = digits.padStart(n * 2, '0');
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (Number(padded[2 * i]) << 4) | Number(padded[2 * i + 1]);
  return out;
}

/** Valida il valore di comando per il formato e la dimensione e lo converte nei byte da scrivere. */
export function parseCommand(
  text: string,
  format: WatchFormat,
  size: Size,
  sign: Sign = 'any',
): ParsedCommand {
  if (!formatsFor(size).includes(format)) return fail('FORMAT', { format });
  const s = text.trim();
  const n = BYTES[size];
  switch (format) {
    case 'BOOL': {
      const u = s.toUpperCase();
      if (u === 'TRUE' || u === '1') return { ok: true, data: Uint8Array.of(1) };
      if (u === 'FALSE' || u === '0') return { ok: true, data: Uint8Array.of(0) };
      return fail('BOOL');
    }
    case 'DEC': {
      if (!/^[+-]?\d+$/.test(s)) return fail('SYNTAX');
      const v = Number(s);
      const [lo, hi] = decRange(size, sign);
      if (v < lo || v > hi) return fail('RANGE', { min: String(lo), max: String(hi) });
      return { ok: true, data: fromUnsigned(v < 0 ? v + 2 ** (n * 8) : v, n) };
    }
    case 'HEX': {
      const h = s.replace(/^16#/i, '');
      if (!/^[0-9a-f]+$/i.test(h)) return fail('SYNTAX');
      if (h.length > n * 2) return fail('RANGE', { min: '16#0', max: `16#${'F'.repeat(n * 2)}` });
      return { ok: true, data: fromUnsigned(parseInt(h, 16), n) };
    }
    case 'BIN': {
      const b = s.replace(/^2#/i, '').replace(/_/g, '');
      if (!/^[01]+$/.test(b)) return fail('SYNTAX');
      if (b.length > n * 8) return fail('RANGE', { min: '2#0', max: `2#${'1'.repeat(n * 8)}` });
      return { ok: true, data: fromUnsigned(parseInt(b, 2), n) };
    }
    case 'CHAR': {
      const m = /^'(.)'$/s.exec(s) ?? /^(.)$/s.exec(s);
      const hex = /^'\\x([0-9a-f]{2})'$/i.exec(s);
      const code = hex ? parseInt(hex[1]!, 16) : m ? m[1]!.charCodeAt(0) : -1;
      if (code < 0) return fail('SYNTAX');
      if (code > 255) return fail('RANGE', { min: '0', max: '255' });
      return { ok: true, data: Uint8Array.of(code) };
    }
    case 'FLOAT': {
      if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return fail('SYNTAX');
      const f = Math.fround(Number(s));
      if (!Number.isFinite(f)) return fail('RANGE', { min: '-3.4E38', max: '3.4E38' });
      const out = new Uint8Array(4);
      new DataView(out.buffer).setFloat32(0, f, false);
      return { ok: true, data: out };
    }
    case 'S5TIME': {
      const m = /^S5T#(.*)$/i.exec(s);
      const ms = m ? parseDuration(m[1]!) : null;
      if (ms === null) return fail('SYNTAX');
      // Risoluzione minima 10 ms; sopra 9,99 s solo multipli di 100 ms, sopra 99,9 s di 1 s...
      if (ms > 9_990_000) return fail('RANGE', { min: 'S5T#0MS', max: 'S5T#2H46M30S' });
      for (const [base, unit] of BCD_BASE_MS.entries()) {
        if (ms % unit === 0 && ms / unit <= 999) {
          const digits = String(ms / unit).padStart(3, '0');
          const b = bcdBytes(digits, 2);
          b[0]! |= base << 4;
          return { ok: true, data: b };
        }
      }
      return fail('S5_RESOLUTION');
    }
    case 'TIME': {
      const m = /^T#([+-]?)(.*)$/i.exec(s);
      const ms = m ? parseDuration(m[2]!) : null;
      if (!m || ms === null) return fail('SYNTAX');
      const v = m[1] === '-' ? -ms : ms;
      if (v < -(2 ** 31) || v > 2 ** 31 - 1) {
        return fail('RANGE', { min: 'T#-24D20H31M23S648MS', max: 'T#24D20H31M23S647MS' });
      }
      return { ok: true, data: fromUnsigned(v < 0 ? v + 2 ** 32 : v, 4) };
    }
    case 'BCD': {
      if (!/^\d+$/.test(s)) return fail('SYNTAX');
      if (s.length > n * 2) return fail('RANGE', { min: '0', max: '9'.repeat(n * 2) });
      return { ok: true, data: bcdBytes(s, n) };
    }
  }
}

// ---- Righe -------------------------------------------------------------------------------

export type RowInfo =
  | { ok: true; target: WatchTarget; format: WatchFormat; sign: Sign; formatError?: WatchRowError }
  | { ok: false; error: WatchRowError };

/** Risolve la riga: dove sta l'operando e se il formato scelto gli si addice. */
export function resolveRow(resolve: (text: string) => WatchResolution, row: WatchRow): RowInfo {
  const r = resolve(row.operand);
  if (!r.ok) {
    return {
      ok: false,
      error: err(`row.${r.code}`, r.detail === undefined ? undefined : { detail: r.detail }),
    };
  }
  const base = { ok: true as const, target: r.target, format: row.format, sign: r.sign };
  return formatsFor(r.target.size).includes(row.format)
    ? base
    : { ...base, formatError: err('FORMAT', { format: row.format }) };
}

/**
 * Risolve le righe. Oltre MAX_WATCH_ITEMS righe osservabili le successive hanno un errore
 * (`TOO_MANY`): la richiesta al simulatore non supera mai il suo limite, e non si ritenta.
 */
export function resolveRows(
  resolve: (text: string) => WatchResolution,
  rows: readonly WatchRow[],
): Map<string, RowInfo> {
  const out = new Map<string, RowInfo>();
  let observable = 0;
  for (const row of rows) {
    let info = resolveRow(resolve, row);
    if (info.ok && !info.formatError) {
      if (observable >= MAX_WATCH_ITEMS) info = { ok: false, error: err('TOO_MANY') };
      else observable++;
    }
    out.set(row.id, info);
  }
  return out;
}

/** Le righe osservabili (operando risolto e formato adatto) e le richieste `watch` corrispondenti. */
export function watchPlan(
  rows: readonly WatchRow[],
  infoOf: (row: WatchRow) => RowInfo,
): { rowIds: string[]; items: WatchItem[] } {
  const rowIds: string[] = [];
  const items: WatchItem[] = [];
  for (const row of rows) {
    const info = infoOf(row);
    if (!info.ok || info.formatError) continue;
    rowIds.push(row.id);
    items.push(info.target);
  }
  return { rowIds, items };
}

/** Il testo di stato di una riga dall'ultimo valore ricevuto. */
export function statusOf(info: RowInfo, value: WatchValue | undefined): FormattedValue | undefined {
  if (!info.ok) return { error: info.error };
  if (info.formatError) return { error: info.formatError };
  if (!value) return undefined;
  if ('error' in value) return { error: err('HOST', { message: value.error }) };
  return formatValue(value.bytes, info.format, info.target.size, info.sign);
}

export interface CommandPlan {
  /** Le richieste di scrittura, con la riga di ciascuna. */
  writes: { rowId: string; req: WriteItemReq }[];
  /** Le righe con comando non valido: il motivo. Le righe senza comando non compaiono. */
  errors: Record<string, WatchRowError>;
}

/** Le righe con un valore di comando: quelle valide diventano scritture, le altre un errore. */
export function planCommand(
  rows: readonly WatchRow[],
  infoOf: (row: WatchRow) => RowInfo,
): CommandPlan {
  const plan: CommandPlan = { writes: [], errors: {} };
  for (const row of rows) {
    const text = row.modify?.trim() ?? '';
    if (text === '') continue;
    const info = infoOf(row);
    if (!info.ok) {
      plan.errors[row.id] = info.error;
      continue;
    }
    if (info.formatError) {
      plan.errors[row.id] = info.formatError;
      continue;
    }
    if (info.target.area === 'T' || info.target.area === 'C') {
      plan.errors[row.id] = err('TC_WRITE');
      continue;
    }
    const parsed = parseCommand(text, info.format, info.target.size, info.sign);
    if (!parsed.ok) {
      plan.errors[row.id] = parsed.error;
      continue;
    }
    plan.writes.push({ rowId: row.id, req: { ...info.target, data: parsed.data } });
  }
  return plan;
}

/** L'indirizzo assoluto dell'operando risolto, per la colonna «Indirizzo». */
export function addressText(t: WatchTarget): string {
  if (t.area === 'T' || t.area === 'C') return `${t.area} ${t.byte}`;
  const bit = t.size === 'X' ? `.${t.bit ?? 0}` : '';
  if (t.area === 'DB') return `DB${t.db ?? '?'}.DB${t.size}${t.byte}${bit}`;
  return t.size === 'X' ? `${t.area} ${t.byte}${bit}` : `${t.area}${t.size} ${t.byte}`;
}
