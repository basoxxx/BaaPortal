import { readU16 } from '../bytes';
import { S7Error } from '../errors';
import { decodeBcdDateTime, type S7DateTime } from './clock';
import type { SzlList } from './szl';

/**
 * Passare la lista sbagliata a un parser tipizzato è un errore del programmatore (RangeError).
 * Il contenuto dei record invece non lancia mai: i campi che mancano restano undefined.
 */
function expectList(l: SzlList, number: number, what: string): void {
  if ((l.id & 0xff) !== number) {
    throw new RangeError(`${what}: lista 0x${l.id.toString(16)} inattesa`);
  }
}

/** Parola a offset `off` del record, se ci sta tutta. */
function word(r: Uint8Array | undefined, off: number): number | undefined {
  return r && off + 2 <= r.length ? readU16(r, off) : undefined;
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
  version?: string;
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
 * dall'indice 1 come `V<Ausbg1>.<Ausbg2>`. Senza il record 1 `orderNumber` è '' e la versione
 * resta undefined; un record più corto del layout dà i campi che ci stanno.
 */
export function identityFrom(s0011: SzlList, s001c?: SzlList): CpuIdentity {
  expectList(s0011, 0x11, 'identificazione 0x0011');
  const r1 = recordWithIndex(s0011, 1);
  const id: CpuIdentity = { orderNumber: r1 ? text(r1.subarray(2, 22)) : '' };
  const r7 = recordWithIndex(s0011, 7);
  if (r7 && r7.length >= 28 && r7[24] === 0x56) {
    id.version = `V${r7[25]}.${r7[26]}.${r7[27]}`;
  } else {
    const a1 = word(r1, 24);
    const a2 = word(r1, 26);
    if (a1 !== undefined && a2 !== undefined) id.version = `V${a1}.${a2}`;
  }
  if (s001c) {
    expectList(s001c, 0x1c, 'identificazione 0x001C');
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
 * bzu-id (offset 3 del record) è il modo attuale: 8 RUN, 1-4 STOP, 5 e 7 avvio, A HOLD,
 * D difetto. Altro, record troppo corto o lista vuota: UNKNOWN.
 */
export function modeFrom(s0424: SzlList): CpuMode {
  expectList(s0424, 0x24, 'modo 0x0424');
  const r = s0424.records[0];
  if (!r || r.length < 4) return 'UNKNOWN';
  const nib = r[3]! & 0x0f;
  if (nib === 0x8) return 'RUN';
  if (nib >= 1 && nib <= 4) return 'STOP';
  if (nib === 5 || nib === 7) return 'STARTUP';
  if (nib === 0xa) return 'HOLD';
  if (nib === 0xd) return 'DEFECT';
  return 'UNKNOWN';
}

export interface ProtectionInfo {
  switchLevel?: number;
  paramLevel?: number;
  validLevel?: number;
  modeSwitch?: 'RUN' | 'RUN-P' | 'STOP' | 'MRES' | 'UNKNOWN';
}

/** 0x0232 index 4: sch_schal, sch_par, sch_rel, bart_sch (proto §7.3). I campi che non ci sono restano assenti. */
export function protectionFrom(s0232: SzlList): ProtectionInfo {
  expectList(s0232, 0x32, 'protezione 0x0232');
  const r = s0232.records[0];
  const out: ProtectionInfo = {};
  const sw = word(r, 2);
  const par = word(r, 4);
  const rel = word(r, 6);
  const bart = word(r, 8);
  if (sw !== undefined) out.switchLevel = sw;
  if (par !== undefined) out.paramLevel = par;
  if (rel !== undefined) out.validLevel = rel;
  if (bart !== undefined) {
    const modes = ['UNKNOWN', 'RUN', 'RUN-P', 'STOP', 'MRES'] as const;
    out.modeSwitch = modes[bart] ?? 'UNKNOWN';
  }
  return out;
}

export interface CommCapabilities {
  maxPdu?: number;
  maxConnections?: number;
}

/** 0x0131 index 1: pdu e anz (proto §7.3). Senza il record o con un record corto, campi assenti. */
export function commFrom(s0131: SzlList): CommCapabilities {
  expectList(s0131, 0x31, 'comunicazione 0x0131');
  const r = recordWithIndex(s0131, 1);
  const out: CommCapabilities = {};
  const pdu = word(r, 2);
  const anz = word(r, 4);
  if (pdu !== undefined) out.maxPdu = pdu;
  if (anz !== undefined) out.maxConnections = anz;
  return out;
}

export interface DiagEntry {
  eventId: number;
  info: Uint8Array;
  /** Assente se l'ora del record non è una data valida (allora c'è `rawTime`). */
  time?: S7DateTime;
  rawTime?: Uint8Array;
}

/** 0x00A0: id evento (2) + info (10) + ora breve BCD (8). Un'ora non valida non fa perdere la voce. */
export function diagFrom(s00a0: SzlList): DiagEntry[] {
  expectList(s00a0, 0xa0, 'buffer diagnostico 0x00A0');
  return s00a0.records.map((r) => {
    const entry: DiagEntry = { eventId: word(r, 0) ?? 0, info: r.slice(2, 12) };
    const raw = r.slice(12, 20);
    try {
      entry.time = decodeBcdDateTime(raw);
    } catch (e) {
      if (!(e instanceof S7Error)) throw e;
      entry.rawTime = raw;
    }
    return entry;
  });
}
