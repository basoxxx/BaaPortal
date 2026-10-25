import {
  JOB_LIST_PARAM,
  MGMT_PARAM,
  REG,
  TIS_SUB,
  blockStatusProblem,
  blockStatusResultSize,
  decodeBlockStatusRequest,
  encodeBcdDateTimeShort,
  encodeTisRequest,
  regBytes,
  type BlockStatusRequest,
  type Regs,
  type S7DateTime,
} from '@baaportal/s7comm';
import type { BackendChange, CpuBackend } from './backend';

/**
 * Funzioni di test (TIS, proto §18) del server di prova: la tabella dei job di una CPU e le
 * risposte a create, enable, delete, lista dei job e stack. Le regole che il documento non dà sono
 * scelte del server di prova e sono marcate come tali.
 */

/** Errori TIS (proto §18.7.1). */
const E = {
  NOT_SUPPORTED: 0xd003,
  BAD_ADDRESS: 0xd012,
  BAD_BUFFER: 0xd032,
  JOBS_FULL: 0xd062,
  TRIGGER_BUSY: 0xd063,
  MODE: 0xd081,
  NOT_FOUND: 0xd0a5,
  OTHER_CONNECTION: 0xd0ae,
  INCONSISTENT: 0xd0c8,
  /** Scelta del server di prova: parametri o dati che non hanno la forma canonica. */
  BAD_PARAM: 0xd0ab,
} as const;

/** Scelta del server di prova: §18.4.1 non dà il massimo dei job di una CPU reale (sconosciuto). */
const MAX_JOBS = 4;
/** Scelta del server di prova: i dati troncati di `tisMalformed` sono lunghi 7 byte. */
const MALFORMED_BYTES = 7;

/** La sessione come la vede la tabella dei job. */
export interface TisSession {
  /** PDU negoziata. */
  readonly pduLength: number;
  isClosed(): boolean;
  /** Manda una PDU non sollecitata (type indication) con i dati TIS del risultato. */
  pushIndication(sub: number, seq: number, tisData: Uint8Array): void;
}

export interface TisRequest {
  sub: number;
  tisParam: Uint8Array;
  tisData: Uint8Array;
}

export interface TisAnswer {
  /** Il numero della richiesta: il contatore della CPU cresce a ogni richiesta TIS (proto §18.1). */
  seq: number;
  errorCode: number;
  /** Dati TIS della risposta immediata (lista dei job, stack): vanno col parametro `0100 0001`. */
  data?: Uint8Array;
  /** Da eseguire dopo l'invio della risposta (qui parte l'indication dell'enable). */
  after?: () => void;
}

interface Job {
  id: number;
  owner: TisSession;
  r: BlockStatusRequest;
  /** Il blocco e' stato ricaricato: l'enable risponde `0xD0C8`. */
  inconsistent: boolean;
  /** Un risultato e' atteso: un secondo enable non ne aggiunge un altro (scelta del server di prova). */
  waiting: boolean;
}

const same = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** I byte dei registri di una riga, nell'ordine dei bit: STW (2), ACCU1, ACCU2, AR1 (4). */
function regsBytes(mask: number, regs: Regs | null): Uint8Array {
  const out = new Uint8Array(regBytes(mask));
  const v = new DataView(out.buffer);
  let p = 0;
  if (mask & REG.STW) {
    v.setUint16(p, regs?.stw ?? 0);
    p += 2;
  }
  for (const [bit, val] of [
    [REG.ACCU1, regs?.accu1],
    [REG.ACCU2, regs?.accu2],
    [REG.AR1, regs?.ar1],
  ] as const) {
    if (mask & bit) {
      v.setUint32(p, (val ?? 0) >>> 0);
      p += 4;
    }
  }
  return out;
}

/**
 * Dati TIS dell'indication (proto §18.4.1): offset della prima riga, registri iniziali (a zero:
 * scelta del server di prova) e per ogni riga eseguita offset e valori. Le righe non eseguite
 * (`null`) **mancano** (scelta coerente con l'ipotesi del client).
 */
export function encodeBlockStatusResult(
  r: BlockStatusRequest,
  rows: readonly (Regs | null)[],
): Uint8Array {
  const parts: Uint8Array[] = [];
  const u16 = (n: number): Uint8Array => Uint8Array.of(n >> 8, n & 0xff);
  parts.push(u16(r.lines[0]!.offset), regsBytes(r.initMask, null));
  r.lines.forEach((l, i) => {
    const regs = rows[i];
    if (regs) parts.push(u16(l.offset), regsBytes(l.mask, regs));
  });
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---- stack sintetici (proto §18.6) ------------------------------------------------------------

const u16b = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
const u32b = (n: number): number[] => [
  (n >>> 24) & 0xff,
  (n >> 16) & 0xff,
  (n >> 8) & 0xff,
  n & 0xff,
];

/** Voce di BSTACK: 16 byte, e per un OB 12 in più (priorità, 3 riservati, ora). */
export function bstackEntry(
  typeCode: number,
  number: number,
  returnAddress: number,
  ob?: { priority: number; time: S7DateTime },
): number[] {
  const head = [
    ...u16b(typeCode),
    ...u16b(number),
    ...u16b(returnAddress),
    0x0a,
    0x0a, // tipi dei registri DB: sconosciuti (proto §18.6), valore del server di prova
    ...u16b(0),
    ...u16b(0),
    0,
    0,
    0,
    0,
  ];
  if (!ob) return head;
  return [...head, ob.priority, 0, 0, 0, ...encodeBcdDateTimeShort(ob.time)];
}

/** ISTACK di 76 byte (layout di proto §18.6). */
export function istackBytes(o: {
  resume: [typeCode: number, number: number, address: number];
  interrupted: [typeCode: number, number: number, address: number];
  stw: number;
  accu1: number;
  accu2: number;
  ar1: number;
  ar2: number;
  obStart: number[];
  time: S7DateTime;
}): Uint8Array {
  const out = [
    ...o.resume.flatMap((n) => u16b(n)), // 0
    0x0a,
    0x0a,
    ...u16b(0),
    ...u16b(0), // 6, 8
    0,
    0,
    0,
    0, // 12
    ...u32b(o.accu1),
    ...u32b(o.accu2),
    ...u32b(0),
    ...u32b(0), // 16
    ...u32b(o.ar1),
    ...u32b(o.ar2), // 32
    0,
    0, // 40
    ...u16b(o.stw), // 42
    ...o.interrupted.flatMap((n) => u16b(n)), // 44
    0,
    0,
    0,
    0,
    0,
    0, // 50
    ...o.obStart.slice(0, 12), // 56
    ...encodeBcdDateTimeShort(o.time), // 68
  ];
  return Uint8Array.from(out);
}

/** LSTACK senza dati locali: blocco, lunghezza 0, priorità e ora (20 byte). */
export function lstackBytes(priority: number, time: S7DateTime): Uint8Array {
  return Uint8Array.from([
    ...u16b(0x08),
    ...u16b(1),
    ...u16b(0),
    ...u16b(0),
    priority,
    0,
    0,
    0,
    ...encodeBcdDateTimeShort(time),
  ]);
}

// ---- la tabella dei job ---------------------------------------------------------------------

export class TisTable {
  private readonly jobs = new Map<number, Job>();
  private counter = 0;

  constructor(private readonly cpu: CpuBackend) {
    cpu.onChange?.((e) => this.onChange(e));
  }

  private next(): number {
    this.counter = (this.counter % 255) + 1;
    return this.counter;
  }

  /** Il passaggio di modo cancella i job (indizio `0xD0C2`/`0xD0C7`); un blocco ricaricato li rende incoerenti. */
  private onChange(e: BackendChange): void {
    if (e.kind === 'mode') {
      this.jobs.clear();
      return;
    }
    for (const j of this.jobs.values()) {
      if (j.r.type === e.type && j.r.number === e.number) j.inconsistent = true;
    }
  }

  /** Alla chiusura della sessione i suoi job spariscono, salvo `orphanJobs`. */
  sessionClosed(session: TisSession): void {
    if (this.cpu.config.faults.orphanJobs) return;
    for (const [id, j] of this.jobs) if (j.owner === session) this.jobs.delete(id);
  }

  /** Un job di un'altra sessione si gestisce solo da quella (`0xD0AE`), salvo `orphanJobs`. */
  private foreign(j: Job, s: TisSession): boolean {
    return j.owner !== s && !this.cpu.config.faults.orphanJobs;
  }

  handle(session: TisSession, req: TisRequest): TisAnswer {
    const seq = this.next();
    const faults = this.cpu.config.faults;
    if (faults.tisError?.sub === req.sub) return { seq, errorCode: faults.tisError.code };
    let ans: TisAnswer;
    switch (req.sub) {
      case TIS_SUB.BLOCK_STATUS:
        ans = this.create(session, seq, req);
        break;
      case TIS_SUB.ENABLE:
        ans = this.enable(session, seq, req);
        break;
      case TIS_SUB.DELETE:
        ans = this.remove(session, seq, req);
        break;
      case TIS_SUB.JOB_LIST:
        ans = this.list(seq, req);
        break;
      case TIS_SUB.ISTACK:
      case TIS_SUB.BSTACK:
      case TIS_SUB.LSTACK:
        ans = this.stack(seq, req);
        break;
      default:
        ans = { seq, errorCode: E.NOT_SUPPORTED };
    }
    if (ans.data && faults.tisMalformed?.includes(req.sub)) {
      ans.data = ans.data.slice(0, MALFORMED_BYTES);
    }
    return ans;
  }

  private create(session: TisSession, seq: number, req: TisRequest): TisAnswer {
    const cpu = this.cpu;
    if (cpu.tisV2 === false || !cpu.blockStatus) return { seq, errorCode: E.NOT_SUPPORTED };
    const d = decodeBlockStatusRequest(req.tisParam, req.tisData);
    if (!d || !d.otherFieldsOk || blockStatusProblem(d.r, d.saz, session.pduLength) !== undefined) {
      return { seq, errorCode: E.BAD_PARAM };
    }
    if (d.p4 !== blockStatusResultSize(d.r)) return { seq, errorCode: E.BAD_BUFFER };
    const exists = cpu.blockExists
      ? cpu.blockExists(d.r.type, d.r.number)
      : cpu.block(d.r.type, d.r.number) !== undefined;
    if (!exists) return { seq, errorCode: E.BAD_ADDRESS };
    // ipotesi di proto §18.4.1: fuori da RUN non c'e' esecuzione, quindi "non permessa nel modo"
    if (cpu.mode !== 'RUN') return { seq, errorCode: E.MODE };
    if (this.jobs.size >= MAX_JOBS) return { seq, errorCode: E.JOBS_FULL };
    for (const j of this.jobs.values()) {
      if (j.owner !== session && j.r.type === d.r.type && j.r.number === d.r.number) {
        return { seq, errorCode: E.TRIGGER_BUSY };
      }
    }
    let id = seq;
    while (this.jobs.has(id)) id = this.next();
    this.jobs.set(id, { id, owner: session, r: d.r, inconsistent: false, waiting: false });
    return { seq: id, errorCode: 0 };
  }

  private target(req: TisRequest, offset: number): Job | undefined {
    const fn = req.tisData[offset];
    const job = this.jobs.get(req.tisData[offset + 1]!);
    return job && fn === TIS_SUB.BLOCK_STATUS ? job : undefined;
  }

  private enable(session: TisSession, seq: number, req: TisRequest): TisAnswer {
    if (!same(req.tisParam, MGMT_PARAM) || req.tisData.length !== 2) {
      return { seq, errorCode: E.BAD_PARAM };
    }
    const j = this.target(req, 0);
    if (!j) return { seq, errorCode: E.NOT_FOUND };
    if (this.foreign(j, session)) return { seq, errorCode: E.OTHER_CONNECTION };
    if (j.inconsistent) return { seq, errorCode: E.INCONSISTENT };
    const after = (): void => {
      if (j.waiting || !this.cpu.blockStatus) return;
      j.waiting = true;
      this.cpu
        .blockStatus(
          j.r.type,
          j.r.number,
          j.r.lines.map((l) => ({ offset: l.offset, mask: l.mask })),
        )
        .then(
          (rows) => {
            j.waiting = false;
            // il job puo' essere sparito (delete, STOP, sessione chiusa) mentre si aspettava il ciclo
            if (rows === undefined || this.jobs.get(j.id) !== j || session.isClosed()) return;
            let data = encodeBlockStatusResult(j.r, rows);
            if (this.cpu.config.faults.tisMalformed?.includes(TIS_SUB.BLOCK_STATUS)) {
              data = data.slice(0, MALFORMED_BYTES);
            }
            session.pushIndication(TIS_SUB.BLOCK_STATUS, j.id, data);
          },
          () => {
            j.waiting = false;
          },
        );
    };
    return { seq, errorCode: 0, after };
  }

  private remove(session: TisSession, seq: number, req: TisRequest): TisAnswer {
    if (!same(req.tisParam, MGMT_PARAM) || req.tisData.length !== 4) {
      return { seq, errorCode: E.BAD_PARAM };
    }
    if (req.tisData[0] !== 0 || req.tisData[1] !== 1) return { seq, errorCode: E.BAD_PARAM };
    const j = this.target(req, 2);
    if (!j) return { seq, errorCode: E.NOT_FOUND };
    if (this.foreign(j, session)) return { seq, errorCode: E.OTHER_CONNECTION };
    this.jobs.delete(j.id);
    return { seq, errorCode: 0 };
  }

  /** I job vivi (funzione, numero) piu' la chiamata stessa (`10 nn`). */
  private list(seq: number, req: TisRequest): TisAnswer {
    if (!same(req.tisParam, JOB_LIST_PARAM) || !same(req.tisData, new Uint8Array(4))) {
      return { seq, errorCode: E.BAD_PARAM };
    }
    const ids = [...this.jobs.keys()].sort((a, b) => a - b);
    const bytes = ids.flatMap((id) => [TIS_SUB.BLOCK_STATUS, id, 0, 0]);
    bytes.push(TIS_SUB.JOB_LIST, seq, 0, 0);
    return { seq, errorCode: 0, data: Uint8Array.from(bytes) };
  }

  private stack(seq: number, req: TisRequest): TisAnswer {
    const lstack = req.sub === TIS_SUB.LSTACK;
    if (!same(req.tisParam, JOB_LIST_PARAM) || req.tisData.length !== 2) {
      return { seq, errorCode: E.BAD_PARAM };
    }
    if (!lstack && (req.tisData[0] !== 0 || req.tisData[1] !== 0)) {
      return { seq, errorCode: E.BAD_PARAM };
    }
    if (!this.cpu.stacks) return { seq, errorCode: E.NOT_SUPPORTED };
    // proto §18.6: gli stack si leggono solo in STOP o in HOLD; in RUN il testo piu' adatto e' D081
    if (this.cpu.mode !== 'STOP' && this.cpu.mode !== 'HOLD') return { seq, errorCode: E.MODE };
    const stacks = this.cpu.stacks();
    if (!stacks) return { seq, errorCode: E.NOT_SUPPORTED };
    const data =
      req.sub === TIS_SUB.ISTACK
        ? stacks.istack
        : req.sub === TIS_SUB.BSTACK
          ? stacks.bstack
          : stacks.lstack(req.tisData[0]!, req.tisData[1]!);
    return { seq, errorCode: 0, data };
  }
}

const tables = new WeakMap<CpuBackend, TisTable>();

/** La tabella dei job della CPU (una per CPU, creata alla prima richiesta TIS). */
export function tisTable(cpu: CpuBackend): TisTable {
  let t = tables.get(cpu);
  if (!t) {
    t = new TisTable(cpu);
    tables.set(cpu, t);
  }
  return t;
}

/** Chiusura di una sessione: toglie i suoi job, se la CPU ha una tabella. */
export function closeTisSession(cpu: CpuBackend, session: TisSession): void {
  tables.get(cpu)?.sessionClosed(session);
}

// ---- byte delle risposte ----------------------------------------------------------------------

/** Parametro userdata di ack (`81`) o indication (`01`): `00 01 12 08 12 TG SS NN 00 00 EE EE`. */
export function tisReplyParam(
  tg: 0x81 | 0x01,
  sub: number,
  seq: number,
  errorCode: number,
): Uint8Array {
  return Uint8Array.of(
    0x00,
    0x01,
    0x12,
    0x08,
    0x12,
    tg,
    sub,
    seq,
    0x00,
    0x00,
    errorCode >> 8,
    errorCode & 0xff,
  );
}

/** Dati di una risposta con dati TIS: parte dati di una richiesta, col parametro TIS `0100 0001`. */
export function tisReplyData(tisData: Uint8Array): Uint8Array {
  return encodeTisRequest(0, Uint8Array.of(0x01, 0x00, 0x00, 0x01), tisData).data;
}

/** Dati di un ack semplice (`0a 00 00 00`, proto §18.1). */
export const TIS_ACK_DATA = Uint8Array.of(0x0a, 0x00, 0x00, 0x00);
