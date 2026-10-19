import { decodeCotp, encodeCotp, type CotpPdu } from './cotp';
import { S7Error } from './errors';
import { FrameReader, encodeTpkt } from './tpkt';
import { LOCAL_TSAP_PG, remoteTsap, type ConnectionType } from './tsap';
import { assertOutgoingFrame } from './readOnlyGuard';
import { decodeS7, encodeS7, type S7Pdu } from './s7/header';
import { decodeSetup, encodeSetup } from './s7/setup';
import type { CaptureRecorder } from './capture/captureLog';
import type { Transport, TransportFactory } from './transport';

export interface ConnectOptions {
  host: string;
  port?: number;
  rack?: number;
  slot?: number;
  connectionType?: ConnectionType;
  localTsap?: number;
  remoteTsap?: number;
  timeoutMs?: number;
  proposedPdu?: number;
  transport?: TransportFactory;
  recorder?: CaptureRecorder;
  signal?: AbortSignal;
}

const DEFAULT_PORT = 102;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_PDU = 480;
const SRC_REF = 0x0100; // proto §2.2, §14
const TPDU_SIZE = 0x0a; // 1024
const MAX_FRAGMENTS = 64; // proto §2.6
const MAX_REASSEMBLED = 0xffff + 16;
const MAX_IGNORED_LOG = 100;

/** Riferimento PDU successivo: cresce di uno, salta lo 0 e si riavvolge a 16 bit. */
export function nextPduRef(prev: number): number {
  return (prev % 0xffff) + 1;
}

interface Pending {
  param: Uint8Array;
  data: Uint8Array;
  rosctr: 1 | 7;
  timeoutMs: number;
  resolve(p: S7Pdu): void;
  reject(e: Error): void;
  ref?: number;
  timer?: ReturnType<typeof setTimeout>;
}

interface CcWaiter {
  resolve(cc: Extract<CotpPdu, { type: 'CR' | 'CC' }>): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const h = (n: number): string => `0x${n.toString(16).padStart(2, '0')}`;

/**
 * Connessione S7 in sola lettura: un solo job in volo, timeout, annullamento, registratore.
 * Ogni byte in uscita passa da `sendFrame`, l'unico punto che chiama `transport.send`.
 */
export class S7Connection {
  pduLength: number;
  amq = 1;
  /** Frame rifiutati dal filtro di sola lettura (mai inviati). */
  refusedCount = 0;
  /** Risposte non attese (riferimento sconosciuto o ROSCTR incoerente), ignorate. */
  ignoredCount = 0;
  readonly ignoredLog: string[] = [];

  private _closed = false;
  private established = false;
  private peerRef = 0;
  private lastRef = 0;
  private current: Pending | undefined;
  private readonly queue: Pending[] = [];
  private ccWaiter: CcWaiter | undefined;
  private readonly reader = new FrameReader();
  private fragments: Uint8Array[] = [];
  private fragmentBytes = 0;
  private abortListener: (() => void) | undefined;

  private constructor(
    private readonly transport: Transport,
    private readonly recorder: CaptureRecorder | undefined,
    private readonly signal: AbortSignal | undefined,
    private readonly defaultTimeoutMs: number,
    proposedPdu: number,
  ) {
    this.pduLength = proposedPdu;
    transport.onData((chunk) => this.onData(chunk));
    transport.onClose((err) =>
      this.fail(
        err instanceof S7Error
          ? err
          : new S7Error('CLOSED', `connessione chiusa${err ? `: ${err.message}` : ''}`),
      ),
    );
    if (signal) {
      this.abortListener = () => this.fail(new S7Error('ABORTED', 'operazione annullata'));
      signal.addEventListener('abort', this.abortListener, { once: true });
    }
  }

  get closed(): boolean {
    return this._closed;
  }

  static async open(o: ConnectOptions): Promise<S7Connection> {
    const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const proposed = o.proposedPdu ?? DEFAULT_PDU;
    const dstTsap = o.remoteTsap ?? remoteTsap(o.connectionType ?? 'pg', o.rack ?? 0, o.slot ?? 2);
    if (o.signal?.aborted) throw new S7Error('ABORTED', 'operazione annullata');
    const factory = o.transport ?? (await defaultTransport());
    const transport = await factory(o.host, o.port ?? DEFAULT_PORT, timeoutMs);
    const conn = new S7Connection(transport, o.recorder, o.signal, timeoutMs, proposed);
    try {
      if (o.signal?.aborted) throw new S7Error('ABORTED', 'operazione annullata');
      await conn.handshake(o.localTsap ?? LOCAL_TSAP_PG, dstTsap, proposed, timeoutMs);
    } catch (e) {
      conn.fail(e instanceof Error ? e : new S7Error('PROTOCOL', String(e)));
      throw e;
    }
    return conn;
  }

  /** Una richiesta alla volta; l'errore della CPU nell'header non è sollevato qui. */
  request(param: Uint8Array, data: Uint8Array, rosctr: 1 | 7, timeoutMs?: number): Promise<S7Pdu> {
    if (this._closed) return Promise.reject(new S7Error('CLOSED', 'connessione chiusa'));
    return new Promise<S7Pdu>((resolve, reject) => {
      this.queue.push({
        param,
        data,
        rosctr,
        timeoutMs: timeoutMs ?? this.defaultTimeoutMs,
        resolve,
        reject,
      });
      this.pump();
    });
  }

  close(): Promise<void> {
    if (this._closed) return Promise.resolve();
    if (this.established) {
      try {
        this.sendFrame(
          encodeTpkt(
            encodeCotp({ type: 'DR', dstRef: this.peerRef, srcRef: SRC_REF, reason: 0x80 }),
          ),
        );
      } catch {
        // chiusura comunque
      }
    }
    this.fail(new S7Error('CLOSED', 'connessione chiusa'));
    return Promise.resolve();
  }

  // ---- apertura ----------------------------------------------------------------------------

  private async handshake(
    srcTsap: number,
    dstTsap: number,
    proposed: number,
    timeoutMs: number,
  ): Promise<void> {
    const cc = new Promise<Extract<CotpPdu, { type: 'CR' | 'CC' }>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new S7Error('CONNECT_TIMEOUT', `nessun CC dalla CPU entro ${timeoutMs} ms`)),
        timeoutMs,
      );
      this.ccWaiter = { resolve, reject, timer };
    });
    this.sendFrame(
      encodeTpkt(
        encodeCotp({
          type: 'CR',
          dstRef: 0,
          srcRef: SRC_REF,
          tpduSize: TPDU_SIZE,
          srcTsap,
          dstTsap,
        }),
      ),
    );
    const confirm = await cc;
    this.peerRef = confirm.srcRef;
    this.established = true;
    const res = await this.request(
      encodeSetup({ amqCalling: 1, amqCalled: 1, pduLength: proposed }),
      new Uint8Array(0),
      1,
      timeoutMs,
    );
    if (res.rosctr !== 3 && res.rosctr !== 2) {
      throw new S7Error('PROTOCOL', `risposta al setup con ROSCTR ${res.rosctr}`);
    }
    if (res.errorClass !== 0 || res.errorCode !== 0) {
      throw new S7Error(
        'CPU_ERROR',
        `setup rifiutato dalla CPU: classe ${h(res.errorClass)} codice ${h(res.errorCode)}`,
        { errorClass: res.errorClass, errorCode: res.errorCode },
      );
    }
    const s = decodeSetup(res.param);
    if (s.pduLength < 20)
      throw new S7Error('PROTOCOL', `PDU negoziata ${s.pduLength} troppo piccola`);
    // Si adotta il valore della CPU, mai oltre la proposta; un job alla volta comunque.
    this.pduLength = Math.min(s.pduLength, proposed);
    this.amq = Math.max(1, Math.min(s.amqCalling, s.amqCalled));
  }

  // ---- invio -------------------------------------------------------------------------------

  /**
   * L'unico punto che invia byte. Ri-decodifica i byte finali (TPKT, COTP, S7) e li passa a
   * `assertOutgoingFrame`; solo se il filtro accetta registra e invia.
   */
  private sendFrame(bytes: Uint8Array): void {
    try {
      assertOutgoingFrame(bytes);
    } catch (e) {
      this.refusedCount++;
      throw e;
    }
    this.recorder?.record('tx', bytes.subarray(4));
    this.transport.send(bytes);
  }

  private pump(): void {
    while (!this._closed && this.established && !this.current && this.queue.length > 0) {
      const p = this.queue.shift()!;
      const ref = nextPduRef(this.lastRef);
      this.lastRef = ref;
      let frame: Uint8Array;
      try {
        const s7 = encodeS7({
          rosctr: p.rosctr,
          pduRef: ref,
          errorClass: 0,
          errorCode: 0,
          param: p.param,
          data: p.data,
        });
        if (s7.length > this.pduLength) {
          throw new RangeError(`PDU di ${s7.length} byte oltre la PDU negoziata ${this.pduLength}`);
        }
        frame = encodeTpkt(encodeCotp({ type: 'DT', eot: true, data: s7 }));
      } catch (e) {
        p.reject(e instanceof Error ? e : new Error(String(e)));
        continue;
      }
      try {
        this.sendFrame(frame);
      } catch (e) {
        if (e instanceof S7Error && e.code === 'FORBIDDEN') {
          p.reject(e);
          continue;
        }
        p.reject(
          new S7Error('CLOSED', `invio fallito: ${e instanceof Error ? e.message : String(e)}`),
        );
        this.fail(new S7Error('CLOSED', 'invio fallito'));
        return;
      }
      p.ref = ref;
      p.timer = setTimeout(
        () =>
          this.fail(
            new S7Error('TIMEOUT', `nessuna risposta entro ${p.timeoutMs} ms (riferimento ${ref})`),
          ),
        p.timeoutMs,
      );
      this.current = p;
    }
  }

  // ---- ricezione ---------------------------------------------------------------------------

  private onData(chunk: Uint8Array): void {
    if (this._closed) return;
    try {
      for (const payload of this.reader.push(chunk)) {
        if (this._closed) return;
        this.recorder?.record('rx', payload);
        this.onCotp(decodeCotp(payload));
      }
    } catch (e) {
      this.fail(e instanceof S7Error ? e : new S7Error('PROTOCOL', String(e)));
    }
  }

  private onCotp(c: CotpPdu): void {
    switch (c.type) {
      case 'CC': {
        const w = this.ccWaiter;
        if (!w) throw new S7Error('PROTOCOL', 'CC inatteso a connessione aperta');
        this.ccWaiter = undefined;
        clearTimeout(w.timer);
        w.resolve(c);
        return;
      }
      case 'DR':
      case 'ER': {
        const why =
          c.type === 'DR'
            ? `DR dalla CPU, motivo ${h(c.reason)}`
            : `ER dalla CPU, causa ${h(c.cause)}`;
        const w = this.ccWaiter;
        if (w) {
          this.ccWaiter = undefined;
          clearTimeout(w.timer);
          w.reject(new S7Error('COTP_REJECTED', `connessione COTP rifiutata: ${why}`));
        } else {
          this.fail(new S7Error('CLOSED', `la CPU ha chiuso la connessione: ${why}`));
        }
        return;
      }
      case 'CR':
        throw new S7Error('PROTOCOL', 'CR ricevuto dalla CPU');
      case 'DT': {
        if (!this.established) throw new S7Error('PROTOCOL', 'dati prima del CC');
        this.fragments.push(c.data);
        this.fragmentBytes += c.data.length;
        if (this.fragments.length > MAX_FRAGMENTS || this.fragmentBytes > MAX_REASSEMBLED) {
          throw new S7Error('PROTOCOL', 'PDU S7 frammentata oltre i limiti');
        }
        if (!c.eot) return;
        const whole = new Uint8Array(this.fragmentBytes);
        let at = 0;
        for (const f of this.fragments) {
          whole.set(f, at);
          at += f.length;
        }
        this.fragments = [];
        this.fragmentBytes = 0;
        this.onPdu(decodeS7(whole));
        return;
      }
    }
  }

  private onPdu(pdu: S7Pdu): void {
    if (pdu.rosctr === 1) {
      // La CPU non deve mandare job; il client non risponde mai.
      const fn = pdu.param.length > 0 ? h(pdu.param[0]!) : 'vuota';
      throw new S7Error('PROTOCOL', `job dalla CPU (funzione ${fn}): connessione chiusa`);
    }
    const cur = this.current;
    const consistent =
      cur !== undefined && (cur.rosctr === 7 ? pdu.rosctr === 7 : pdu.rosctr !== 7);
    if (!cur || pdu.pduRef !== cur.ref || !consistent) {
      this.ignoredCount++;
      if (this.ignoredLog.length < MAX_IGNORED_LOG) {
        this.ignoredLog.push(`risposta ignorata: ROSCTR ${pdu.rosctr}, riferimento ${pdu.pduRef}`);
      }
      return;
    }
    this.current = undefined;
    clearTimeout(cur.timer);
    cur.resolve(pdu);
    this.pump();
  }

  // ---- chiusura ----------------------------------------------------------------------------

  /** Chiude in modo definitivo: ogni promessa in sospeso viene rifiutata. Idempotente. */
  private fail(err: Error): void {
    if (this._closed) return;
    this._closed = true;
    if (this.signal && this.abortListener) {
      this.signal.removeEventListener('abort', this.abortListener);
    }
    const w = this.ccWaiter;
    this.ccWaiter = undefined;
    if (w) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    const cur = this.current;
    this.current = undefined;
    const queued = this.queue.splice(0);
    const aborted = err instanceof S7Error && err.code === 'ABORTED';
    if (cur) {
      clearTimeout(cur.timer);
      cur.reject(err);
    }
    for (const q of queued) q.reject(aborted ? err : new S7Error('CLOSED', 'connessione chiusa'));
    try {
      this.transport.close();
    } catch {
      // già chiuso
    }
  }
}

async function defaultTransport(): Promise<TransportFactory> {
  const m = await import('./node/tcpTransport');
  return m.tcpTransport;
}
