import { readU16, readU32, writeU16, writeU32 } from '../bytes';
import { S7Error } from '../errors';
import { decodeBlockTimestamp, encodeBlockTimestamp, type S7DateTime } from './clock';

export type BlockType = 'OB' | 'DB' | 'SDB' | 'FC' | 'SFC' | 'FB' | 'SFB';

function bad(msg: string): S7Error {
  return new S7Error('PROTOCOL', `blocchi: ${msg}`);
}

/** Codici di tipo (proto §8.4): ASCII a due caratteri nelle liste, binario in block info. */
const ASCII: Record<BlockType, string> = {
  OB: '08',
  DB: '0A',
  SDB: '0B',
  FC: '0C',
  SFC: '0D',
  FB: '0E',
  SFB: '0F',
};
const BINARY: Record<BlockType, number> = {
  OB: 0x08,
  DB: 0x0a,
  SDB: 0x0b,
  FC: 0x0c,
  SFC: 0x0d,
  FB: 0x0e,
  SFB: 0x0f,
};
/** Ordine in cui le CPU elencano i conteggi (verificato sulle catture). */
const COUNT_ORDER: BlockType[] = ['OB', 'FB', 'FC', 'DB', 'SDB', 'SFC', 'SFB'];

const FROM_ASCII = new Map<string, BlockType>(
  (Object.entries(ASCII) as [BlockType, string][]).map(([t, a]) => [a, t]),
);
const FROM_BINARY = new Map<number, BlockType>(
  (Object.entries(BINARY) as [BlockType, number][]).map(([t, c]) => [c, t]),
);

export function blockTypeAscii(t: BlockType): string {
  return ASCII[t];
}

function putAscii(out: Uint8Array, off: number, s: string): void {
  for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i);
}

function getAscii(b: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[off + i]!);
  return s;
}

function typeFromAscii(b: Uint8Array, off: number): BlockType | undefined {
  return FROM_ASCII.get(getAscii(b, off, 2));
}

/** Nomi dei codici linguaggio (proto §8.5). */
export function blockLanguageName(code: number): string {
  const names: Record<number, string> = {
    0x00: 'non definito',
    0x01: 'AWL',
    0x02: 'KOP',
    0x03: 'FUP',
    0x04: 'SCL',
    0x05: 'DB',
    0x06: 'GRAPH',
    0x07: 'SDB',
    0x08: 'CPU-DB',
    0x11: 'SDB (reset)',
    0x12: 'SDB (routing)',
    0x29: 'ENCRYPT',
  };
  return names[code] ?? `0x${code.toString(16)}`;
}

// ---- conteggi (subfunction 1) --------------------------------------------------------------

/** Record da 4 byte: tipo ASCII (2) + conteggio (2). I tipi non elencati valgono 0; gli ignoti sono ignorati. */
export function decodeBlockCounts(payload: Uint8Array): Record<BlockType, number> {
  if (payload.length % 4 !== 0) throw bad('conteggi non multipli di 4 byte');
  const out: Record<BlockType, number> = { OB: 0, DB: 0, SDB: 0, FC: 0, SFC: 0, FB: 0, SFB: 0 };
  for (let o = 0; o < payload.length; o += 4) {
    const t = typeFromAscii(payload, o);
    if (t) out[t] = readU16(payload, o + 2);
  }
  return out;
}

export function encodeBlockCounts(c: Record<BlockType, number>): Uint8Array {
  const out = new Uint8Array(COUNT_ORDER.length * 4);
  COUNT_ORDER.forEach((t, i) => {
    putAscii(out, i * 4, ASCII[t]);
    writeU16(out, i * 4 + 2, c[t]);
  });
  return out;
}

// ---- lista per tipo (subfunction 2) --------------------------------------------------------

export interface BlockListEntry {
  number: number;
  flags: number;
  language: number;
}

export function encodeBlockListOfTypeRequest(t: BlockType): Uint8Array {
  const out = new Uint8Array(2);
  putAscii(out, 0, ASCII[t]);
  return out;
}

export function decodeBlockListOfTypeRequest(payload: Uint8Array): BlockType {
  if (payload.length !== 2) throw bad('richiesta di lista per tipo non di 2 byte');
  const t = typeFromAscii(payload, 0);
  if (!t) throw bad('tipo di blocco sconosciuto');
  return t;
}

/** Ricompone i pezzi (proto §8.2): record da 4 byte = numero (2), flag (1), linguaggio (1). */
export function decodeBlockListOfType(payloads: Uint8Array[]): BlockListEntry[] {
  const out: BlockListEntry[] = [];
  let carry = 0;
  for (const p of payloads) carry += p.length;
  if (carry % 4 !== 0) throw bad('lista per tipo non multipla di 4 byte');
  for (const p of payloads) {
    if (p.length % 4 !== 0) throw bad('pezzo della lista per tipo non multiplo di 4 byte');
    for (let o = 0; o < p.length; o += 4) {
      out.push({ number: readU16(p, o), flags: p[o + 2]!, language: p[o + 3]! });
    }
  }
  return out;
}

/** Pezzi di al più `maxPayload` byte, tagliati sui confini di record. */
export function encodeBlockListOfType(list: BlockListEntry[], maxPayload: number): Uint8Array[] {
  const per = Math.floor(maxPayload / 4);
  if (!Number.isInteger(maxPayload) || per < 1)
    throw new RangeError(`maxPayload ${maxPayload} sotto 4`);
  const out: Uint8Array[] = [];
  for (let i = 0; i === 0 || i < list.length; i += per) {
    const part = list.slice(i, i + per);
    const b = new Uint8Array(part.length * 4);
    part.forEach((e, j) => {
      writeU16(b, j * 4, e.number);
      b[j * 4 + 2] = e.flags;
      b[j * 4 + 3] = e.language;
    });
    out.push(b);
  }
  return out;
}

// ---- info blocco (subfunction 3) -----------------------------------------------------------

/** Richiesta: tipo ASCII (2) + numero in 5 cifre ASCII + lettera del filesystem (proto §8.3). */
export function encodeBlockInfoRequest(
  t: BlockType,
  number: number,
  filesystem: string,
): Uint8Array {
  if (!Number.isInteger(number) || number < 0 || number > 99999) {
    throw new RangeError(`numero blocco ${number} fuori 0-99999`);
  }
  if (!/^[A-Z]$/.test(filesystem))
    throw new RangeError(`filesystem "${filesystem}" non è una lettera`);
  const out = new Uint8Array(8);
  putAscii(out, 0, ASCII[t]);
  putAscii(out, 2, String(number).padStart(5, '0'));
  putAscii(out, 7, filesystem);
  return out;
}

export function decodeBlockInfoRequest(payload: Uint8Array): {
  type: BlockType;
  number: number;
  filesystem: string;
} {
  if (payload.length !== 8) throw bad('richiesta info blocco non di 8 byte');
  const t = typeFromAscii(payload, 0);
  if (!t) throw bad('tipo di blocco sconosciuto');
  const digits = getAscii(payload, 2, 5);
  if (!/^[0-9]{5}$/.test(digits)) throw bad('numero blocco non in cifre ASCII');
  const fs = getAscii(payload, 7, 1);
  if (!/^[A-Z]$/.test(fs)) throw bad('lettera del filesystem non valida');
  return { type: t, number: Number(digits), filesystem: fs };
}

/**
 * Campi della risposta che il documento non spiega o che servono solo al round trip
 * (byte esatti di una CPU reale). Se mancano, `encodeBlockInfo` usa i valori tipici.
 */
export interface BlockInfoRaw {
  /** Payload originale completo. */
  bytes?: Uint8Array;
  /** Offset 0-1. */
  word0?: number;
  /** Offset 2-3, lunghezza delle informazioni. */
  infoLength?: number;
  /** Offset 4-5. */
  unknown2?: number;
  /** Offset 6-7, di norma `pp`. */
  magic?: number;
  /** Offset 8. */
  unknown8?: number;
  /** Offset 67. */
  unknown67?: number;
  /** Offset 70-73 e 74-77. */
  reserved1?: number;
  reserved2?: number;
  /** Timestamp a 6 byte come sul filo (offset 22 e 28). */
  codeTime?: Uint8Array;
  interfaceTime?: Uint8Array;
  /** Stringhe a 8 byte come sul filo: le CPU riempiono con spazi o con NUL (offset 42, 50, 58). */
  author?: Uint8Array;
  family?: Uint8Array;
  name?: Uint8Array;
}

/**
 * Informazioni di blocco. `typeCode` è il byte di sottotipo come sul filo; `type` è assente se
 * il codice è sconosciuto. Gli altri campi mancano se il payload è più corto di 78 byte
 * (decodifica "campo per campo") o, per i timestamp, se non sono una data valida; `raw.bytes`
 * conserva sempre il payload originale.
 */
export interface BlockInfo {
  typeCode?: number;
  type?: BlockType;
  number?: number;
  language?: number;
  flags?: number;
  loadLength?: number;
  security?: number;
  codeTime?: S7DateTime;
  interfaceTime?: S7DateTime;
  ssbLength?: number;
  addLength?: number;
  localDataLength?: number;
  mc7Length?: number;
  author?: string;
  family?: string;
  name?: string;
  /** "x.y" dai nibble. */
  version?: string;
  checksum?: number;
  raw?: BlockInfoRaw;
}

const INFO_LENGTH = 78;

function trimmed(b: Uint8Array): string {
  let end = b.length;
  while (end > 0 && (b[end - 1] === 0x20 || b[end - 1] === 0x00)) end--;
  let s = '';
  for (let i = 0; i < end; i++) s += String.fromCharCode(b[i]!);
  return s;
}

function tryTime(b: Uint8Array): S7DateTime | undefined {
  try {
    return decodeBlockTimestamp(b);
  } catch (e) {
    if (e instanceof S7Error) return undefined;
    throw e;
  }
}

/** Decodifica i campi che stanno nel payload; non lancia mai sul contenuto. */
export function decodeBlockInfo(p: Uint8Array): BlockInfo {
  const fits = (off: number, len: number): boolean => off + len <= p.length;
  const u16 = (off: number): number | undefined => (fits(off, 2) ? readU16(p, off) : undefined);
  const u32 = (off: number): number | undefined => (fits(off, 4) ? readU32(p, off) : undefined);
  const u8 = (off: number): number | undefined => (fits(off, 1) ? p[off] : undefined);
  const str = (off: number): string | undefined =>
    fits(off, 8) ? trimmed(p.subarray(off, off + 8)) : undefined;
  const out: BlockInfo = {};
  const set = <K extends keyof BlockInfo>(k: K, v: BlockInfo[K] | undefined): void => {
    if (v !== undefined) out[k] = v;
  };
  const code = u8(11);
  set('typeCode', code);
  if (code !== undefined) set('type', FROM_BINARY.get(code));
  set('number', u16(12));
  set('language', u8(10));
  set('flags', u8(9));
  set('loadLength', u32(14));
  set('security', u32(18));
  if (fits(22, 6)) set('codeTime', tryTime(p.subarray(22, 28)));
  if (fits(28, 6)) set('interfaceTime', tryTime(p.subarray(28, 34)));
  set('ssbLength', u16(34));
  set('addLength', u16(36));
  set('localDataLength', u16(38));
  set('mc7Length', u16(40));
  set('author', str(42));
  set('family', str(50));
  set('name', str(58));
  const ver = u8(66);
  if (ver !== undefined) out.version = `${ver >> 4}.${ver & 15}`;
  set('checksum', u16(68));
  out.raw = {
    bytes: p.slice(),
    word0: u16(0),
    infoLength: u16(2),
    unknown2: u16(4),
    magic: u16(6),
    unknown8: u8(8),
    unknown67: u8(67),
    reserved1: u32(70),
    reserved2: u32(74),
    codeTime: fits(22, 6) ? p.slice(22, 28) : undefined,
    interfaceTime: fits(28, 6) ? p.slice(28, 34) : undefined,
    author: fits(42, 8) ? p.slice(42, 50) : undefined,
    family: fits(50, 8) ? p.slice(50, 58) : undefined,
    name: fits(58, 8) ? p.slice(58, 66) : undefined,
  };
  return out;
}

function padded(s: string, raw: Uint8Array | undefined): Uint8Array {
  if (raw && trimmed(raw) === s) return raw;
  if (s.length > 8) throw new RangeError(`stringa "${s}" oltre 8 caratteri`);
  const out = new Uint8Array(8);
  putAscii(out, 0, s);
  return out;
}

/**
 * 78 byte. Un `BlockInfo` uscito da un payload di lunghezza diversa si ricodifica restituendo
 * quel payload (`raw.bytes`). Per il finto PLC servono almeno `type` e `number`.
 */
export function encodeBlockInfo(i: BlockInfo): Uint8Array {
  const r = i.raw ?? {};
  if (r.bytes && r.bytes.length !== INFO_LENGTH) return r.bytes.slice();
  const code = i.type !== undefined ? BINARY[i.type] : i.typeCode;
  if (code === undefined) throw new RangeError('block info senza type né typeCode');
  const m = /^([0-9a-f])\.([0-9a-f])$/i.exec(i.version ?? '0.0');
  if (!m) throw new RangeError(`versione "${i.version}" non è x.y`);
  const zero = { year: 1984, month: 1, day: 1, hour: 0, minute: 0, second: 0, ms: 0 };
  const out = new Uint8Array(INFO_LENGTH);
  writeU16(out, 0, r.word0 ?? 0);
  writeU16(out, 2, r.infoLength ?? 0x4a);
  writeU16(out, 4, r.unknown2 ?? 0x2200);
  writeU16(out, 6, r.magic ?? 0x7070);
  out[8] = r.unknown8 ?? 0x01;
  out[9] = i.flags ?? 0;
  out[10] = i.language ?? 0;
  out[11] = code;
  writeU16(out, 12, i.number ?? 0);
  writeU32(out, 14, i.loadLength ?? 0);
  writeU32(out, 18, i.security ?? 0);
  out.set(r.codeTime ?? encodeBlockTimestamp(i.codeTime ?? zero), 22);
  out.set(r.interfaceTime ?? encodeBlockTimestamp(i.interfaceTime ?? zero), 28);
  writeU16(out, 34, i.ssbLength ?? 0);
  writeU16(out, 36, i.addLength ?? 0);
  writeU16(out, 38, i.localDataLength ?? 0);
  writeU16(out, 40, i.mc7Length ?? 0);
  out.set(padded(i.author ?? '', r.author), 42);
  out.set(padded(i.family ?? '', r.family), 50);
  out.set(padded(i.name ?? '', r.name), 58);
  out[66] = (parseInt(m[1]!, 16) << 4) | parseInt(m[2]!, 16);
  out[67] = r.unknown67 ?? 0;
  writeU16(out, 68, i.checksum ?? 0);
  writeU32(out, 70, r.reserved1 ?? 0);
  writeU32(out, 74, r.reserved2 ?? 0);
  return out;
}
