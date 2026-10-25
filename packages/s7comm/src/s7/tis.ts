import { hex, readU16, writeU16 } from '../bytes';
import { S7Error } from '../errors';
import { decodeUserdata } from './userdata';
import type { UserdataFrame } from './userdataRequests';

/**
 * Funzioni di test (TIS, userdata gruppo 1), proto §18. Qui solo i byte: la richiesta si costruisce
 * a mano perché `encodeUserdata` resta di sola lettura (rifiuta il gruppo 1). Il filtro
 * `online-test` ammette solo le forme canoniche costruite da queste funzioni.
 */

/** Sottofunzioni del gruppo 1 usate dal client (proto §18.1, §18.7). */
export const TIS_SUB = {
  ISTACK: 0x03,
  BSTACK: 0x04,
  LSTACK: 0x05,
  ENABLE: 0x0e,
  DELETE: 0x0f,
  JOB_LIST: 0x10,
  BLOCK_STATUS: 0x13,
} as const;

/** Bit dei registri nel block status (proto §18.4). STA e RLO sono bit della STW. */
export const REG = { STW: 0x01, ACCU1: 0x02, ACCU2: 0x04, AR1: 0x08 } as const;

/** Byte dei valori dei registri scelti: 2 per la STW, 4 per ogni altro. Bit fuori da 0x0F: RangeError. */
export function regBytes(mask: number): number {
  if (!Number.isInteger(mask) || mask < 0 || mask > 0x0f) {
    throw new RangeError(`maschera dei registri 0x${mask.toString(16)} fuori da 0x00-0x0F`);
  }
  let n = mask & REG.STW ? 2 : 0;
  for (const bit of [REG.ACCU1, REG.ACCU2, REG.AR1]) if (mask & bit) n += 4;
  return n;
}

const hexParam = (s: string): Uint8Array =>
  Uint8Array.from(
    s
      .replace(/\s+/g, '')
      .match(/../g)!
      .map((x) => parseInt(x, 16)),
  );

/** Parametro TIS di enable e delete (20 byte, proto §18.7, verificato). */
export const MGMT_PARAM = hexParam('0000 0000 0001 0000 0000 0001 0001 0001 0001 0000');
/** Parametro TIS di read job list (20 byte, p5 = 1, proto §18.7, verificato). */
export const JOB_LIST_PARAM = hexParam('0000 0000 0001 0000 0001 0001 0001 0001 0001 0000');
/** Parametro degli stack: ipotesi di §18.6, «forma come read job list». */
export const STACK_PARAM = JOB_LIST_PARAM;

const NOTHING = new Uint8Array(0);

function byteIn(name: string, v: number, max: number): number {
  if (!Number.isInteger(v) || v < 0 || v > max) throw new RangeError(`${name} ${v} fuori 0-${max}`);
  return v;
}

/**
 * Richiesta TIS (proto §18.1): parametro userdata di 8 byte `00 01 12 08 12 41 SS 00 00 00 00 00`;
 * dati `ff 09 LLLL` + dimensione del parametro TIS + dimensione dei dati TIS + parametro + dati.
 */
export function encodeTisRequest(
  sub: number,
  tisParam: Uint8Array,
  tisData: Uint8Array,
): UserdataFrame {
  byteIn('sottofunzione', sub, 255);
  const param = Uint8Array.of(0x00, 0x01, 0x12, 0x08, 0x12, 0x41, sub, 0, 0, 0, 0, 0);
  const body = 4 + tisParam.length + tisData.length;
  if (body > 0xffff) throw new RangeError('dati TIS troppo lunghi');
  const data = new Uint8Array(4 + body);
  data[0] = 0xff;
  data[1] = 0x09;
  writeU16(data, 2, body);
  writeU16(data, 4, tisParam.length);
  writeU16(data, 6, tisData.length);
  data.set(tisParam, 8);
  data.set(tisData, 8 + tisParam.length);
  return { param, data };
}

/** Richiesta TIS decodificata a livello di byte; `undefined` se la forma non è quella di §18.1. */
export function decodeTisRequest(
  param: Uint8Array,
  data: Uint8Array,
): { sub: number; tisParam: Uint8Array; tisData: Uint8Array } | undefined {
  if (param.length !== 12 || data.length < 8) return undefined;
  const head = [0x00, 0x01, 0x12, 0x08, 0x12, 0x41];
  if (!head.every((b, i) => param[i] === b)) return undefined;
  if (param.subarray(7).some((b) => b !== 0)) return undefined;
  if (data[0] !== 0xff || data[1] !== 0x09) return undefined;
  const body = readU16(data, 2);
  const pl = readU16(data, 4);
  const dl = readU16(data, 6);
  if (data.length !== 4 + body || body !== 4 + pl + dl) return undefined;
  return { sub: param[6]!, tisParam: data.slice(8, 8 + pl), tisData: data.slice(8 + pl) };
}

export function reqReadJobList(): UserdataFrame {
  return encodeTisRequest(TIS_SUB.JOB_LIST, JOB_LIST_PARAM, Uint8Array.of(0, 0, 0, 0));
}

/** Enable job (proto §18.7): dati `fn job`. */
export function reqEnableJob(fn: number, job: number): UserdataFrame {
  return encodeTisRequest(
    TIS_SUB.ENABLE,
    MGMT_PARAM,
    Uint8Array.of(byteIn('funzione', fn, 255), byteIn('job', job, 255)),
  );
}

/** Delete job (proto §18.7): dati `00 01 fn job` (il `0001` è sempre quello delle catture). */
export function reqDeleteJob(fn: number, job: number): UserdataFrame {
  return encodeTisRequest(
    TIS_SUB.DELETE,
    MGMT_PARAM,
    Uint8Array.of(0x00, 0x01, byteIn('funzione', fn, 255), byteIn('job', job, 255)),
  );
}

// ---- block status (proto §18.4) -------------------------------------------------------------

export interface BlockStatusRequest {
  type: 'OB' | 'FB' | 'FC';
  number: number;
  /** Registri iniziali, bit di `REG`. */
  initMask: number;
  /** Righe in ordine crescente di offset MC7. */
  lines: { offset: number; mask: number }[];
}

const BS_TYPE_CODE = { OB: 0x08, FC: 0x0c, FB: 0x0e } as const;
const BS_TYPE_FROM = new Map<number, BlockStatusRequest['type']>([
  [0x08, 'OB'],
  [0x0c, 'FC'],
  [0x0e, 'FB'],
]);
const BS_PARAM_LEN = 28;

/** Dimensione dei dati TIS del risultato: `2 + val(iniziali) + Σ (2 + val(riga))` (proto §18.4.1). */
export function blockStatusResultSize(r: BlockStatusRequest): number {
  let n = 2 + regBytes(r.initMask);
  for (const l of r.lines) n += 2 + regBytes(l.mask);
  return n;
}

/** Limite alle righe del parametro: l'indication deve stare in una PDU, e la richiesta pure. */
export function maxBlockStatusLines(pduLength: number, mask: number): number {
  const rb = regBytes(mask);
  // risultato <= PDU - 34 (proto §18.4.1); richiesta: 10 + 12 + 8 + 28 + 4 + 4n <= PDU
  const byResult = Math.floor((pduLength - 36 - rb) / (2 + rb));
  const byRequest = Math.floor((pduLength - 62) / 4);
  return Math.max(0, Math.min(byResult, byRequest));
}

/**
 * Richiesta di block status v2: parametro TIS di 28 byte e dati `00 n 00 iniz` + n × (offset, 00,
 * maschera). `saz` è la fine esclusiva della finestra (ipotesi di proto §18.4.1).
 */
export function reqBlockStatus(r: BlockStatusRequest, saz: number): UserdataFrame {
  const typeCode = BS_TYPE_CODE[r.type];
  if (typeCode === undefined) throw new RangeError(`tipo ${String(r.type)} non ammesso`);
  byteIn('numero blocco', r.number, 0xffff);
  byteIn('SAZ', saz, 0xffff);
  if (r.lines.length < 1 || r.lines.length > 255) {
    throw new RangeError(`${r.lines.length} righe fuori 1-255`);
  }
  const size = blockStatusResultSize(r);
  if (size > 0xffff) throw new RangeError('risultato troppo grande');
  const p = new Uint8Array(BS_PARAM_LEN);
  writeU16(p, 2, 1); // p2 = osserva
  writeU16(p, 6, size); // p4
  for (let i = 8; i < 18; i += 2) writeU16(p, i, 1); // p5...p9
  writeU16(p, 18, 0x0600); // trigger: area di codice
  writeU16(p, 20, typeCode);
  writeU16(p, 22, r.number);
  writeU16(p, 24, byteIn('offset', r.lines[0]!.offset, 0xffff));
  writeU16(p, 26, saz);
  const d = new Uint8Array(4 + 4 * r.lines.length);
  d[1] = r.lines.length;
  d[3] = r.initMask;
  r.lines.forEach((l, i) => {
    writeU16(d, 4 + 4 * i, byteIn('offset', l.offset, 0xffff));
    regBytes(l.mask);
    d[4 + 4 * i + 3] = l.mask;
  });
  regBytes(r.initMask);
  return encodeTisRequest(TIS_SUB.BLOCK_STATUS, p, d);
}

/** Block status riletto dai byte. `p4` è quello scritto; `otherFieldsOk` dice se il resto è canonico. */
export interface DecodedBlockStatus {
  r: BlockStatusRequest;
  saz: number;
  p4: number;
  otherFieldsOk: boolean;
}

/** `undefined` se parametro e dati non hanno nemmeno la struttura di un block status v2. */
export function decodeBlockStatusRequest(
  tisParam: Uint8Array,
  tisData: Uint8Array,
): DecodedBlockStatus | undefined {
  if (tisParam.length !== BS_PARAM_LEN || tisData.length < 8) return undefined;
  const type = BS_TYPE_FROM.get(readU16(tisParam, 20));
  const n = tisData[1]!;
  if (type === undefined || n < 1 || tisData.length !== 4 + 4 * n) return undefined;
  if (tisData[0] !== 0 || tisData[2] !== 0) return undefined;
  const lines: BlockStatusRequest['lines'] = [];
  for (let i = 0; i < n; i++) {
    if (tisData[4 + 4 * i + 2] !== 0) return undefined;
    lines.push({ offset: readU16(tisData, 4 + 4 * i), mask: tisData[4 + 4 * i + 3]! });
  }
  const r: BlockStatusRequest = {
    type,
    number: readU16(tisParam, 22),
    initMask: tisData[3]!,
    lines,
  };
  const saz = readU16(tisParam, 26);
  const p4 = readU16(tisParam, 6);
  let otherFieldsOk = false;
  try {
    const frame = reqBlockStatus(r, saz);
    const want = decodeTisRequest(frame.param, frame.data)!;
    const same = (a: Uint8Array, b: Uint8Array): boolean =>
      a.length === b.length && a.every((v, i) => v === b[i]);
    const wantParam = want.tisParam.slice();
    writeU16(wantParam, 6, p4);
    otherFieldsOk = same(wantParam, tisParam) && same(want.tisData, tisData);
  } catch {
    otherFieldsOk = false;
  }
  return { r, saz, p4, otherFieldsOk };
}

/**
 * Motivo per cui un block status non è ammesso (stessa regola nel filtro e nel server di prova),
 * o `undefined`: maschere dentro 0x0F e uguali, offset pari e crescenti, da 1 a `maxBlockStatusLines`
 * righe, offset e ultima riga prima della SAZ.
 */
export function blockStatusProblem(
  r: BlockStatusRequest,
  saz: number,
  pduLength: number,
): string | undefined {
  const masks = new Set(r.lines.map((l) => l.mask));
  if (r.initMask & ~0x0f) return 'maschera iniziale fuori da 0x0F';
  if (masks.size !== 1) return 'maschere diverse fra le righe';
  const mask = r.lines[0]!.mask;
  if (mask & ~0x0f) return 'maschera fuori da 0x0F';
  if (r.lines.length > maxBlockStatusLines(pduLength, mask)) {
    return `${r.lines.length} righe oltre il limite della PDU`;
  }
  // con la maschera iniziale più larga la formula sopra non basta: si controlla il risultato vero
  if (blockStatusResultSize(r) > pduLength - 34 || 62 + 4 * r.lines.length > pduLength) {
    return 'risultato o richiesta oltre la PDU';
  }
  for (const [i, l] of r.lines.entries()) {
    if (l.offset % 2 !== 0) return 'offset dispari';
    if (i > 0 && l.offset <= r.lines[i - 1]!.offset) return 'offset non crescenti';
  }
  if (r.lines[0]!.offset >= saz) return 'prima riga oltre la SAZ';
  if (r.lines[r.lines.length - 1]!.offset >= saz) return 'ultima riga oltre la SAZ';
  return undefined;
}

// ---- risposte -------------------------------------------------------------------------------

export interface TisReply {
  /** `ack` senza dati TIS; `data` con parametro TIS e dati subito; `indication` non sollecitata. */
  kind: 'ack' | 'indication' | 'data';
  sub: number;
  /** Il campo seq: numero del job nell'ack di creazione e nelle indication. */
  job: number;
  errorCode: number;
  tisParam?: Uint8Array;
  tisData?: Uint8Array;
}

/**
 * Dal payload userdata (dopo `ff 09 LLLL`): parametro TIS e dati TIS. I dati sono tutti i byte
 * dopo il parametro, qualunque sia la lunghezza dichiarata; `undefined` se manca il parametro.
 */
export function splitTisPayload(
  payload: Uint8Array,
): { tisParam: Uint8Array; tisData: Uint8Array } | undefined {
  if (payload.length < 4) return undefined;
  const pl = readU16(payload, 0);
  if (4 + pl > payload.length) return undefined;
  return { tisParam: payload.slice(4, 4 + pl), tisData: payload.slice(4 + pl) };
}

/**
 * Decodifica tollerante: i dati TIS sono tutti i byte dopo il parametro TIS, qualunque sia la
 * lunghezza dichiarata (difetto dell'IM151-8 sul BSTACK, proto §18.6).
 */
export function decodeTisReply(param: Uint8Array, data: Uint8Array): TisReply {
  const u = decodeUserdata(param, NOTHING);
  if (u.param.group !== 1)
    throw new S7Error('PROTOCOL', `TIS: risposta del gruppo ${u.param.group}`);
  const reply: TisReply = {
    kind: u.param.type === 0 ? 'indication' : 'ack',
    sub: u.param.subfunction,
    job: u.param.sequence,
    errorCode: u.param.errorCode ?? 0,
  };
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0x09) {
    const split = splitTisPayload(data.subarray(4));
    if (split) {
      reply.tisParam = split.tisParam;
      reply.tisData = split.tisData;
      if (reply.kind !== 'indication') reply.kind = 'data';
    }
  }
  return reply;
}

/** Voci della lista dei job: da 4 byte (funzione, job, 2 riservati). */
export function decodeJobList(tisData: Uint8Array): { fn: number; job: number }[] {
  if (tisData.length % 4 !== 0) {
    throw new S7Error('PROTOCOL', `lista dei job di ${tisData.length} byte, non multipla di 4`);
  }
  const out: { fn: number; job: number }[] = [];
  for (let i = 0; i < tisData.length; i += 4) out.push({ fn: tisData[i]!, job: tisData[i + 1]! });
  return out;
}

export type Regs = { stw?: number; accu1?: number; accu2?: number; ar1?: number };

function readRegs(b: Uint8Array, at: number, mask: number): Regs {
  const regs: Regs = {};
  let p = at;
  if (mask & REG.STW) {
    regs.stw = readU16(b, p);
    p += 2;
  }
  const rd32 = (): number => {
    const v = ((b[p]! << 24) | (b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!) >>> 0;
    p += 4;
    return v;
  };
  if (mask & REG.ACCU1) regs.accu1 = rd32();
  if (mask & REG.ACCU2) regs.accu2 = rd32();
  if (mask & REG.AR1) regs.ar1 = rd32();
  return regs;
}

export type BlockStatusResult =
  | { ok: true; initial: Regs; lines: (Regs | null)[]; trailing?: string }
  | { ok: false; why: string; hex: string };

/**
 * Risultato tollerante (proto §18.4.1): ogni riga ripete il suo offset. Una riga che manca (offset
 * di una riga successiva al suo posto) diventa `null`; se i byte finiscono, le restanti sono
 * `null` (ipotesi sul modo in cui la CPU segnala una riga non eseguita). La risincronizzazione
 * vale solo con la stessa maschera su tutte le righe.
 */
export function decodeBlockStatusResult(
  bytes: Uint8Array,
  r: BlockStatusRequest,
): BlockStatusResult {
  const fail = (why: string): BlockStatusResult => ({ ok: false, why, hex: hex(bytes) });
  const first = r.lines[0];
  if (!first) return fail('nessuna riga chiesta');
  if (bytes.length < 2 || readU16(bytes, 0) !== first.offset) {
    return fail('il primo offset non è quello della prima riga chiesta');
  }
  const ib = regBytes(r.initMask);
  if (bytes.length < 2 + ib) return fail('registri iniziali troncati');
  const initial = readRegs(bytes, 2, r.initMask);
  const sameMask = r.lines.every((l) => l.mask === first.mask);
  const lines: (Regs | null)[] = r.lines.map(() => null);
  let p = 2 + ib;
  let i = 0;
  while (i < r.lines.length && bytes.length - p >= 2) {
    const off = readU16(bytes, p);
    let j = i;
    if (off !== r.lines[i]!.offset) {
      j = sameMask ? r.lines.findIndex((l, k) => k > i && l.offset === off) : -1;
      if (j < 0)
        return fail(`offset 0x${off.toString(16).padStart(4, '0')} non è di nessuna riga attesa`);
    }
    const need = 2 + regBytes(r.lines[j]!.mask);
    if (bytes.length - p < need) break;
    lines[j] = readRegs(bytes, p + 2, r.lines[j]!.mask);
    p += need;
    i = j + 1;
  }
  const out: BlockStatusResult = { ok: true, initial, lines };
  if (p < bytes.length) out.trailing = hex(bytes.subarray(p));
  return out;
}

/** Bit della parola di stato (proto §18.4): ER, RLO, STA, OR, OS, OV, CC0, CC1, BR. */
export function stwBits(stw: number): {
  er: number;
  rlo: number;
  sta: number;
  or: number;
  os: number;
  ov: number;
  cc0: number;
  cc1: number;
  br: number;
} {
  const b = (n: number): number => (stw >> n) & 1;
  return {
    er: b(0),
    rlo: b(1),
    sta: b(2),
    or: b(3),
    os: b(4),
    ov: b(5),
    cc0: b(6),
    cc1: b(7),
    br: b(8),
  };
}

// ---- errori TIS (proto §18.7.1) -------------------------------------------------------------

export type TisAction =
  'hide' | 'retry' | 'stop' | 'recreate' | 'ignore' | 'leave' | 'partial' | 'protection' | 'mode';

export const TIS_ERRORS: ReadonlyMap<number, { text: string; action: TisAction }> = new Map([
  [0xd003, { text: 'funzione di test non supportata dal modulo', action: 'hide' }],
  [0xd012, { text: 'indirizzo errato nel blocco', action: 'recreate' }],
  [0xd014, { text: 'blocco in cancellazione o sovrascrittura', action: 'retry' }],
  [0xd016, { text: 'job di test impossibili per errori nel programma utente', action: 'stop' }],
  [0xd032, { text: 'lunghezza del buffer dei risultati errata', action: 'stop' }],
  [0xd04a, { text: "errore nell'esecuzione dello stato del programma", action: 'stop' }],
  [0xd062, { text: 'lista dei job piena: troppi job di test', action: 'stop' }],
  [
    0xd063,
    { text: 'evento di trigger occupato: un altro PG osserva lo stesso punto', action: 'stop' },
  ],
  [0xd081, { text: 'funzione non permessa nel modo attuale della CPU', action: 'mode' }],
  [0xd0a1, { text: 'funzione non permessa nel livello di protezione', action: 'protection' }],
  [0xd0a4, { text: 'forzamento già attivo', action: 'ignore' }],
  [0xd0a5, { text: 'job referenziato non trovato', action: 'ignore' }],
  [0xd0ab, { text: 'parametri non validi in modo processo', action: 'mode' }],
  [0xd0ac, { text: 'dati non validi in modo processo', action: 'mode' }],
  [0xd0ae, { text: "job creato su un'altra connessione", action: 'leave' }],
  [0xd0c2, { text: 'job chiuso dal passaggio in STOP o HOLD', action: 'recreate' }],
  [0xd0c7, { text: "job cancellato all'uscita da STOP", action: 'recreate' }],
  [
    0xd0c8,
    { text: 'block status interrotto per incoerenza fra job e programma', action: 'recreate' },
  ],
  [0xd0cc, { text: 'dati limitati dal limite di tempo', action: 'partial' }],
]);

export function tisErrorText(code: number): string {
  return (
    TIS_ERRORS.get(code)?.text ?? `errore TIS 0x${code.toString(16).toUpperCase().padStart(4, '0')}`
  );
}
