import { readU16, readU32, writeU16, writeU32 } from '../bytes';
import { S7Error } from '../errors';
import { blockTypeCode, blockTypeFromCode, type BlockType } from './blocks';
import { decodeBlockTimestamp, encodeBlockTimestamp, type S7DateTime } from './clock';

/**
 * Formato del blocco trasferito con upload/download (proto §13). I byte di un blocco sono
 * opachi: queste funzioni leggono l'header e il footer, restituiscono copie e non modificano
 * l'ingresso. Il codice MC7 non viene mai interpretato (è il piano 1E).
 *
 * Layout verificato su blocchi reali (upload di cisa/snap7.pcap; blocchi dei download
 * s7comm_downloading_block_db1, step7_s300_download, tia_s300_downloadOb1,
 * tia_s300_downloadHwConfig, icspcap/4):
 *
 *   0   36  header: "pp" (2), attr (1), flag (1), linguaggio (1), tipo (1), numero (2),
 *           load length (4), security (4), timestamp codice (6), timestamp interfaccia (6),
 *           SSB (2), ADD (2), dati locali (2), MC7 (2)
 *   36  m   MC7 (m = MC7 length dell'header)
 *   …   r   rest: sezioni tra MC7 e footer, grezze (r = SSB length + ADD length)
 *   …   36  footer: autore (8), famiglia (8), nome (8), versione (1, nibble x.y),
 *           ignoto (1), checksum (2), riservato (8)
 *
 * Relazioni di lunghezza osservate su tutti i blocchi reali:
 *   load length = lunghezza dell'intero file = 36 + MC7 + (SSB + ADD) + 36
 *   (la lunghezza dati locali non occupa spazio nel file).
 * Il footer è sempre gli ultimi 36 byte; "rest" sono i byte tra MC7 e footer.
 */

export const BLOCK_HEADER_LENGTH = 36;
export const BLOCK_FOOTER_LENGTH = 36;

export interface BlockHeader {
  /** Byte a offset 2 (0x01 per OB/FB/FC/DB, 0x03 per gli SDB nelle catture). */
  attr: number;
  type: BlockType;
  number: number;
  language: number;
  flags: number;
  /** Lunghezza in memoria di caricamento = lunghezza del file (vedi sopra). */
  loadLength: number;
  security: number;
  codeTime: S7DateTime;
  interfaceTime: S7DateTime;
  ssbLength: number;
  addLength: number;
  localDataLength: number;
  mc7Length: number;
}

export interface BlockFooterRaw {
  /** Stringhe a 8 byte come sul filo (spazi o NUL di riempimento). */
  author: Uint8Array;
  family: Uint8Array;
  name: Uint8Array;
  /** Byte a offset 25 del footer. */
  unknown: number;
  /** Ultimi 8 byte del footer. */
  reserved: Uint8Array;
}

export interface BlockFooter {
  author: string;
  family: string;
  name: string;
  /** "x.y" dai nibble del byte di versione. */
  version: string;
  checksum: number;
  /** Byte esatti; se mancano `buildBlockFile` usa riempimento a NUL e zeri. */
  raw?: BlockFooterRaw;
}

export interface ParsedBlock {
  header: BlockHeader;
  mc7: Uint8Array;
  /** Byte tra MC7 e footer, grezzi (SSB + ADD nei blocchi reali). */
  rest: Uint8Array;
  /** `null` se dopo l'MC7 restano meno di 36 byte. */
  footer: BlockFooter | null;
}

function bad(msg: string): S7Error {
  return new S7Error('PROTOCOL', `blocco: ${msg}`);
}

function trimmed(b: Uint8Array): string {
  let end = b.length;
  while (end > 0 && (b[end - 1] === 0x20 || b[end - 1] === 0x00)) end--;
  let s = '';
  for (let i = 0; i < end; i++) s += String.fromCharCode(b[i]!);
  return s;
}

function time(b: Uint8Array, what: string): S7DateTime {
  try {
    return decodeBlockTimestamp(b);
  } catch (e) {
    if (e instanceof S7Error) throw bad(`timestamp ${what} non valido`);
    throw e;
  }
}

export function parseBlockFile(bytes: Uint8Array): ParsedBlock {
  if (bytes.length < BLOCK_HEADER_LENGTH) {
    throw bad(`${bytes.length} byte, meno dell'header di ${BLOCK_HEADER_LENGTH}`);
  }
  if (bytes[0] !== 0x70 || bytes[1] !== 0x70) throw bad('manca il magic "pp"');
  const type = blockTypeFromCode(bytes[5]!);
  if (!type) throw bad(`codice tipo 0x${bytes[5]!.toString(16)} sconosciuto`);
  const header: BlockHeader = {
    attr: bytes[2]!,
    type,
    number: readU16(bytes, 6),
    language: bytes[4]!,
    flags: bytes[3]!,
    loadLength: readU32(bytes, 8),
    security: readU32(bytes, 12),
    codeTime: time(bytes.subarray(16, 22), 'del codice'),
    interfaceTime: time(bytes.subarray(22, 28), "dell'interfaccia"),
    ssbLength: readU16(bytes, 28),
    addLength: readU16(bytes, 30),
    localDataLength: readU16(bytes, 32),
    mc7Length: readU16(bytes, 34),
  };
  const mc7End = BLOCK_HEADER_LENGTH + header.mc7Length;
  if (mc7End > bytes.length) {
    throw bad(`MC7 di ${header.mc7Length} byte oltre la fine del blocco (${bytes.length})`);
  }
  const mc7 = bytes.slice(BLOCK_HEADER_LENGTH, mc7End);
  const remainder = bytes.length - mc7End;
  if (remainder < BLOCK_FOOTER_LENGTH) {
    return { header, mc7, rest: bytes.slice(mc7End), footer: null };
  }
  const f = bytes.length - BLOCK_FOOTER_LENGTH;
  const ver = bytes[f + 24]!;
  const footer: BlockFooter = {
    author: trimmed(bytes.subarray(f, f + 8)),
    family: trimmed(bytes.subarray(f + 8, f + 16)),
    name: trimmed(bytes.subarray(f + 16, f + 24)),
    version: `${ver >> 4}.${ver & 15}`,
    checksum: readU16(bytes, f + 26),
    raw: {
      author: bytes.slice(f, f + 8),
      family: bytes.slice(f + 8, f + 16),
      name: bytes.slice(f + 16, f + 24),
      unknown: bytes[f + 25]!,
      reserved: bytes.slice(f + 28, f + 36),
    },
  };
  return { header, mc7, rest: bytes.slice(mc7End, f), footer };
}

function padded(s: string, raw: Uint8Array | undefined): Uint8Array {
  if (raw && trimmed(raw) === s) return raw;
  if (s.length > 8) throw new RangeError(`stringa "${s}" oltre 8 caratteri`);
  const out = new Uint8Array(8);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Per i test e il finto PLC. `loadLength` si calcola come nei blocchi reali (lunghezza del
 * file). Senza `rest` si riempie con zeri per SSB + ADD byte. `mc7Length` deve coincidere con
 * `mc7.length`.
 */
export function buildBlockFile(
  h: Omit<BlockHeader, 'loadLength' | 'attr'> & { attr?: number },
  mc7: Uint8Array,
  footer: BlockFooter,
  rest?: Uint8Array,
): Uint8Array {
  if (h.mc7Length !== mc7.length) {
    throw new RangeError(`mc7Length ${h.mc7Length} diverso da MC7 di ${mc7.length} byte`);
  }
  const r = rest ?? new Uint8Array(h.ssbLength + h.addLength);
  const m = /^([0-9a-f])\.([0-9a-f])$/i.exec(footer.version);
  if (!m) throw new RangeError(`versione "${footer.version}" non è x.y`);
  const total = BLOCK_HEADER_LENGTH + mc7.length + r.length + BLOCK_FOOTER_LENGTH;
  const out = new Uint8Array(total);
  out[0] = 0x70;
  out[1] = 0x70;
  out[2] = h.attr ?? 0x01;
  out[3] = h.flags;
  out[4] = h.language;
  out[5] = blockTypeCode(h.type);
  writeU16(out, 6, h.number);
  writeU32(out, 8, total);
  writeU32(out, 12, h.security);
  out.set(encodeBlockTimestamp(h.codeTime), 16);
  out.set(encodeBlockTimestamp(h.interfaceTime), 22);
  writeU16(out, 28, h.ssbLength);
  writeU16(out, 30, h.addLength);
  writeU16(out, 32, h.localDataLength);
  writeU16(out, 34, h.mc7Length);
  out.set(mc7, BLOCK_HEADER_LENGTH);
  out.set(r, BLOCK_HEADER_LENGTH + mc7.length);
  const f = total - BLOCK_FOOTER_LENGTH;
  const raw = footer.raw;
  out.set(padded(footer.author, raw?.author), f);
  out.set(padded(footer.family, raw?.family), f + 8);
  out.set(padded(footer.name, raw?.name), f + 16);
  out[f + 24] = (parseInt(m[1]!, 16) << 4) | parseInt(m[2]!, 16);
  out[f + 25] = raw?.unknown ?? 0;
  writeU16(out, f + 26, footer.checksum);
  if (raw) out.set(raw.reserved.subarray(0, 8), f + 28);
  return out;
}
