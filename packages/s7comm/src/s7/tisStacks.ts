import { hex, readU16, readU32 } from '../bytes';
import { S7Error } from '../errors';
import type { BlockType } from './blocks';
import { blockTypeFromCode } from './blocks';
import { decodeBcdDateTime, type S7DateTime } from './clock';
import { STACK_PARAM, TIS_SUB, encodeTisRequest } from './tis';
import type { UserdataFrame } from './userdataRequests';

/**
 * Stack (proto §18.6): ISTACK, BSTACK, LSTACK. Layout da una sola fonte, mai visto su una CPU
 * vera: i decodificatori sono tolleranti e, se i byte non tornano, restituiscono l'esadecimale.
 */

export type StackResult<T> = { ok: true; value: T } | { ok: false; why: string; hex: string };

/** Richiesta: ISTACK e BSTACK con dati `00 00`; LSTACK con classe di priorità e profondità. */
export function reqStack(
  kind: 'ISTACK' | 'BSTACK' | 'LSTACK',
  args?: { priority: number; depth: number },
): UserdataFrame {
  if (kind === 'LSTACK') {
    const a = args ?? { priority: 0, depth: 0 };
    for (const [n, v] of [
      ['priorità', a.priority],
      ['profondità', a.depth],
    ] as const) {
      if (!Number.isInteger(v) || v < 0 || v > 255) throw new RangeError(`${n} ${v} fuori 0-255`);
    }
    return encodeTisRequest(TIS_SUB.LSTACK, STACK_PARAM, Uint8Array.of(a.priority, a.depth));
  }
  return encodeTisRequest(TIS_SUB[kind], STACK_PARAM, Uint8Array.of(0, 0));
}

function tryTime(raw: Uint8Array): S7DateTime | undefined {
  try {
    return decodeBcdDateTime(raw);
  } catch (e) {
    if (e instanceof S7Error) return undefined;
    throw e;
  }
}

export interface StackBlockRef {
  typeCode: number;
  blockType?: BlockType;
  number: number;
  address: number;
}

function blockRef(b: Uint8Array, at: number): StackBlockRef {
  const typeCode = readU16(b, at);
  const ref: StackBlockRef = { typeCode, number: readU16(b, at + 2), address: readU16(b, at + 4) };
  const t = blockTypeFromCode(typeCode);
  if (t) ref.blockType = t;
  return ref;
}

export interface DbRegister {
  type: number;
  number: number;
}

// ---- BSTACK ---------------------------------------------------------------------------------

export interface BStackEntry {
  typeCode: number;
  blockType?: BlockType;
  number: number;
  returnAddress: number;
  db1: DbRegister;
  db2: DbRegister;
  /** Solo per gli OB: classe di priorità e ora di avvio (o i byte grezzi se l'ora non è valida). */
  ob?: { priority: number; time?: S7DateTime; rawTime?: Uint8Array };
}

const BSTACK_ENTRY = 16;
const BSTACK_OB_EXTRA = 12;
const OB_CODE = 0x08;

/**
 * Voci da 16 byte (28 per gli OB). Si usa la lunghezza vera dei byte, non quella dichiarata
 * (difetto dell'IM151-8). Una voce incompleta finisce in `rest` (esadecimale); le intere restano.
 */
export function decodeBStack(data: Uint8Array): StackResult<{
  entries: BStackEntry[];
  rest?: string;
}> {
  const entries: BStackEntry[] = [];
  let p = 0;
  while (data.length - p >= BSTACK_ENTRY) {
    const typeCode = readU16(data, p);
    const isOb = typeCode === OB_CODE;
    const size = BSTACK_ENTRY + (isOb ? BSTACK_OB_EXTRA : 0);
    if (data.length - p < size) break;
    const e: BStackEntry = {
      typeCode,
      number: readU16(data, p + 2),
      returnAddress: readU16(data, p + 4),
      db1: { type: data[p + 6]!, number: readU16(data, p + 8) },
      db2: { type: data[p + 7]!, number: readU16(data, p + 10) },
    };
    const t = blockTypeFromCode(typeCode);
    if (t) e.blockType = t;
    if (isOb) {
      const raw = data.slice(p + 20, p + 28);
      const time = tryTime(raw);
      e.ob = { priority: data[p + 16]! };
      if (time) e.ob.time = time;
      else e.ob.rawTime = raw;
    }
    entries.push(e);
    p += size;
  }
  const value: { entries: BStackEntry[]; rest?: string } = { entries };
  if (p < data.length) value.rest = hex(data.subarray(p));
  return { ok: true, value };
}

// ---- ISTACK ---------------------------------------------------------------------------------

export interface IStack {
  /** Blocco in cui si riprende. */
  resume: StackBlockRef;
  db1: DbRegister;
  db2: DbRegister;
  accu1: number;
  accu2: number;
  accu3: number;
  accu4: number;
  ar1: number;
  ar2: number;
  stw: number;
  /** Blocco interrotto. */
  interrupted: StackBlockRef;
  /** Primi 12 byte dei dati di avvio dell'OB (n. OB al byte 3). */
  obStartInfo: Uint8Array;
  time?: S7DateTime;
  rawTime?: Uint8Array;
  /** Byte oltre i 76 attesi, in esadecimale. */
  rest?: string;
}

const ISTACK_LEN = 76;

export function decodeIStack(data: Uint8Array): StackResult<IStack> {
  if (data.length < ISTACK_LEN) {
    return {
      ok: false,
      why: `ISTACK di ${data.length} byte invece di ${ISTACK_LEN}`,
      hex: hex(data),
    };
  }
  const v: IStack = {
    resume: blockRef(data, 0),
    db1: { type: data[6]!, number: readU16(data, 8) },
    db2: { type: data[7]!, number: readU16(data, 10) },
    accu1: readU32(data, 16),
    accu2: readU32(data, 20),
    accu3: readU32(data, 24),
    accu4: readU32(data, 28),
    ar1: readU32(data, 32),
    ar2: readU32(data, 36),
    stw: readU16(data, 42),
    interrupted: blockRef(data, 44),
    obStartInfo: data.slice(56, 68),
  };
  const raw = data.slice(68, 76);
  const time = tryTime(raw);
  if (time) v.time = time;
  else v.rawTime = raw;
  if (data.length > ISTACK_LEN) v.rest = hex(data.subarray(ISTACK_LEN));
  return { ok: true, value: v };
}

// ---- LSTACK ---------------------------------------------------------------------------------

export interface LStack {
  block: StackBlockRef;
  /** Indirizzo MC7 (copia di `block.address`). */
  address: number;
  local: Uint8Array;
  priority: number;
  time?: S7DateTime;
  rawTime?: Uint8Array;
  rest?: string;
}

export function decodeLStack(data: Uint8Array): StackResult<LStack> {
  if (data.length < 8) {
    return { ok: false, why: `LSTACK di ${data.length} byte`, hex: hex(data) };
  }
  const len = readU16(data, 6);
  const end = 8 + len + 12;
  if (data.length < end) {
    return { ok: false, why: `LSTACK di ${data.length} byte invece di ${end}`, hex: hex(data) };
  }
  const block = blockRef(data, 0);
  const v: LStack = {
    block,
    address: block.address,
    local: data.slice(8, 8 + len),
    priority: data[8 + len]!,
  };
  const raw = data.slice(8 + len + 4, end);
  const time = tryTime(raw);
  if (time) v.time = time;
  else v.rawTime = raw;
  if (data.length > end) v.rest = hex(data.subarray(end));
  return { ok: true, value: v };
}
