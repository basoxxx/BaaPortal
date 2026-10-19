import { S7Error } from '../errors';

/** Data e ora S7. `weekday`: 1 = domenica ... 7 = sabato. */
export interface S7DateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
  weekday?: number;
}

function bad(msg: string): S7Error {
  return new S7Error('PROTOCOL', `ora S7: ${msg}`);
}

function bcd(v: number, what: string): number {
  const hi = v >> 4;
  const lo = v & 15;
  if (hi > 9 || lo > 9) throw bad(`${what}: 0x${v.toString(16)} non è BCD`);
  return hi * 10 + lo;
}

function toBcd(v: number): number {
  return ((Math.floor(v / 10) % 10) << 4) | (v % 10);
}

function check(t: S7DateTime): void {
  const ok = (v: number, lo: number, hi: number): boolean =>
    Number.isInteger(v) && v >= lo && v <= hi;
  if (!ok(t.year, 1990, 2089)) throw bad(`anno ${t.year} fuori 1990-2089`);
  if (!ok(t.month, 1, 12)) throw bad(`mese ${t.month} fuori 1-12`);
  if (!ok(t.day, 1, 31)) throw bad(`giorno ${t.day} fuori 1-31`);
  if (!ok(t.hour, 0, 23)) throw bad(`ora ${t.hour} fuori 0-23`);
  if (!ok(t.minute, 0, 59)) throw bad(`minuto ${t.minute} fuori 0-59`);
  if (!ok(t.second, 0, 59)) throw bad(`secondo ${t.second} fuori 0-59`);
  if (!ok(t.ms, 0, 999)) throw bad(`millisecondi ${t.ms} fuori 0-999`);
  if (t.weekday !== undefined && !ok(t.weekday, 0, 7)) throw bad(`giorno settimana ${t.weekday}`);
}

/**
 * Timestamp BCD (proto §12.1). 10 byte: `00 19` + 8 byte; la forma corta di 8 byte (buffer
 * diagnostico) omette i primi due. Anno: 90-99 = 199x, 00-89 = 20xx.
 */
export function decodeBcdDateTime(b: Uint8Array): S7DateTime {
  if (b.length !== 8 && b.length !== 10) throw bad(`${b.length} byte invece di 8 o 10`);
  const o = b.length - 8;
  const yy = bcd(b[o]!, 'anno');
  const t: S7DateTime = {
    year: yy >= 90 ? 1900 + yy : 2000 + yy,
    month: bcd(b[o + 1]!, 'mese'),
    day: bcd(b[o + 2]!, 'giorno'),
    hour: bcd(b[o + 3]!, 'ora'),
    minute: bcd(b[o + 4]!, 'minuto'),
    second: bcd(b[o + 5]!, 'secondo'),
    ms: bcd(b[o + 6]!, 'ms') * 10 + (b[o + 7]! >> 4),
    weekday: b[o + 7]! & 15,
  };
  if (b[o + 7]! >> 4 > 9) throw bad('cifra dei ms non BCD');
  check(t);
  return t;
}

/** 8 byte, senza i due byte iniziali. */
export function encodeBcdDateTimeShort(t: S7DateTime): Uint8Array {
  check(t);
  return Uint8Array.of(
    toBcd(t.year % 100),
    toBcd(t.month),
    toBcd(t.day),
    toBcd(t.hour),
    toBcd(t.minute),
    toBcd(t.second),
    toBcd(Math.floor(t.ms / 10)),
    ((t.ms % 10) << 4) | (t.weekday ?? 0),
  );
}

/** 10 byte: `00 19` fissi come mandano le CPU reali, poi la forma corta. */
export function encodeBcdDateTime(t: S7DateTime): Uint8Array {
  const out = new Uint8Array(10);
  out[1] = 0x19;
  out.set(encodeBcdDateTimeShort(t), 2);
  return out;
}

const MS_DAY = 86_400_000;
const EPOCH_1984 = Date.UTC(1984, 0, 1);

/** Timestamp di blocco a 6 byte (proto §8.3, §13): ms dalla mezzanotte (4) + giorni dal 1984-01-01 (2). */
export function decodeBlockTimestamp(b: Uint8Array): S7DateTime {
  if (b.length !== 6) throw bad(`timestamp di blocco di ${b.length} byte invece di 6`);
  const ms = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  const days = (b[4]! << 8) | b[5]!;
  if (ms >= MS_DAY) throw bad(`ms dalla mezzanotte ${ms} oltre un giorno`);
  const d = new Date(EPOCH_1984 + days * MS_DAY);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: Math.floor(ms / 3_600_000),
    minute: Math.floor(ms / 60_000) % 60,
    second: Math.floor(ms / 1000) % 60,
    ms: ms % 1000,
    weekday: d.getUTCDay() + 1,
  };
}

export function encodeBlockTimestamp(t: S7DateTime): Uint8Array {
  const days = Math.round((Date.UTC(t.year, t.month - 1, t.day) - EPOCH_1984) / MS_DAY);
  if (!Number.isInteger(days) || days < 0 || days > 0xffff)
    throw bad('data fuori dal formato dei blocchi');
  const ms = ((t.hour * 60 + t.minute) * 60 + t.second) * 1000 + t.ms;
  return Uint8Array.of(
    ms >>> 24,
    (ms >>> 16) & 255,
    (ms >>> 8) & 255,
    ms & 255,
    days >> 8,
    days & 255,
  );
}
