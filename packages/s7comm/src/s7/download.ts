import { readU16, writeU16 } from '../bytes';
import { S7Error } from '../errors';
import { type BlockType } from './blocks';
import { blockFileName, parseBlockFileName, type BlockFilesystem } from './upload';

/**
 * Download "scrivi sul dispositivo" (PG → PLC), proto §10.1-§10.3: request download 0x1A, download
 * block 0x1B (job ROSCTR 1 inviato dalla CPU, risposta ack-data del PG), download ended 0x1C.
 * Solo codifica/decodifica dei frame: la sequenza sta nel client.
 *
 * Layout verificati sui byte reali (`s7comm_downloading_block_db1.pcap`):
 * - 0x1A: `1a 00 01 00 00 00 00 00` + len `09` + nome `_TTNNNNNF` + len `0d` + `'1'` + load memory
 *   (6 cifre ASCII) + MC7 (6 cifre ASCII);
 * - job 0x1B / 0x1C: funzione + 7 byte (zero) + len `09` + nome;
 * - ack-data 0x1B: `1b` + EoS (`01` ne seguono, `00` ultimo); dati: lunghezza (2) + `00 fb` + fetta.
 */

const F_REQUEST = 0x1a;
const F_BLOCK = 0x1b;
const F_ENDED = 0x1c;

const NAME_LENGTH = 9;
const HEAD_LENGTH = 8;
const REQUEST_LENGTH = HEAD_LENGTH + 1 + NAME_LENGTH + 14;
const JOB_LENGTH = HEAD_LENGTH + 1 + NAME_LENGTH;
/** Header S7 ack-data (12) + param 0x1B (2) + header dati (4): il resto della PDU è fetta. */
const ACK_OVERHEAD = 12 + 2 + 4;

function bad(msg: string): S7Error {
  return new S7Error('PROTOCOL', `download: ${msg}`);
}

function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

function text(b: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[off + i]!);
  return s;
}

function lengthDigits(what: string, n: number): number[] {
  if (!Number.isInteger(n) || n < 0 || n > 999999)
    throw new RangeError(`${what} ${n} fuori 0-999999`);
  return ascii(String(n).padStart(6, '0'));
}

function readDigits(b: Uint8Array, off: number, what: string): number {
  const s = text(b, off, 6);
  if (!/^[0-9]{6}$/.test(s)) throw bad(`${what} "${s}" non è di 6 cifre`);
  return Number(s);
}

function encodeName(type: BlockType, number: number, fs: BlockFilesystem): number[] {
  const name = blockFileName(type, number, fs);
  return [NAME_LENGTH, ...ascii(name)];
}

function decodeName(
  b: Uint8Array,
  off: number,
): { type: BlockType; number: number; fs: BlockFilesystem } {
  if (b[off] !== NAME_LENGTH) throw bad(`lunghezza del nome ${b[off]} invece di ${NAME_LENGTH}`);
  const f = parseBlockFileName(text(b, off + 1, NAME_LENGTH));
  if (f.filesystem !== 'A' && f.filesystem !== 'P' && f.filesystem !== 'B') {
    throw bad(`filesystem "${f.filesystem}" diverso da A, P, B`);
  }
  return { type: f.type, number: f.number, fs: f.filesystem };
}

// ---- request download 0x1A (proto §10.1) -----------------------------------------------------

export function encodeRequestDownload(
  type: BlockType,
  number: number,
  fs: BlockFilesystem,
  loadLength: number,
  mc7Length: number,
): Uint8Array {
  return Uint8Array.from([
    F_REQUEST,
    0x00,
    0x01,
    0,
    0,
    0,
    0,
    0,
    ...encodeName(type, number, fs),
    0x0d,
    0x31,
    ...lengthDigits('lunghezza load memory', loadLength),
    ...lengthDigits('lunghezza MC7', mc7Length),
  ]);
}

/** Lato finto PLC. */
export function decodeRequestDownload(param: Uint8Array): {
  type: BlockType;
  number: number;
  fs: BlockFilesystem;
  loadLength: number;
  mc7Length: number;
} {
  if (param.length !== REQUEST_LENGTH) {
    throw bad(`request download di ${param.length} byte invece di ${REQUEST_LENGTH}`);
  }
  if (param[0] !== F_REQUEST) throw bad(`funzione 0x${param[0]!.toString(16)} non è 0x1a`);
  const n = HEAD_LENGTH + 1 + NAME_LENGTH;
  if (param[n] !== 0x0d || param[n + 1] !== 0x31) throw bad('coda lunghezze non è 0d 31');
  return {
    ...decodeName(param, HEAD_LENGTH),
    loadLength: readDigits(param, n + 2, 'lunghezza load memory'),
    mc7Length: readDigits(param, n + 8, 'lunghezza MC7'),
  };
}

// ---- job 0x1B e 0x1C dalla CPU ---------------------------------------------------------------

function encodeJob(fn: number, type: BlockType, number: number, fs: BlockFilesystem): Uint8Array {
  return Uint8Array.from([fn, 0, 0, 0, 0, 0, 0, 0, ...encodeName(type, number, fs)]);
}

function decodeJob(
  fn: number,
  what: string,
  param: Uint8Array,
): { type: BlockType; number: number; fs: BlockFilesystem } {
  if (param.length !== JOB_LENGTH)
    throw bad(`${what} di ${param.length} byte invece di ${JOB_LENGTH}`);
  if (param[0] !== fn) throw bad(`${what} con funzione 0x${param[0]!.toString(16)}`);
  return decodeName(param, HEAD_LENGTH);
}

/** Job 0x1B dalla CPU (ROSCTR 1): chiede una fetta del blocco. */
export function encodeDownloadBlockJob(
  type: BlockType,
  number: number,
  fs: BlockFilesystem,
): Uint8Array {
  return encodeJob(F_BLOCK, type, number, fs);
}

export function decodeDownloadBlockJob(param: Uint8Array): {
  type: BlockType;
  number: number;
  fs: BlockFilesystem;
} {
  return decodeJob(F_BLOCK, 'job download block', param);
}

/** Job 0x1C dalla CPU: il trasferimento è finito. La risposta del PG è il solo byte `1c`. */
export function encodeDownloadEnded(
  type: BlockType,
  number: number,
  fs: BlockFilesystem,
): Uint8Array {
  return encodeJob(F_ENDED, type, number, fs);
}

export function decodeDownloadEnded(param: Uint8Array): {
  type: BlockType;
  number: number;
  fs: BlockFilesystem;
} {
  return decodeJob(F_ENDED, 'download ended', param);
}

// ---- ack-data 0x1B del PG --------------------------------------------------------------------

/** `eos` = true se seguono altre fette (byte `01`), false per l'ultima (byte `00`). */
export function encodeDownloadBlockAck(
  eos: boolean,
  chunk: Uint8Array,
): { param: Uint8Array; data: Uint8Array } {
  if (chunk.length > 0xffff) throw new RangeError('fetta oltre 65535 byte');
  const data = new Uint8Array(4 + chunk.length);
  writeU16(data, 0, chunk.length);
  data[2] = 0x00;
  data[3] = 0xfb;
  data.set(chunk, 4);
  return { param: Uint8Array.of(F_BLOCK, eos ? 1 : 0), data };
}

export function decodeDownloadBlockAck(
  param: Uint8Array,
  data: Uint8Array,
): { eos: boolean; chunk: Uint8Array } {
  if (param.length !== 2) throw bad(`ack download block di ${param.length} byte invece di 2`);
  if (param[0] !== F_BLOCK) throw bad(`ack con funzione 0x${param[0]!.toString(16)}`);
  if (param[1] !== 0 && param[1] !== 1) throw bad(`EoS 0x${param[1]!.toString(16)} non è 0 o 1`);
  if (data.length < 4) throw bad("dati dell'ack più corti dell'header di 4 byte");
  const len = readU16(data, 0);
  if (len !== data.length - 4) throw bad(`lunghezza della fetta ${len} <> ${data.length - 4}`);
  return { eos: param[1] === 1, chunk: data.slice(4) };
}

/** Fette del file di blocco che entrano ciascuna in un'ack-data nella PDU negoziata; ultima senza EoS. */
export function sliceBlockForDownload(file: Uint8Array, pduLength: number): Uint8Array[] {
  const size = pduLength - ACK_OVERHEAD;
  if (!Number.isInteger(pduLength) || size < 1)
    throw new RangeError(`PDU ${pduLength} troppo piccola`);
  const out: Uint8Array[] = [];
  for (let o = 0; o < file.length; o += size) out.push(file.slice(o, o + size));
  return out.length > 0 ? out : [new Uint8Array(0)];
}
