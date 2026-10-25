import { S7Client } from './client';
import { S7Connection, type ConnectOptions } from './connection';
import { S7Error } from './errors';
import { tisFunctionsFrom, type TisFunctions } from './s7/szlDiag';
import {
  TIS_SUB,
  decodeJobList,
  decodeTisReply,
  reqBlockStatus,
  reqDeleteJob,
  reqEnableJob,
  reqReadJobList,
  splitTisPayload,
  tisErrorText,
  type BlockStatusRequest,
  type TisReply,
} from './s7/tis';
import { reqStack } from './s7/tisStacks';
import type { UserdataFrame } from './s7/userdataRequests';

/** Attesa dell'indication di uno stack, se la CPU risponde con un ack invece dei dati subito. */
const STACK_INDICATION_MS = 2000;

const h2 = (n: number): string => `0x${n.toString(16).padStart(2, '0')}`;

function tisError(code: number, what: string): S7Error {
  return new S7Error('CPU_ERROR', `${what}: ${tisErrorText(code)}`, {
    errorClass: code >> 8,
    errorCode: code & 0xff,
  });
}

/**
 * Client con le funzioni di test (TIS, proto §18) per le CPU proprie: apre la connessione sempre
 * in `online-test`. La lettura e' quella di `S7Client`; il filtro ammette in piu' solo il block
 * status, la lista dei job e gli stack, in forma canonica. Un solo job di test per volta.
 */
export class S7TestClient extends S7Client {
  readonly #tconn: S7Connection;

  private constructor(conn: S7Connection) {
    super(conn);
    this.#tconn = conn;
  }

  static override async connect(o: ConnectOptions): Promise<S7TestClient> {
    return new S7TestClient(await S7Connection.open({ ...o, mode: 'online-test' }));
  }

  async #tis(frame: UserdataFrame, what: string): Promise<TisReply> {
    const pdu = await this.#tconn.request(frame.param, frame.data, 7);
    if (pdu.rosctr !== 7)
      throw new S7Error('PROTOCOL', `${what}: risposta con ROSCTR ${pdu.rosctr}`);
    const reply = decodeTisReply(pdu.param, pdu.data);
    if (reply.kind === 'indication' || reply.sub !== frame.param[6]) {
      throw new S7Error(
        'PROTOCOL',
        `${what}: risposta TIS inattesa (sottofunzione ${h2(reply.sub)})`,
      );
    }
    return reply;
  }

  /** Funzioni di test della CPU (SZL 0x0131 indice 2). */
  async tisFunctions(): Promise<TisFunctions> {
    return tisFunctionsFrom(await this.readSzl(0x0131, 2));
  }

  /** I job vivi, compresa la chiamata stessa (`10 nn`). */
  async readJobList(): Promise<{ fn: number; job: number }[]> {
    const r = await this.#tis(reqReadJobList(), 'lista dei job');
    if (r.errorCode !== 0) throw tisError(r.errorCode, 'lista dei job');
    if (!r.tisData) throw new S7Error('PROTOCOL', 'lista dei job: risposta senza dati');
    return decodeJobList(r.tisData);
  }

  /** Crea il job di block status; il numero e' quello dell'ack della creazione (proto §18.1). */
  async createBlockStatus(r: BlockStatusRequest, saz: number): Promise<number> {
    const reply = await this.#tis(reqBlockStatus(r, saz), 'block status');
    if (reply.errorCode !== 0) throw tisError(reply.errorCode, 'block status');
    this.#tconn.reviveIndications(1, TIS_SUB.BLOCK_STATUS, reply.job);
    return reply.job;
  }

  /** Un enable produce esattamente un risultato; `timeout` se non arriva (la connessione resta). */
  async enableAndWait(
    fn: number,
    job: number,
    timeoutMs: number,
  ): Promise<{ result: Uint8Array } | { timeout: true }> {
    const ack = await this.#tis(reqEnableJob(fn, job), 'enable job');
    if (ack.errorCode !== 0) throw tisError(ack.errorCode, 'enable job');
    const ind = await this.#tconn.nextIndication({ group: 1, sub: fn, seq: job }, timeoutMs);
    if (!ind) return { timeout: true };
    const code = ind.param.errorCode ?? 0;
    if (code !== 0) throw tisError(code, 'risultato del job');
    const split = splitTisPayload(ind.payload);
    if (!split) throw new S7Error('PROTOCOL', 'risultato del job senza parametro TIS');
    return { result: split.tisData };
  }

  /** Cancella un job; poi scarta le indication tardive (proto §18.4.1). */
  async deleteJob(fn: number, job: number): Promise<'deleted' | 'notFound' | 'otherConnection'> {
    const r = await this.#tis(reqDeleteJob(fn, job), 'delete job');
    this.#tconn.discardIndications(1, fn, job);
    if (r.errorCode === 0) return 'deleted';
    if (r.errorCode === 0xd0a5) return 'notFound';
    if (r.errorCode === 0xd0ae) return 'otherConnection';
    throw tisError(r.errorCode, 'delete job');
  }

  /** Dati TIS grezzi di uno stack (il chiamante li decodifica con `decodeBStack` & co.). */
  async readStack(
    kind: 'ISTACK' | 'BSTACK' | 'LSTACK',
    args?: { priority: number; depth: number },
  ): Promise<Uint8Array> {
    const what = `stack ${kind}`;
    const r = await this.#tis(reqStack(kind, args), what);
    if (r.errorCode !== 0) throw tisError(r.errorCode, what);
    if (r.tisData) return r.tisData;
    // ipotesi di proto §18.6: i dati possono arrivare anche in una indication
    const ind = await this.#tconn.nextIndication(
      { group: 1, sub: r.sub, seq: r.job },
      STACK_INDICATION_MS,
    );
    const split = ind ? splitTisPayload(ind.payload) : undefined;
    if (!split) throw new S7Error('PROTOCOL', `${what}: la CPU non ha mandato i dati`);
    return split.tisData;
  }
}
