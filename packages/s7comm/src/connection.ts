import { decodeCotp, encodeCotp, type CotpPdu } from './cotp';
import { S7Error } from './errors';
import { FrameReader, encodeTpkt } from './tpkt';
import { LOCAL_TSAP_PG, remoteTsap, type ConnectionType } from './tsap';
import { assertOutgoingFrame, type ConnectionMode } from './readOnlyGuard';
import type { BlockType } from './s7/blocks';
import { decodeDownloadBlockJob, decodeDownloadEnded, encodeDownloadBlockAck } from './s7/download';
import { decodeS7, encodeS7, type S7Pdu } from './s7/header';
import { decodeSetup, encodeSetup } from './s7/setup';
import { decodeUserdata, type DecodedUserdata } from './s7/userdata';
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
  /** Obbligatorio: il nucleo non sceglie un trasporto (vedi `openTcp` in `./node`). */
  transport: TransportFactory;
  recorder?: CaptureRecorder;
  signal?: AbortSignal;
  /** Fissato all'apertura, mai modificabile. Default `'read-only'`. */
  mode?: ConnectionMode;
}

const DEFAULT_PORT = 102;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_PDU = 480;
const SRC_REF = 0x0100; // proto §2.2, §14
const TPDU_SIZE = 0x0a; // 1024
const MAX_FRAGMENTS = 64; // proto §2.6
const MAX_REASSEMBLED = 0xffff + 16;
const MAX_IGNORED_LOG = 100;
/** Indication (proto §18.1) tenute in coda in modo `online-test`: le più vecchie si scartano. */
const MAX_INDICATIONS = 8;

/** Riferimento PDU successivo: cresce di uno, salta lo 0 e si riavvolge a 16 bit. */
export function nextPduRef(prev: number): number {
  return (prev % 0xffff) + 1;
}

// BEGIN CHOKE POINT
/**
 * L'unico punto del pacchetto che invia byte a un `Transport`. Lavora su una copia privata
 * (nessun altro la possiede), la fa controllare da `assertOutgoingFrame`, la invia e solo dopo
 * la consegna la dà al registratore (altra copia, errori ignorati).
 */
export function guardedSender(
  transport: Pick<Transport, 'send'>,
  recorder: CaptureRecorder | undefined,
  onRefused: () => void,
  mode: ConnectionMode = 'read-only',
  pduLength?: () => number,
): (frame: Uint8Array) => void {
  return (frame) => {
    const out = frame.slice();
    try {
      assertOutgoingFrame(out, mode, pduLength?.());
    } catch (e) {
      onRefused();
      throw e;
    }
    // Copia per il registratore presa PRIMA dell'invio: un trasporto che modificasse i byte
    // ricevuti non può alterare ciò che la cattura mostra (sempre i byte approvati).
    const recorded = recorder ? out.slice(4) : undefined;
    transport.send(out);
    if (recorder && recorded) {
      try {
        recorder.record('tx', recorded);
      } catch {
        // un registratore difettoso non tocca la connessione
      }
    }
  };
}
// END CHOKE POINT

interface Pending {
  param: Uint8Array;
  data: Uint8Array;
  rosctr: 1 | 3 | 7;
  timeoutMs: number;
  resolve(p: S7Pdu): void;
  reject(e: Error): void;
  ref?: number;
  timer?: ReturnType<typeof setTimeout>;
}

interface DownloadState {
  provideChunk(job: { type: BlockType; number: number }): { eos: boolean; chunk: Uint8Array };
  onEnded(job: { type: BlockType; number: number }): void;
  timeoutMs: number;
  resolve(): void;
  reject(e: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

/** Quale indication si aspetta: gruppo, sottofunzione e seq (il numero del job). */
export interface IndicationMatch {
  group: number;
  sub: number;
  seq: number;
}

interface IndicationWaiter {
  match: IndicationMatch;
  resolve(d: DecodedUserdata | undefined): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
  signal?: AbortSignal;
}

interface CcWaiter {
  resolve(cc: Extract<CotpPdu, { type: 'CR' | 'CC' }>): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const h = (n: number): string => `0x${n.toString(16).padStart(2, '0')}`;

function matches(d: DecodedUserdata, m: IndicationMatch): boolean {
  return d.param.group === m.group && d.param.subfunction === m.sub && d.param.sequence === m.seq;
}

/**
 * Connessione S7 in sola lettura: un solo job in volo, timeout, annullamento, registratore.
 * Il `Transport` non è mai conservato sull'istanza: la classe tiene solo il mittente filtrato
 * (`guardedSender`) e le funzioni di chiusura, in campi `#privati`.
 */
export class S7Connection {
  /** Frame rifiutati dal filtro di sola lettura (mai inviati). */
  refusedCount = 0;
  /** Risposte non attese (riferimento sconosciuto o ROSCTR incoerente), ignorate. */
  ignoredCount = 0;
  readonly ignoredLog: string[] = [];

  #pduLength: number;
  #amq = 1;
  #closed = false;
  #closing = false;
  #established = false;
  #peerRef = 0;
  #lastRef = 0;
  #current: Pending | undefined;
  readonly #queue: Pending[] = [];
  #ccWaiter: CcWaiter | undefined;
  readonly #reader = new FrameReader();
  #fragments: Uint8Array[] = [];
  #fragmentBytes = 0;
  #abortListener: (() => void) | undefined;
  readonly #sendFrame: (frame: Uint8Array) => void;
  readonly #closeTransport: () => void;
  readonly #signal: AbortSignal | undefined;
  readonly #defaultTimeoutMs: number;
  #download: DownloadState | undefined;
  readonly #mode: ConnectionMode;
  #tpduCap = Infinity;
  readonly #indications: DecodedUserdata[] = [];
  readonly #indicationWaiters: IndicationWaiter[] = [];
  /** Job cancellati (`gruppo/sub/seq`): le indication tardive si scartano (proto §18.4.1). */
  readonly #deadJobs = new Set<string>();
  readonly #rec: CaptureRecorder | undefined;

  private constructor(
    transport: Transport,
    recorder: CaptureRecorder | undefined,
    signal: AbortSignal | undefined,
    defaultTimeoutMs: number,
    proposedPdu: number,
    mode: ConnectionMode,
  ) {
    this.#mode = mode;
    this.#rec = recorder;
    this.#pduLength = proposedPdu;
    this.#defaultTimeoutMs = defaultTimeoutMs;
    this.#signal = signal;
    this.#sendFrame = guardedSender(
      transport,
      recorder,
      () => {
        this.refusedCount++;
      },
      mode,
      () => this.#pduLength,
    );
    this.#closeTransport = () => transport.close();
    transport.onData((chunk) => this.#onData(chunk));
    transport.onClose((err) =>
      this.#fail(
        err instanceof S7Error
          ? err
          : new S7Error('CLOSED', `connessione chiusa${err ? `: ${err.message}` : ''}`),
      ),
    );
    if (signal && !this.#closed) {
      if (signal.aborted) {
        this.#fail(new S7Error('ABORTED', 'operazione annullata'));
      } else {
        this.#abortListener = () => this.#fail(new S7Error('ABORTED', 'operazione annullata'));
        signal.addEventListener('abort', this.#abortListener, { once: true });
      }
    }
  }

  get pduLength(): number {
    return this.#pduLength;
  }

  get amq(): number {
    return this.#amq;
  }

  get closed(): boolean {
    return this.#closed;
  }

  static async open(o: ConnectOptions): Promise<S7Connection> {
    const mode = o.mode ?? 'read-only';
    if (
      mode !== 'read-only' &&
      mode !== 'online-write' &&
      mode !== 'online-test' &&
      mode !== 'online-restore'
    ) {
      throw new RangeError(`modo "${String(mode)}" sconosciuto`);
    }
    const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const proposed = o.proposedPdu ?? DEFAULT_PDU;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError(`timeoutMs ${timeoutMs} deve essere > 0`);
    }
    if (!Number.isInteger(proposed) || proposed < 240 || proposed > 960) {
      throw new RangeError(`proposedPdu ${proposed} fuori 240-960`);
    }
    for (const [name, v] of [
      ['localTsap', o.localTsap],
      ['remoteTsap', o.remoteTsap],
    ] as const) {
      if (v !== undefined && (!Number.isInteger(v) || v < 0 || v > 0xffff)) {
        throw new RangeError(`${name} ${v} fuori 0-65535`);
      }
    }
    const dstTsap = o.remoteTsap ?? remoteTsap(o.connectionType ?? 'pg', o.rack ?? 0, o.slot ?? 2);
    if (o.signal?.aborted) throw new S7Error('ABORTED', 'operazione annullata');
    const transport = await o.transport(o.host, o.port ?? DEFAULT_PORT, timeoutMs, o.signal);
    const conn = new S7Connection(transport, o.recorder, o.signal, timeoutMs, proposed, mode);
    try {
      if (conn.#closed) {
        // Una fabbrica che ignora il segnale e risolve dopo l'abort: ABORTED, non CLOSED.
        throw o.signal?.aborted
          ? new S7Error('ABORTED', 'operazione annullata')
          : new S7Error('CLOSED', "connessione chiusa durante l'apertura");
      }
      await conn.#handshake(o.localTsap ?? LOCAL_TSAP_PG, dstTsap, proposed, timeoutMs);
    } catch (e) {
      conn.#fail(e instanceof Error ? e : new S7Error('PROTOCOL', String(e)));
      throw e;
    }
    return conn;
  }

  /** Una richiesta alla volta; l'errore della CPU nell'header non è sollevato qui. */
  request(
    param: Uint8Array,
    data: Uint8Array,
    rosctr: 1 | 3 | 7,
    timeoutMs?: number,
  ): Promise<S7Pdu> {
    if (rosctr === 3 && this.#mode !== 'online-write' && this.#mode !== 'online-restore') {
      return Promise.reject(
        new RangeError('ROSCTR 3 ammesso solo in modo online-write e online-restore'),
      );
    }
    if (this.#closed) return Promise.reject(new S7Error('CLOSED', 'connessione chiusa'));
    const t = timeoutMs ?? this.#defaultTimeoutMs;
    if (!Number.isFinite(t) || t <= 0) {
      return Promise.reject(new RangeError(`timeoutMs ${t} deve essere > 0`));
    }
    return new Promise<S7Pdu>((resolve, reject) => {
      this.#queue.push({ param, data, rosctr, timeoutMs: t, resolve, reject });
      this.#pump();
    });
  }

  /**
   * Aspetta una indication (proto §18.1), solo in modo `online-test`. Una già in coda si
   * consegna subito. `undefined` vuol dire tempo scaduto: la connessione resta aperta.
   */
  nextIndication(
    match: IndicationMatch,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<DecodedUserdata | undefined> {
    if (this.#mode !== 'online-test') {
      return Promise.reject(new RangeError('indication ammesse solo in modo online-test'));
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new RangeError(`timeoutMs ${timeoutMs} deve essere > 0`));
    }
    const at = this.#indications.findIndex((d) => matches(d, match));
    if (at >= 0) return Promise.resolve(this.#indications.splice(at, 1)[0]);
    if (this.#closed) return Promise.reject(new S7Error('CLOSED', 'connessione chiusa'));
    if (signal?.aborted) return Promise.reject(new S7Error('ABORTED', 'operazione annullata'));
    return new Promise((resolve, reject) => {
      const w: IndicationWaiter = {
        match,
        resolve,
        reject,
        timer: setTimeout(() => this.#endWaiter(w, undefined), timeoutMs),
        signal,
      };
      if (signal) {
        w.onAbort = () => this.#endWaiter(w, new S7Error('ABORTED', 'operazione annullata'));
        signal.addEventListener('abort', w.onAbort, { once: true });
      }
      this.#indicationWaiters.push(w);
    });
  }

  #endWaiter(w: IndicationWaiter, err: Error | undefined, value?: DecodedUserdata): void {
    const i = this.#indicationWaiters.indexOf(w);
    if (i < 0) return;
    this.#indicationWaiters.splice(i, 1);
    clearTimeout(w.timer);
    if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort);
    if (err) w.reject(err);
    else w.resolve(value);
  }

  /** Dopo un delete: toglie dalla coda le indication del job e scarta quelle che arriveranno. */
  discardIndications(group: number, sub: number, seq: number): void {
    this.#deadJobs.add(`${group}/${sub}/${seq}`);
    const keep = this.#indications.filter((d) => !matches(d, { group, sub, seq }));
    this.#indications.length = 0;
    this.#indications.push(...keep);
    // chi aspetta ancora il job cancellato smette subito: non deve prendere il risultato di un job
    // nuovo con lo stesso numero
    for (const w of [...this.#indicationWaiters]) {
      if (w.match.group === group && w.match.sub === sub && w.match.seq === seq)
        this.#endWaiter(w, undefined);
    }
  }

  /** Un job appena creato con questo numero: le sue indication tornano a valere. */
  reviveIndications(group: number, sub: number, seq: number): void {
    this.#deadJobs.delete(`${group}/${sub}/${seq}`);
  }

  /** Indication non sollecitata (type 0): coda in `online-test`, altrimenti scartata (come prima). */
  #onIndication(pdu: S7Pdu): void {
    let d: DecodedUserdata | undefined;
    if (this.#mode === 'online-test') {
      try {
        d = decodeUserdata(pdu.param, pdu.data);
      } catch {
        d = undefined;
      }
    }
    if (!d) return this.#ignore(pdu);
    if (this.#deadJobs.has(`${d.param.group}/${d.param.subfunction}/${d.param.sequence}`)) {
      this.ignoredCount++;
      return;
    }
    const w = this.#indicationWaiters.find((x) => matches(d, x.match));
    if (w) return this.#endWaiter(w, undefined, d);
    this.#indications.push(d);
    if (this.#indications.length > MAX_INDICATIONS) {
      this.#indications.shift();
      this.ignoredCount++;
    }
  }

  #ignore(pdu: S7Pdu): void {
    this.ignoredCount++;
    if (this.ignoredLog.length < MAX_IGNORED_LOG) {
      this.ignoredLog.push(`risposta ignorata: ROSCTR ${pdu.rosctr}, riferimento ${pdu.pduRef}`);
    }
  }

  /**
   * Transazione di download (proto §10.2), solo `online-write`: invia il request 0x1A, attende
   * l'ack, poi risponde ai job 0x1B della CPU con ack-data (ruoli invertiti) fino al job 0x1C.
   * Un job di altra funzione o un timeout chiudono la connessione (PROTOCOL/TIMEOUT) e la
   * promessa viene rifiutata: nessuna promessa resta appesa.
   */
  async runDownload(
    request: Uint8Array,
    provideChunk: DownloadState['provideChunk'],
    onEnded: DownloadState['onEnded'],
    timeoutMs?: number,
  ): Promise<void> {
    if (this.#mode !== 'online-write' && this.#mode !== 'online-restore') {
      throw new S7Error('FORBIDDEN', 'download non ammesso in modo read-only');
    }
    if (this.#closed) throw new S7Error('CLOSED', 'connessione chiusa');
    if (this.#download) throw new RangeError('download già in corso');
    const t = timeoutMs ?? this.#defaultTimeoutMs;
    if (!Number.isFinite(t) || t <= 0) throw new RangeError(`timeoutMs ${t} deve essere > 0`);
    // Lo stato esiste prima dell'invio: un job 0x1B arrivato nello stesso segmento dell'ack 0x1A
    // viene gestito subito, prima che questa funzione riprenda.
    const done = new Promise<void>((resolve, reject) => {
      this.#download = { provideChunk, onEnded, timeoutMs: t, resolve, reject };
    });
    done.catch(() => undefined);
    const st = this.#download!;
    try {
      const res = await this.request(request, new Uint8Array(0), 1, t);
      if (res.rosctr !== 3 && res.rosctr !== 2) {
        throw new S7Error('PROTOCOL', `risposta al request download con ROSCTR ${res.rosctr}`);
      }
      if (res.errorClass !== 0 || res.errorCode !== 0) {
        throw new S7Error(
          'CPU_ERROR',
          `request download rifiutato dalla CPU: classe ${h(res.errorClass)} codice ${h(res.errorCode)}`,
          { errorClass: res.errorClass, errorCode: res.errorCode },
        );
      }
      if (res.param[0] !== 0x1a) {
        throw new S7Error('PROTOCOL', 'ack del request download con funzione inattesa');
      }
    } catch (e) {
      this.#endDownload(st);
      throw e;
    }
    if (this.#isActiveDownload(st) && !st.timer) this.#armDownload(st);
    return done;
  }

  #armDownload(st: DownloadState): void {
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(
      () =>
        this.#fail(
          new S7Error('TIMEOUT', `nessun job dalla CPU nel download entro ${st.timeoutMs} ms`),
        ),
      st.timeoutMs,
    );
  }

  #isActiveDownload(st: DownloadState): boolean {
    return this.#download === st;
  }

  #endDownload(st: DownloadState): void {
    if (st.timer) clearTimeout(st.timer);
    if (this.#download === st) this.#download = undefined;
  }

  /** Job della CPU dentro `runDownload`: risponde con ack-data (ROSCTR 3), stesso riferimento. */
  #onDownloadJob(st: DownloadState, pdu: S7Pdu): void {
    const fn = pdu.param[0];
    let param: Uint8Array;
    let data: Uint8Array;
    if (fn === 0x1b) {
      const job = decodeDownloadBlockJob(pdu.param);
      const r = st.provideChunk({ type: job.type, number: job.number });
      ({ param, data } = encodeDownloadBlockAck(r.eos, r.chunk));
    } else if (fn === 0x1c) {
      const job = decodeDownloadEnded(pdu.param);
      st.onEnded({ type: job.type, number: job.number });
      param = Uint8Array.of(0x1c);
      data = new Uint8Array(0);
    } else {
      const f = fn === undefined ? 'vuota' : h(fn);
      throw new S7Error('PROTOCOL', `job dalla CPU (funzione ${f}) durante il download`);
    }
    const s7 = encodeS7({
      rosctr: 3,
      pduRef: pdu.pduRef,
      errorClass: 0,
      errorCode: 0,
      param,
      data,
    });
    if (s7.length > this.#pduLength) {
      throw new RangeError(`PDU di ${s7.length} byte oltre la PDU negoziata ${this.#pduLength}`);
    }
    this.#sendFrame(encodeTpkt(encodeCotp({ type: 'DT', eot: true, data: s7 })));
    if (fn === 0x1c) {
      this.#endDownload(st);
      st.resolve();
    } else {
      this.#armDownload(st);
    }
  }

  close(): Promise<void> {
    if (this.#closed || this.#closing) return Promise.resolve();
    this.#closing = true;
    if (this.#established) {
      try {
        this.#sendFrame(
          encodeTpkt(
            encodeCotp({ type: 'DR', dstRef: this.#peerRef, srcRef: SRC_REF, reason: 0x80 }),
          ),
        );
      } catch {
        // chiusura comunque
      }
    }
    this.#fail(new S7Error('CLOSED', 'connessione chiusa'));
    return Promise.resolve();
  }

  // ---- apertura ----------------------------------------------------------------------------

  async #handshake(
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
      this.#ccWaiter = { resolve, reject, timer };
    });
    cc.catch(() => undefined); // l'errore arriva da `await cc` o dal catch sotto
    try {
      this.#sendFrame(
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
    } catch (e) {
      const w = this.#ccWaiter;
      this.#ccWaiter = undefined;
      if (w) clearTimeout(w.timer);
      throw e;
    }
    const confirm = await cc;
    this.#peerRef = confirm.srcRef;
    if (confirm.tpduSize !== undefined && confirm.tpduSize <= 16) {
      // Il TPDU della CPU può essere più piccolo del nostro: la PDU S7 deve entrare in un DT.
      this.#tpduCap = 2 ** confirm.tpduSize - 3;
      if (this.#tpduCap < 20) {
        throw new S7Error(
          'COTP_REJECTED',
          `TPDU-size ${h(confirm.tpduSize)} della CPU troppo piccola per S7`,
        );
      }
    }
    this.#established = true;
    const res = await this.request(
      encodeSetup({ amqCalling: 1, amqCalled: 1, pduLength: Math.min(proposed, this.#tpduCap) }),
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
    if (s.pduLength < 20) {
      throw new S7Error('PROTOCOL', `PDU negoziata ${s.pduLength} troppo piccola`);
    }
    // Si adotta il valore della CPU, mai oltre la proposta né oltre il TPDU; un job alla volta.
    this.#pduLength = Math.min(s.pduLength, proposed, this.#tpduCap);
    this.#amq = Math.max(1, Math.min(s.amqCalling, s.amqCalled));
  }

  // ---- invio -------------------------------------------------------------------------------

  #pump(): void {
    while (!this.#closed && this.#established && !this.#current && this.#queue.length > 0) {
      const p = this.#queue.shift()!;
      const ref = nextPduRef(this.#lastRef);
      this.#lastRef = ref;
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
        if (s7.length > this.#pduLength) {
          throw new RangeError(
            `PDU di ${s7.length} byte oltre la PDU negoziata ${this.#pduLength}`,
          );
        }
        frame = encodeTpkt(encodeCotp({ type: 'DT', eot: true, data: s7 }));
      } catch (e) {
        p.reject(e instanceof Error ? e : new Error(String(e)));
        continue;
      }
      // `current` e il timer esistono prima dell'invio: se la connessione si chiude durante
      // l'invio (trasporto o registratore), `#fail` rifiuta anche questa richiesta.
      p.ref = ref;
      p.timer = setTimeout(
        () =>
          this.#fail(
            new S7Error('TIMEOUT', `nessuna risposta entro ${p.timeoutMs} ms (riferimento ${ref})`),
          ),
        p.timeoutMs,
      );
      this.#current = p;
      try {
        this.#sendFrame(frame);
      } catch (e) {
        if (this.#current === p) {
          this.#current = undefined;
          clearTimeout(p.timer);
        }
        if (e instanceof S7Error && e.code === 'FORBIDDEN') {
          p.reject(e);
          continue;
        }
        p.reject(
          new S7Error('CLOSED', `invio fallito: ${e instanceof Error ? e.message : String(e)}`),
        );
        this.#fail(new S7Error('CLOSED', 'invio fallito'));
        return;
      }
    }
  }

  // ---- ricezione ---------------------------------------------------------------------------

  #onData(chunk: Uint8Array): void {
    if (this.#closed) return;
    try {
      for (const payload of this.#reader.push(chunk)) {
        if (this.#closed) return;
        this.#recordRx(payload);
        this.#onCotp(decodeCotp(payload));
      }
    } catch (e) {
      this.#fail(e instanceof S7Error ? e : new S7Error('PROTOCOL', String(e)));
    }
  }

  #recordRx(payload: Uint8Array): void {
    try {
      this.#rec?.record('rx', payload.slice());
    } catch {
      // un registratore difettoso non tocca la connessione
    }
  }

  #onCotp(c: CotpPdu): void {
    switch (c.type) {
      case 'CC': {
        const w = this.#ccWaiter;
        if (!w) throw new S7Error('PROTOCOL', 'CC inatteso a connessione aperta');
        this.#ccWaiter = undefined;
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
        const w = this.#ccWaiter;
        if (w) {
          this.#ccWaiter = undefined;
          clearTimeout(w.timer);
          w.reject(new S7Error('COTP_REJECTED', `connessione COTP rifiutata: ${why}`));
        } else {
          this.#fail(new S7Error('CLOSED', `la CPU ha chiuso la connessione: ${why}`));
        }
        return;
      }
      case 'CR':
        throw new S7Error('PROTOCOL', 'CR ricevuto dalla CPU');
      case 'DT': {
        if (!this.#established) throw new S7Error('PROTOCOL', 'dati prima del CC');
        this.#fragments.push(c.data);
        this.#fragmentBytes += c.data.length;
        if (this.#fragments.length > MAX_FRAGMENTS || this.#fragmentBytes > MAX_REASSEMBLED) {
          throw new S7Error('PROTOCOL', 'PDU S7 frammentata oltre i limiti');
        }
        if (!c.eot) return;
        const whole = new Uint8Array(this.#fragmentBytes);
        let at = 0;
        for (const f of this.#fragments) {
          whole.set(f, at);
          at += f.length;
        }
        this.#fragments = [];
        this.#fragmentBytes = 0;
        this.#onPdu(decodeS7(whole));
        return;
      }
    }
  }

  #onPdu(pdu: S7Pdu): void {
    if (pdu.rosctr === 1 && this.#download && !this.#current) {
      // Inversione dei ruoli del download (proto §10.2): solo dopo l'ack del request 0x1A.
      this.#onDownloadJob(this.#download, pdu);
      return;
    }
    if (pdu.rosctr === 1) {
      // La CPU non deve mandare job; il client non risponde mai.
      const fn = pdu.param.length > 0 ? h(pdu.param[0]!) : 'vuota';
      throw new S7Error('PROTOCOL', `job dalla CPU (funzione ${fn}): connessione chiusa`);
    }
    if (pdu.rosctr === 7 && pdu.param.length > 5 && pdu.param[5]! >> 4 === 0) {
      // Indication (tg 0x?1 con nibble 0): non risolve mai la richiesta in corso, il pduRef e' ignoto.
      this.#onIndication(pdu);
      return;
    }
    const cur = this.#current;
    const consistent =
      cur !== undefined && (cur.rosctr === 7 ? pdu.rosctr === 7 : pdu.rosctr !== 7);
    if (!cur || pdu.pduRef !== cur.ref || !consistent) {
      this.#ignore(pdu);
      return;
    }
    this.#current = undefined;
    clearTimeout(cur.timer);
    cur.resolve(pdu);
    this.#pump();
  }

  // ---- chiusura ----------------------------------------------------------------------------

  /** Chiude in modo definitivo: ogni promessa in sospeso viene rifiutata. Idempotente. */
  #fail(err: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#signal && this.#abortListener) {
      this.#signal.removeEventListener('abort', this.#abortListener);
    }
    const w = this.#ccWaiter;
    this.#ccWaiter = undefined;
    if (w) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    const dl = this.#download;
    this.#download = undefined;
    if (dl) {
      if (dl.timer) clearTimeout(dl.timer);
      dl.reject(err);
    }
    for (const w of this.#indicationWaiters.slice()) this.#endWaiter(w, err);
    this.#indications.length = 0;
    const cur = this.#current;
    this.#current = undefined;
    const queued = this.#queue.splice(0);
    const aborted = err instanceof S7Error && err.code === 'ABORTED';
    if (cur) {
      clearTimeout(cur.timer);
      cur.reject(err);
    }
    for (const q of queued) q.reject(aborted ? err : new S7Error('CLOSED', 'connessione chiusa'));
    try {
      this.#closeTransport();
    } catch {
      // già chiuso
    }
  }
}
