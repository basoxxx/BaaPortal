import { readU16, readU32 } from '../bytes';
import { S7Error } from '../errors';
import { decodeBcdDateTime, type S7DateTime } from './clock';
import type { SzlList } from './szl';

/**
 * Parser delle SZL per la diagnostica online (proto §7.5, §7.6). Una lista sbagliata lancia
 * PROTOCOL; un record corto o un'ora non valida non fanno perdere gli altri record.
 */

const hex4 = (n: number): string => `0x${n.toString(16).padStart(4, '0')}`;

function expectId(l: SzlList, ids: readonly number[], what: string): void {
  if (!ids.includes(l.id)) {
    throw new S7Error('PROTOCOL', `${what}: lista ${hex4(l.id)} inattesa`);
  }
}

function expectIndex(l: SzlList, index: number, what: string): void {
  if (l.index !== index) {
    throw new S7Error(
      'PROTOCOL',
      `${what}: la CPU ha risposto con l'indice ${hex4(l.index)} invece di ${hex4(index)}`,
    );
  }
}

function tryTime(raw: Uint8Array): S7DateTime | undefined {
  try {
    return decodeBcdDateTime(raw);
  } catch (e) {
    if (e instanceof S7Error) return undefined;
    throw e;
  }
}

// ---- buffer diagnostico e ultimo cambio di modo (§7.6.1) --------------------------------------

export interface DiagRecord {
  eventId: number;
  /** Classe di priorità dell'OB coinvolto, 0xFF se non c'entra un OB. */
  priority: number;
  /** Numero OB; per i cambi di modo (0x43xx) è il byte di modo (vedi `modeTransition`). */
  obNumber: number;
  datId: number;
  info1: number;
  info2: number;
  /** Assente se l'ora non è una data valida (allora c'è `rawTime`). */
  time?: S7DateTime;
  rawTime?: Uint8Array;
}

const DIAG_RECORD = 20;

/** Un record di 20 byte; un'ora non valida resta in `rawTime`. */
export function diagRecordFrom(b: Uint8Array): DiagRecord {
  if (b.length < DIAG_RECORD) {
    throw new S7Error('PROTOCOL', `record diagnostico di ${b.length} byte invece di 20`);
  }
  const rec: DiagRecord = {
    eventId: readU16(b, 0),
    priority: b[2]!,
    obNumber: b[3]!,
    datId: readU16(b, 4),
    info1: readU16(b, 6),
    info2: readU32(b, 8),
  };
  const raw = b.slice(12, 20);
  const time = tryTime(raw);
  if (time) rec.time = time;
  else rec.rawTime = raw;
  return rec;
}

/** 0x00A0 / 0x01A0: voci dalla più recente, ordine del filo. I record corti si saltano. */
export function diagRecordsFrom(list: SzlList): DiagRecord[] {
  expectId(list, [0x00a0, 0x01a0], 'buffer diagnostico');
  return list.records.filter((r) => r.length >= DIAG_RECORD).map(diagRecordFrom);
}

/** 0x0124: l'ultimo cambio di modo, stesso formato di una voce del buffer. */
export function lastModeChangeFrom(s0124: SzlList): DiagRecord | undefined {
  expectId(s0124, [0x0124], 'ultimo cambio di modo');
  const r = s0124.records.find((x) => x.length >= DIAG_RECORD);
  return r ? diagRecordFrom(r) : undefined;
}

export type ModeCode =
  | 'stopUpdate'
  | 'stopReset'
  | 'stopSelfInit'
  | 'stopInternal'
  | 'warmStart'
  | 'startup'
  | 'restart'
  | 'run'
  | 'hold'
  | 'defect'
  | 'unknown';

const MODE_CODES: Record<number, ModeCode> = {
  0x1: 'stopUpdate',
  0x2: 'stopReset',
  0x3: 'stopSelfInit',
  0x4: 'stopInternal',
  0x5: 'warmStart',
  0x6: 'startup',
  0x7: 'restart',
  0x8: 'run',
  0xa: 'hold',
  0xd: 'defect',
};

/** Byte di modo (proto §7.3): nibble alto = modo precedente, basso = nuovo. */
export function modeTransition(byte: number): { from: ModeCode; to: ModeCode } {
  return {
    from: MODE_CODES[(byte >> 4) & 0xf] ?? 'unknown',
    to: MODE_CODES[byte & 0xf] ?? 'unknown',
  };
}

// ---- tempo di ciclo (§7.5.2) -------------------------------------------------------------------

export interface CycleTime {
  lastMs: number;
  minMs: number;
  maxMs: number;
  lastStart?: S7DateTime;
}

function obRecord(l: SzlList, index: number, what: string): Uint8Array {
  expectId(l, [0x0222], what);
  expectIndex(l, index, what);
  const r = l.records[0];
  if (!r || r.length < 20) throw new S7Error('PROTOCOL', `${what}: record mancante o troppo corto`);
  return r;
}

/** 0x0222 indice 1 (OB1): ciclo precedente, minimo, massimo e ora dell'ultimo avvio. */
export function cycleTimeFrom(s0222_1: SzlList): CycleTime {
  const r = obRecord(s0222_1, 1, 'tempo di ciclo');
  const out: CycleTime = { lastMs: readU16(r, 6), minMs: readU16(r, 8), maxMs: readU16(r, 10) };
  const t = tryTime(r.slice(12, 20));
  if (t) out.lastStart = t;
  return out;
}

/** 0x0222 indice 0x50 (OB80): tempo di ciclo minimo e massimo configurati. */
export function cycleConfigFrom(s0222_50: SzlList): { minMs: number; maxMs: number } {
  const r = obRecord(s0222_50, 0x50, 'tempo di ciclo configurato');
  return { minMs: readU16(r, 8), maxMs: readU16(r, 10) };
}

// ---- memoria (§7.5.3) --------------------------------------------------------------------------

export interface MemoryArea {
  index: number;
  kind: 'work' | 'loadIntegrated' | 'loadMmc' | 'loadMax' | 'backup' | 'cfb' | 'unknown';
  size: number;
  used: number;
  free: number;
}

const MEMORY_KINDS: Record<number, MemoryArea['kind']> = {
  1: 'work',
  2: 'loadIntegrated',
  3: 'loadMmc',
  4: 'loadMax',
  5: 'backup',
  6: 'cfb',
};

/** 0x0013: usato = belegt1 + belegt2, libero = totale − usato (mai negativo). Record corti saltati. */
export function memoryFrom(s0013: SzlList): MemoryArea[] {
  expectId(s0013, [0x0013], 'aree di memoria');
  const out: MemoryArea[] = [];
  for (const r of s0013.records) {
    if (r.length < 36) continue;
    const index = readU16(r, 0);
    const size = readU32(r, 4);
    const used = readU32(r, 16) + readU32(r, 28);
    out.push({
      index,
      kind: MEMORY_KINDS[index] ?? 'unknown',
      size,
      used,
      free: Math.max(0, size - used),
    });
  }
  return out;
}

// ---- LED (§7.5.4) ------------------------------------------------------------------------------

export interface Led {
  id: number;
  name: string;
  on: boolean;
  blink: 'none' | 'normal' | 'slow' | 'unknown';
}

const LED_NAMES: Record<number, string> = {
  0x01: 'SF',
  0x02: 'INTF',
  0x03: 'EXTF',
  0x04: 'RUN',
  0x05: 'STOP',
  0x06: 'FRCE',
  0x07: 'CRST',
  0x08: 'BAF',
  0x09: 'USR',
  0x0a: 'USR1',
  0x0b: 'BUS1F',
  0x0c: 'BUS2F',
  0x0d: 'REDF',
  0x0e: 'MSTR',
  0x0f: 'RACK0',
  0x10: 'RACK1',
  0x11: 'RACK2',
  0x12: 'IFM1F',
  0x13: 'IFM2F',
  0x14: 'BUS3F',
  0x15: 'MAINT',
  0x16: 'DC24V',
};

/** 0x0019, 0x0074, 0x0174: un LED per record di 4 byte. */
export function ledsFrom(list: SzlList): Led[] {
  expectId(list, [0x0019, 0x0074, 0x0174], 'LED');
  const out: Led[] = [];
  for (const r of list.records) {
    if (r.length < 4) continue;
    const id = r[1]!;
    const blink = r[3] === 0 ? 'none' : r[3] === 1 ? 'normal' : r[3] === 2 ? 'slow' : 'unknown';
    out.push({
      id,
      name: LED_NAMES[id] ?? `LED 0x${id.toString(16).padStart(2, '0')}`,
      on: r[2] !== 0,
      blink,
    });
  }
  return out;
}

// ---- liste non disponibili ---------------------------------------------------------------------

/** La CPU non ha la lista o l'indice: CPU_ERROR con classe 0xD4 e codice 0x01-0x09. */
export function isUnavailable(err: unknown): boolean {
  if (!(err instanceof S7Error) || err.code !== 'CPU_ERROR') return false;
  const { errorClass, errorCode } = err.detail ?? {};
  return errorClass === 0xd4 && errorCode !== undefined && errorCode >= 0x01 && errorCode <= 0x09;
}

// ---- funzioni di test supportate (§7.5.9) -----------------------------------------------------

export interface TisFunctions {
  /** Block status v2 (`0x13`). */
  blockStatusV2: boolean;
  istack: boolean;
  bstack: boolean;
  lstack: boolean;
  jobList: boolean;
  enable: boolean;
  del: boolean;
  /** Trigger «area di codice» (`0x0600`), bit 6 di trgereig_0. */
  codeAreaTrigger: boolean;
  /** Numero massimo di variabili modificabili o forzabili. */
  forceMax: number;
}

/** 0x0131 indice 2: il bit n di funkt_0…5 è la sottofunzione n del gruppo 1 (§7.5.9). */
export function tisFunctionsFrom(s0131_2: SzlList): TisFunctions {
  expectId(s0131_2, [0x0131], 'funzioni di test');
  expectIndex(s0131_2, 2, 'funzioni di test');
  const r = s0131_2.records[0];
  if (!r || r.length < 34) {
    throw new S7Error('PROTOCOL', 'funzioni di test: record mancante o troppo corto');
  }
  const sub = (n: number): boolean => ((r[2 + (n >> 3)]! >> (n & 7)) & 1) === 1;
  return {
    blockStatusV2: sub(0x13),
    istack: sub(0x03),
    bstack: sub(0x04),
    lstack: sub(0x05),
    jobList: sub(0x10),
    enable: sub(0x0e),
    del: sub(0x0f),
    codeAreaTrigger: ((r[20]! >> 6) & 1) === 1,
    forceMax: readU16(r, 32),
  };
}
