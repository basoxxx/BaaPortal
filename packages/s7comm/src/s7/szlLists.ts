import { readU16 } from '../bytes';
import { S7Error } from '../errors';
import { decodeBcdDateTime, type S7DateTime } from './clock';
import type { SzlList } from './szl';

function bad(msg: string): S7Error {
  return new S7Error('PROTOCOL', `SZL: ${msg}`);
}

/** Verifica l'id (numero di lista nel byte basso, estratto ignorato) e la lunghezza record. */
function expectList(l: SzlList, number: number, minRecord: number, what: string): void {
  if ((l.id & 0xff) !== number) throw bad(`${what}: lista 0x${l.id.toString(16)} inattesa`);
  if (l.records.length > 0 && l.recordLength < minRecord) {
    throw bad(`${what}: record di ${l.recordLength} byte, ne servono ${minRecord}`);
  }
}

function text(b: Uint8Array): string {
  let end = b.length;
  while (end > 0 && (b[end - 1] === 0x20 || b[end - 1] === 0x00)) end--;
  let s = '';
  for (let i = 0; i < end; i++) s += String.fromCharCode(b[i]!);
  return s;
}

function recordWithIndex(l: SzlList, index: number): Uint8Array | undefined {
  return l.records.find((r) => r.length >= 2 && readU16(r, 0) === index);
}

export interface CpuIdentity {
  orderNumber: string;
  version: string;
  asName?: string;
  moduleName?: string;
  serialNumber?: string;
  copyright?: string;
  plantId?: string;
  mmcSerial?: string;
}

/**
 * Identità dalla 0x0011 (record index 1: MlFB; la versione dal record 7, firmware, forma
 * "V3.2.6") e, se c'è, dalla 0x001C (proto §7.3). Senza il record 7 la versione viene
 * dall'indice 1 come `V<Ausbg1>.<Ausbg2>`.
 */
export function identityFrom(s0011: SzlList, s001c?: SzlList): CpuIdentity {
  expectList(s0011, 0x11, 28, 'identificazione 0x0011');
  const r1 = recordWithIndex(s0011, 1);
  if (!r1) throw bad('0x0011 senza il record index 1');
  const orderNumber = text(r1.subarray(2, 22));
  let version: string;
  const r7 = recordWithIndex(s0011, 7);
  if (r7 && r7[24] === 0x56) {
    version = `V${r7[25]}.${r7[26]}.${r7[27]}`;
  } else {
    version = `V${readU16(r1, 24)}.${readU16(r1, 26)}`;
  }
  const id: CpuIdentity = { orderNumber, version };
  if (s001c) {
    expectList(s001c, 0x1c, 2, 'identificazione 0x001C');
    const str = (index: number): string | undefined => {
      const r = recordWithIndex(s001c, index);
      return r ? text(r.subarray(2)) : undefined;
    };
    const set = <K extends keyof CpuIdentity>(k: K, v: string | undefined): void => {
      if (v !== undefined) id[k] = v as CpuIdentity[K];
    };
    set('asName', str(1));
    set('moduleName', str(2));
    set('plantId', str(3));
    set('copyright', str(4));
    set('serialNumber', str(5));
    set('mmcSerial', str(8));
  }
  return id;
}

export type CpuMode = 'RUN' | 'STOP' | 'STARTUP' | 'HOLD' | 'DEFECT' | 'UNKNOWN';

/**
 * Modo dalla 0x0424 (proto §7.3): record = ereig(2) + ae(1) + bzu-id(1) ...; il nibble basso del
 * bzu-id è il modo attuale: 8 RUN, 1-4 STOP, 5 e 7 avvio, A HOLD, D difetto. Altro: UNKNOWN.
 */
export function modeFrom(s0424: SzlList): CpuMode {
  expectList(s0424, 0x24, 4, 'modo 0x0424');
  const r = s0424.records[0];
  if (!r) return 'UNKNOWN';
  const nib = r[3]! & 0x0f;
  if (nib === 0x8) return 'RUN';
  if (nib >= 1 && nib <= 4) return 'STOP';
  if (nib === 5 || nib === 7) return 'STARTUP';
  if (nib === 0xa) return 'HOLD';
  if (nib === 0xd) return 'DEFECT';
  return 'UNKNOWN';
}

export interface ProtectionInfo {
  switchLevel: number;
  paramLevel: number;
  validLevel: number;
  modeSwitch: 'RUN' | 'RUN-P' | 'STOP' | 'MRES' | 'UNKNOWN';
}

/** 0x0232 index 4: sch_schal, sch_par, sch_rel, bart_sch (proto §7.3). */
export function protectionFrom(s0232: SzlList): ProtectionInfo {
  expectList(s0232, 0x32, 10, 'protezione 0x0232');
  const r = s0232.records[0];
  if (!r) throw bad('protezione senza record');
  const modes = ['UNKNOWN', 'RUN', 'RUN-P', 'STOP', 'MRES'] as const;
  return {
    switchLevel: readU16(r, 2),
    paramLevel: readU16(r, 4),
    validLevel: readU16(r, 6),
    modeSwitch: modes[readU16(r, 8)] ?? 'UNKNOWN',
  };
}

export interface CommCapabilities {
  maxPdu: number;
  maxConnections: number;
}

/** 0x0131 index 1: pdu e anz (proto §7.3). */
export function commFrom(s0131: SzlList): CommCapabilities {
  expectList(s0131, 0x31, 6, 'comunicazione 0x0131');
  const r = recordWithIndex(s0131, 1);
  if (!r) throw bad('0x0131 senza il record index 1');
  return { maxPdu: readU16(r, 2), maxConnections: readU16(r, 4) };
}

export interface DiagEntry {
  eventId: number;
  info: Uint8Array;
  time: S7DateTime;
}

/** 0x00A0: id evento (2) + info (10) + ora breve BCD (8). */
export function diagFrom(s00a0: SzlList): DiagEntry[] {
  expectList(s00a0, 0xa0, 20, 'buffer diagnostico 0x00A0');
  return s00a0.records.map((r) => ({
    eventId: readU16(r, 0),
    info: r.slice(2, 12),
    time: decodeBcdDateTime(r.subarray(12, 20)),
  }));
}
