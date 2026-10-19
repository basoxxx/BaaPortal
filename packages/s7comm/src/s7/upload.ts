import { readU16, readU32, writeU16, writeU32 } from '../bytes';
import { S7Error } from '../errors';
import { blockTypeAscii, blockTypeFromAscii, type BlockType } from './blocks';

/**
 * Upload "carica dal dispositivo" (PLC → PG), proto §9: start upload 0x1D, upload 0x1E,
 * end upload 0x1F. Solo lettura: richieste lato PG e risposte lato CPU (per il finto PLC).
 * Nessuna funzione di download o di controllo.
 *
 * Strutture verificate sui byte reali (cisa/snap7.pcap), che correggono il testo di §9:
 * - richieste 0x1D/0x1E/0x1F: funzione (1) + stato (1) + ignoti (2) + upload-id (4);
 *   la 0x1D ha poi lunghezza del nome (1, = 9) + nome;
 * - risposta 0x1D: funzione, stato, ignoti (2: `01 00`), upload-id (4), lunghezza stringa (1),
 *   stringa ASCII decimale con la lunghezza totale ("0000216");
 * - risposta 0x1E: funzione + EoU (0 = ultimo pezzo, 1 = ne seguono); dati: lunghezza del
 *   pezzo (2, esclusi questi 4 byte) + `00 fb` + pezzo;
 * - risposta 0x1F: il solo byte di funzione.
 */

const F_START = 0x1d;
const F_UPLOAD = 0x1e;
const F_END = 0x1f;

function bad(msg: string): S7Error {
  return new S7Error('PROTOCOL', `upload: ${msg}`);
}

function ascii(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return s;
}

function uploadIdOk(id: number): void {
  if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) {
    throw new RangeError(`upload-id ${id} fuori 0-4294967295`);
  }
}

// ---- nome file (proto §9.1) -----------------------------------------------------------------

export type BlockFilesystem = 'A' | 'P' | 'B';

/** `'_'` + tipo ASCII (2) + numero a 5 cifre + lettera del filesystem, es. `_0A00001A`. */
export function blockFileName(type: BlockType, number: number, fs: BlockFilesystem): string {
  if (!Number.isInteger(number) || number < 0 || number > 99999) {
    throw new RangeError(`numero blocco ${number} fuori 0-99999`);
  }
  if (fs !== 'A' && fs !== 'P' && fs !== 'B') {
    throw new RangeError(`filesystem "${String(fs)}" diverso da A, P, B`);
  }
  return `_${blockTypeAscii(type)}${String(number).padStart(5, '0')}${fs}`;
}

export function parseBlockFileName(name: string): {
  type: BlockType;
  number: number;
  filesystem: string;
} {
  const m = /^_([0-9A-F]{2})([0-9]{5})([A-Z])$/.exec(name);
  const type = m ? blockTypeFromAscii(m[1]!) : undefined;
  if (!m || !type) throw bad(`nome file "${name}" non è _TTNNNNNF con un tipo noto`);
  return { type, number: Number(m[2]), filesystem: m[3]! };
}

// ---- richieste: funzione + stato + ignoti(2) + upload-id(4) ----------------------------------

function idRequest(fn: number, uploadId: number): Uint8Array {
  uploadIdOk(uploadId);
  const out = new Uint8Array(8);
  out[0] = fn;
  writeU32(out, 4, uploadId);
  return out;
}

function decodeIdRequest(fn: number, name: string, p: Uint8Array): number {
  if (p.length !== 8) throw bad(`${name}: ${p.length} byte invece di 8`);
  if (p[0] !== fn) throw bad(`${name}: funzione 0x${p[0]!.toString(16)}`);
  return readU32(p, 4);
}

// ---- start upload 0x1D -----------------------------------------------------------------------

/** Param della richiesta (PG → CPU): upload-id 0, nome file `_TTNNNNNF`. */
export function encodeStartUpload(fileName: string): Uint8Array {
  if (!/^_[0-9A-F]{2}[0-9]{5}[A-Z]$/.test(fileName)) {
    throw new RangeError(`nome file "${fileName}" non è _TTNNNNNF`);
  }
  const out = new Uint8Array(18);
  out[0] = F_START;
  out[8] = fileName.length;
  for (let i = 0; i < fileName.length; i++) out[9 + i] = fileName.charCodeAt(i);
  return out;
}

/** Lato finto PLC. Il nome è restituito come sul filo (ASCII), senza altra convalida. */
export function decodeStartUpload(param: Uint8Array): { fileName: string; uploadId: number } {
  if (param.length < 9) throw bad(`start upload di ${param.length} byte, meno di 9`);
  if (param[0] !== F_START) throw bad(`start upload con funzione 0x${param[0]!.toString(16)}`);
  if (param[8] !== param.length - 9) {
    throw bad(`lunghezza del nome ${param[8]} <> ${param.length - 9} byte disponibili`);
  }
  // il nome si restituisce com'è (Latin-1): sarà parseBlockFileName a giudicarlo
  return { fileName: ascii(param.subarray(9)), uploadId: readU32(param, 4) };
}

export interface StartUploadResponse {
  uploadId: number;
  /** Lunghezza totale del blocco; `null` se la stringa manca o non è un numero decimale. */
  totalLength: number | null;
  /** Stringa come sul filo (`null` se assente), per il round trip. */
  lengthString: string | null;
  /** Byte di stato (offset 1). */
  status: number;
  /** Ignoti, offset 2-3 (di norma `01 00`). */
  unknown: Uint8Array;
}

/** Non lancia mai sul contenuto della stringa; solo struttura troncata o funzione diversa. */
export function decodeStartUploadResponse(param: Uint8Array): StartUploadResponse {
  if (param.length < 8) throw bad(`risposta start upload di ${param.length} byte, meno di 8`);
  if (param[0] !== F_START)
    throw bad(`risposta start upload con funzione 0x${param[0]!.toString(16)}`);
  let lengthString: string | null = null;
  if (param.length > 8) {
    const n = param[8]!;
    if (9 + n !== param.length)
      throw bad(`stringa lunghezza di ${n} byte in ${param.length - 9} disponibili`);
    lengthString = ascii(param.subarray(9));
  }
  let totalLength: number | null = null;
  const digits = lengthString?.replace(/[\0 ]+$/, '');
  if (digits !== undefined && /^[0-9]{1,15}$/.test(digits)) totalLength = Number(digits);
  return {
    uploadId: readU32(param, 4),
    totalLength,
    lengthString,
    status: param[1]!,
    unknown: param.slice(2, 4),
  };
}

/** Risposta della CPU: stringa a 7 cifre come nelle CPU reali; `opts` per i byte esatti. */
export function encodeStartUploadResponse(
  uploadId: number,
  totalLength: number,
  opts: { status?: number; unknown?: Uint8Array; lengthString?: string | null } = {},
): Uint8Array {
  uploadIdOk(uploadId);
  if (!Number.isInteger(totalLength) || totalLength < 0) {
    throw new RangeError(`lunghezza totale ${totalLength} non valida`);
  }
  if (opts.unknown && opts.unknown.length !== 2) throw new RangeError('unknown di 2 byte');
  const str =
    opts.lengthString === null ? null : (opts.lengthString ?? String(totalLength).padStart(7, '0'));
  if (str !== null && str.length > 255) throw new RangeError('stringa lunghezza oltre 255 byte');
  const out = new Uint8Array(str === null ? 8 : 9 + str.length);
  out[0] = F_START;
  out[1] = opts.status ?? 0;
  out.set(opts.unknown ?? Uint8Array.of(0x01, 0x00), 2);
  writeU32(out, 4, uploadId);
  if (str !== null) {
    out[8] = str.length;
    for (let i = 0; i < str.length; i++) out[9 + i] = str.charCodeAt(i) & 0xff;
  }
  return out;
}

// ---- upload 0x1E -----------------------------------------------------------------------------

export function encodeUpload(uploadId: number): Uint8Array {
  return idRequest(F_UPLOAD, uploadId);
}

export function decodeUploadRequest(param: Uint8Array): { uploadId: number } {
  return { uploadId: decodeIdRequest(F_UPLOAD, 'upload', param) };
}

export interface UploadResponse {
  /** EoU: `true` se ne seguono altri pezzi (qualunque valore diverso da 0). */
  more: boolean;
  /** Byte EoU come sul filo. */
  eou: number;
  /** Il pezzo di blocco, dopo l'header dati di 4 byte. */
  chunk: Uint8Array;
  /** I 2 byte dopo la lunghezza nell'header dati (di norma `00 fb`), grezzi. */
  dataHeader: Uint8Array;
}

export function decodeUploadResponse(param: Uint8Array, data: Uint8Array): UploadResponse {
  if (param.length !== 2) throw bad(`risposta upload di ${param.length} byte invece di 2`);
  if (param[0] !== F_UPLOAD) throw bad(`risposta upload con funzione 0x${param[0]!.toString(16)}`);
  if (data.length < 4) throw bad("dati upload più corti dell'header di 4 byte");
  const len = readU16(data, 0);
  if (len !== data.length - 4) throw bad(`lunghezza del pezzo ${len} <> ${data.length - 4}`);
  return {
    more: param[1] !== 0,
    eou: param[1]!,
    chunk: data.slice(4),
    dataHeader: data.slice(2, 4),
  };
}

export function encodeUploadResponse(
  more: boolean,
  chunk: Uint8Array,
  dataHeader: Uint8Array = Uint8Array.of(0x00, 0xfb),
  eou?: number,
): { param: Uint8Array; data: Uint8Array } {
  if (chunk.length > 0xffff) throw new RangeError('pezzo oltre 65535 byte');
  if (dataHeader.length !== 2) throw new RangeError('header dati di 2 byte');
  const data = new Uint8Array(4 + chunk.length);
  writeU16(data, 0, chunk.length);
  data.set(dataHeader, 2);
  data.set(chunk, 4);
  return { param: Uint8Array.of(F_UPLOAD, eou ?? (more ? 1 : 0)), data };
}

// ---- end upload 0x1F -------------------------------------------------------------------------

export function encodeEndUpload(uploadId: number): Uint8Array {
  return idRequest(F_END, uploadId);
}

export function decodeEndUpload(param: Uint8Array): { uploadId: number } {
  return { uploadId: decodeIdRequest(F_END, 'end upload', param) };
}

/** Risposta della CPU: il solo byte di funzione. */
export function encodeEndUploadResponse(): Uint8Array {
  return Uint8Array.of(F_END);
}

export function decodeEndUploadResponse(param: Uint8Array): void {
  if (param.length !== 1 || param[0] !== F_END)
    throw bad('risposta end upload non è il solo byte 0x1f');
}
