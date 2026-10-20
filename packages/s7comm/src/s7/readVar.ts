import { readU16, writeU16 } from '../bytes';
import { S7Error } from '../errors';
import { itemReturnName } from './errorCodes';

// Solo lettura: la funzione Write var (0x05) non è codificata né decodificata da questo modulo.

export type Area = 'P' | 'I' | 'Q' | 'M' | 'DB' | 'DI' | 'L' | 'V' | 'C' | 'T';
export type TransportSize =
  'BIT' | 'BYTE' | 'CHAR' | 'WORD' | 'INT' | 'DWORD' | 'DINT' | 'REAL' | 'COUNTER' | 'TIMER';

export interface ReadItem {
  area: Area;
  db: number;
  start: number;
  bit?: number;
  size: TransportSize;
  count: number;
}

/**
 * Risultato di un item. `transportSize` è il byte TS dei dati come sul filo (proto §5.7);
 * `rawLength` è il campo lunghezza grezzo (bit o byte secondo il TS), derivato dai dati se
 * assente. Negli item con errore TS e lunghezza grezzi sono conservati per il round trip
 * (una CPU reale risponde p.es. `0a 00 00 04`).
 */
export type ItemResult =
  | { ok: true; data: Uint8Array; transportSize: number; rawLength?: number }
  | { ok: false; returnCode: number; name: string; transportSize?: number; rawLength?: number };

const FN_READ = 0x04;
const RC_OK = 0xff;

/** Proto §5.4. */
const AREA_CODE: Record<Area, number> = {
  P: 0x80,
  I: 0x81,
  Q: 0x82,
  M: 0x83,
  DB: 0x84,
  DI: 0x85,
  L: 0x86,
  V: 0x87,
  C: 0x1c,
  T: 0x1d,
};
const CODE_AREA = new Map<number, Area>(
  (Object.entries(AREA_CODE) as [Area, number][]).map(([a, c]) => [c, a]),
);

/** Byte per elemento (proto §5.3, §5.8). BIT non ha una dimensione in byte intera. */
export const ELEMENT_BYTES: Record<Exclude<TransportSize, 'BIT'>, number> = {
  BYTE: 1,
  CHAR: 1,
  WORD: 2,
  INT: 2,
  DWORD: 4,
  DINT: 4,
  REAL: 4,
  COUNTER: 2,
  TIMER: 2,
};

/**
 * Byte di dati che una CPU restituisce per un item (verificato sulle catture reali:
 * INT x1 = 2, REAL x1 = 4, 8 timer = 16, BIT x1 = 1).
 */
export function itemByteLength(it: ReadItem): number {
  return it.size === 'BIT' ? Math.ceil(it.count / 8) : it.count * ELEMENT_BYTES[it.size];
}

/**
 * Transport size dei dati con cui una CPU reale risponde a un item (proto §5.7, verificato
 * sulle catture): timer e counter 0x09 (lunghezza in byte), BIT 0x03, REAL 0x07, INT 0x05,
 * tutto il resto 0x04 (lunghezza in bit).
 */
export function responseTransportFor(it: ReadItem): number {
  if (it.area === 'C' || it.area === 'T' || it.size === 'COUNTER' || it.size === 'TIMER')
    return 0x09;
  if (it.size === 'BIT') return 0x03;
  if (it.size === 'REAL') return 0x07;
  if (it.size === 'INT') return 0x05;
  return 0x04;
}

function bad(msg: string): S7Error {
  return new S7Error('PROTOCOL', `read var: ${msg}`);
}

function checkItem(it: ReadItem): void {
  if (!(it.area in AREA_CODE)) throw new RangeError(`area ${String(it.area)} non valida`);
  if (!Number.isInteger(it.count) || it.count < 1 || it.count > 0xffff) {
    throw new RangeError(`count ${it.count} fuori 1-65535`);
  }
  if (!Number.isInteger(it.db) || it.db < 0 || it.db > 0xffff) {
    throw new RangeError(`DB ${it.db} fuori 0-65535`);
  }
  if (!Number.isInteger(it.start) || it.start < 0)
    throw new RangeError(`start ${it.start} non valido`);
  const isCT = it.area === 'C' || it.area === 'T';
  if (it.start > (isCT ? 0xffffff : 0x1fffff))
    throw new RangeError(`start ${it.start} oltre lo spazio di indirizzi`);
  if (it.bit !== undefined && (!Number.isInteger(it.bit) || it.bit < 0 || it.bit > 7)) {
    throw new RangeError(`bit ${it.bit} fuori 0-7`);
  }
}

const SIZE_CODE: Record<TransportSize, number> = {
  BIT: 0x01,
  BYTE: 0x02,
  CHAR: 0x03,
  WORD: 0x04,
  INT: 0x05,
  DWORD: 0x06,
  DINT: 0x07,
  REAL: 0x08,
  COUNTER: 0x1c,
  TIMER: 0x1d,
};

/**
 * Item S7ANY a 12 byte (proto §5.2). Transport size e count sono emessi così come sono
 * (count in elementi di quel tipo); il nostro client usa BYTE (splitArea). L'indirizzo è
 * start*8+bit; per le aree C e T è il numero (proto §5.8).
 */
function encodeItem(it: ReadItem, out: Uint8Array, off: number): void {
  checkItem(it);
  const addr = it.area === 'C' || it.area === 'T' ? it.start : it.start * 8 + (it.bit ?? 0);
  out[off] = 0x12;
  out[off + 1] = 0x0a;
  out[off + 2] = 0x10;
  out[off + 3] = SIZE_CODE[it.size];
  writeU16(out, off + 4, it.count);
  writeU16(out, off + 6, it.db);
  out[off + 8] = AREA_CODE[it.area];
  out[off + 9] = (addr >>> 16) & 0xff;
  out[off + 10] = (addr >>> 8) & 0xff;
  out[off + 11] = addr & 0xff;
}

export function encodeReadRequest(items: ReadItem[]): Uint8Array {
  if (items.length < 1 || items.length > 255)
    throw new RangeError(`${items.length} item: fuori 1-255`);
  const out = new Uint8Array(2 + 12 * items.length);
  out[0] = FN_READ;
  out[1] = items.length;
  items.forEach((it, i) => encodeItem(it, out, 2 + 12 * i));
  return out;
}

const TS_DECODE: Record<number, TransportSize> = {
  0x01: 'BIT',
  0x02: 'BYTE',
  0x03: 'CHAR',
  0x04: 'WORD',
  0x05: 'INT',
  0x06: 'DWORD',
  0x07: 'DINT',
  0x08: 'REAL',
  0x1c: 'COUNTER',
  0x1d: 'TIMER',
};

export function decodeReadRequest(param: Uint8Array): ReadItem[] {
  if (param.length < 2) throw bad('parametro troppo corto');
  if (param[0] !== FN_READ) throw bad(`funzione 0x${param[0]!.toString(16)} diversa da 0x04`);
  const n = param[1]!;
  if (param.length < 2 + 12 * n) throw bad('item troncati');
  const items: ReadItem[] = [];
  for (let i = 0; i < n; i++) {
    const o = 2 + 12 * i;
    if (param[o] !== 0x12 || param[o + 1] !== 0x0a || param[o + 2] !== 0x10) {
      throw bad('item non in sintassi S7ANY');
    }
    const size = TS_DECODE[param[o + 3]!];
    if (size === undefined)
      throw bad(`transport size 0x${param[o + 3]!.toString(16)} non supportato`);
    const area = CODE_AREA.get(param[o + 8]!);
    if (area === undefined) throw bad(`area 0x${param[o + 8]!.toString(16)} non supportata`);
    const addr = (param[o + 9]! << 16) | (param[o + 10]! << 8) | param[o + 11]!;
    const item: ReadItem = {
      area,
      db: readU16(param, o + 6),
      start: 0,
      size,
      count: readU16(param, o + 4),
    };
    if (area === 'C' || area === 'T') {
      item.start = addr;
    } else {
      item.start = addr >>> 3;
      if (size === 'BIT' || (addr & 7) !== 0) item.bit = addr & 7;
    }
    items.push(item);
  }
  return items;
}

/** Lunghezza in byte di un item dati dal transport size (proto §5.7). */
function dataBytes(ts: number, len: number): number {
  switch (ts) {
    case 0x00:
      return 0;
    case 0x03:
    case 0x04:
    case 0x05:
      return Math.ceil(len / 8); // lunghezza in bit
    case 0x06:
    case 0x07:
    case 0x09:
      return len; // lunghezza in byte
    default:
      throw bad(`transport size dati 0x${ts.toString(16)} sconosciuto`);
  }
}

/** Lunghezza grezza di un item ok: bit per TS 0x04/0x05, 1 per 0x03 (un bit), byte per gli altri. */
function derivedLength(ts: number, n: number): number {
  if (ts === 0x04 || ts === 0x05) return n * 8;
  return n;
}

/**
 * Server side. Ogni item ok usa il suo `transportSize`; il padding è 0x00 tra item dispari
 * (proto §5.10). Gli item con errore escono come `rc ts len` con 4 byte e nessun dato.
 */
export function encodeReadResponse(results: ItemResult[]): { param: Uint8Array; data: Uint8Array } {
  if (results.length < 1 || results.length > 255)
    throw new RangeError(`${results.length} item: fuori 1-255`);
  let total = 0;
  results.forEach((r, i) => {
    const n = r.ok ? r.data.length : 0;
    total += 4 + n + (n % 2 === 1 && i < results.length - 1 ? 1 : 0);
  });
  const data = new Uint8Array(total);
  let o = 0;
  results.forEach((r, i) => {
    if (r.ok) {
      const len = r.rawLength ?? derivedLength(r.transportSize, r.data.length);
      if (len < 0 || len > 0xffff)
        throw new RangeError(`item da ${r.data.length} byte: lunghezza non codificabile`);
      data[o] = RC_OK;
      data[o + 1] = r.transportSize & 0xff;
      writeU16(data, o + 2, len);
      data.set(r.data, o + 4);
      o += 4 + r.data.length;
      if (r.data.length % 2 === 1 && i < results.length - 1) o += 1;
    } else {
      data[o] = r.returnCode & 0xff;
      data[o + 1] = (r.transportSize ?? 0) & 0xff;
      writeU16(data, o + 2, r.rawLength ?? 0);
      o += 4;
    }
  });
  return { param: Uint8Array.of(FN_READ, results.length), data };
}

export function decodeReadResponse(param: Uint8Array, data: Uint8Array): ItemResult[] {
  if (param.length < 2 || param[0] !== FN_READ) throw bad('parametro di risposta non valido');
  const n = param[1]!;
  const out: ItemResult[] = [];
  let o = 0;
  for (let i = 0; i < n; i++) {
    if (o + 4 > data.length) throw bad('item dati troncato');
    const rc = data[o]!;
    const ts = data[o + 1]!;
    const len = readU16(data, o + 2);
    if (rc !== RC_OK) {
      // Item con errore: 4 byte, nessun dato, TS e lunghezza arbitrari (le CPU reali mandano `0a 00 00 04`).
      out.push({
        ok: false,
        returnCode: rc,
        name: itemReturnName(rc),
        transportSize: ts,
        rawLength: len,
      });
      o += 4;
      continue;
    }
    const nb = dataBytes(ts, len);
    if (o + 4 + nb > data.length) throw bad('dati item oltre la parte dati');
    out.push({ ok: true, data: data.slice(o + 4, o + 4 + nb), transportSize: ts, rawLength: len });
    o += 4 + nb;
    if (nb % 2 === 1 && i < n - 1) o += 1;
  }
  return out;
}
