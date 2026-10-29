import { decodeCotp, encodeCotp, type CotpPdu } from './cotp';
import { S7Error } from './errors';
import { FrameReader, encodeTpkt } from './tpkt';
import { assertOutgoingFrame, type ConnectionMode } from './readOnlyGuard';
import type { CaptureRecorder } from './capture/captureLog';
import type { Transport, TransportFactory } from './transport';

/**
 * Collegamento che sposta PDU S7 intere, senza dire come (ISO-on-TCP, adattatore MPI...).
 * `S7Connection` gli passa solo PDU già approvate dal controllo di sola lettura.
 */
export interface PduLink {
  /** PDU S7 intera (dall'intestazione 0x32), già passata dal controllo di sola lettura. */
  sendPdu(s7: Uint8Array): void;
  onPdu(cb: (s7: Uint8Array) => void): void;
  onClose(cb: (err?: Error) => void): void;
  close(): Promise<void>;
}

/** Apre un link pronto a portare PDU (handshake del link compreso). */
export type PduLinkFactory = (o: { timeoutMs: number; signal?: AbortSignal }) => Promise<PduLink>;

const SRC_REF = 0x0100; // proto §2.2, §14
const TPDU_SIZE = 0x0a; // 1024
const MAX_FRAGMENTS = 64; // proto §2.6
const MAX_REASSEMBLED = 0xffff + 16;

const h = (n: number): string => `0x${n.toString(16).padStart(2, '0')}`;

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

export interface IsoTcpOptions {
  host: string;
  port: number;
  transport: TransportFactory;
  srcTsap: number;
  dstTsap: number;
  timeoutMs: number;
  signal?: AbortSignal;
  recorder?: CaptureRecorder;
  mode: ConnectionMode;
  /** PDU negoziata, per il controllo dei frame (righe del block status in `online-test`). */
  pduLength: () => number;
  onRefused: () => void;
}

interface CcWaiter {
  resolve(cc: Extract<CotpPdu, { type: 'CR' | 'CC' }>): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * ISO-on-TCP (RFC 1006): TPKT e COTP sopra un `Transport` di byte. Handshake CR/CC, DT con
 * riassemblaggio dei frammenti, DR alla chiusura. Ogni frame esce da `guardedSender`; il
 * `Transport` non è mai conservato sull'istanza.
 */
export class IsoTcpLink implements PduLink {
  /** Massima PDU S7 in un DT, dal TPDU-size del CC (Infinity se la CPU non lo dice). */
  tpduCap = Infinity;

  #closed = false;
  #established = false;
  #peerRef = 0;
  #ccWaiter: CcWaiter | undefined;
  readonly #reader = new FrameReader();
  #fragments: Uint8Array[] = [];
  #fragmentBytes = 0;
  readonly #sendFrame: (frame: Uint8Array) => void;
  readonly #closeTransport: () => void;
  readonly #rec: CaptureRecorder | undefined;
  #pduCb: ((s7: Uint8Array) => void) | undefined;
  #backlog: Uint8Array[] = [];
  #closeCb: ((err?: Error) => void) | undefined;
  #closedErr: Error | undefined;

  private constructor(transport: Transport, o: IsoTcpOptions) {
    this.#rec = o.recorder;
    this.#sendFrame = guardedSender(transport, o.recorder, o.onRefused, o.mode, o.pduLength);
    this.#closeTransport = () => transport.close();
    transport.onData((chunk) => this.#onData(chunk));
    transport.onClose((err) =>
      this.#fail(
        err instanceof S7Error
          ? err
          : new S7Error('CLOSED', `connessione chiusa${err ? `: ${err.message}` : ''}`),
      ),
    );
  }

  /** Trasporto, poi CR/CC. Un errore chiude il trasporto. */
  static async open(o: IsoTcpOptions): Promise<IsoTcpLink> {
    const transport = await o.transport(o.host, o.port, o.timeoutMs, o.signal);
    const link = new IsoTcpLink(transport, o);
    try {
      if (link.#closed || o.signal?.aborted) {
        // Una fabbrica che ignora il segnale e risolve dopo l'abort: ABORTED, non CLOSED.
        throw o.signal?.aborted
          ? new S7Error('ABORTED', 'operazione annullata')
          : new S7Error('CLOSED', "connessione chiusa durante l'apertura");
      }
      await link.#handshake(o.srcTsap, o.dstTsap, o.timeoutMs, o.signal);
    } catch (e) {
      link.#fail(e instanceof Error ? e : new S7Error('PROTOCOL', String(e)));
      throw e;
    }
    return link;
  }

  sendPdu(s7: Uint8Array): void {
    this.#sendFrame(encodeTpkt(encodeCotp({ type: 'DT', eot: true, data: s7 })));
  }

  onPdu(cb: (s7: Uint8Array) => void): void {
    this.#pduCb = cb;
    const pending = this.#backlog;
    this.#backlog = [];
    for (const p of pending) cb(p);
  }

  onClose(cb: (err?: Error) => void): void {
    this.#closeCb = cb;
    if (this.#closedErr) cb(this.#closedErr);
  }

  /** Chiusura ordinata: DR alla CPU, poi il trasporto. */
  close(): Promise<void> {
    if (!this.#closed && this.#established) {
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
    this.abort();
    return Promise.resolve();
  }

  /** Chiusura dopo un errore: il trasporto si chiude senza DR (come prima della separazione). */
  abort(): void {
    this.#shutdown(new S7Error('CLOSED', 'connessione chiusa'));
  }

  async #handshake(
    srcTsap: number,
    dstTsap: number,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const cc = new Promise<Extract<CotpPdu, { type: 'CR' | 'CC' }>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new S7Error('CONNECT_TIMEOUT', `nessun CC dalla CPU entro ${timeoutMs} ms`)),
        timeoutMs,
      );
      this.#ccWaiter = { resolve, reject, timer };
    });
    cc.catch(() => undefined); // l'errore arriva da `await cc` o dal catch sotto
    const onAbort = (): void => this.#fail(new S7Error('ABORTED', 'operazione annullata'));
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
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
        this.tpduCap = 2 ** confirm.tpduSize - 3;
        if (this.tpduCap < 20) {
          throw new S7Error(
            'COTP_REJECTED',
            `TPDU-size ${h(confirm.tpduSize)} della CPU troppo piccola per S7`,
          );
        }
      }
      this.#established = true;
    } finally {
      signal?.removeEventListener('abort', onAbort);
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
        if (this.#pduCb) this.#pduCb(whole);
        else this.#backlog.push(whole);
        return;
      }
    }
  }

  // ---- chiusura ----------------------------------------------------------------------------

  /** Errore del link: chiude e lo segnala a chi ascolta (subito o alla registrazione). */
  #fail(err: Error): void {
    if (this.#closed) return;
    this.#shutdown(err);
    this.#closedErr = err;
    this.#closeCb?.(err);
  }

  #shutdown(err: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    const w = this.#ccWaiter;
    this.#ccWaiter = undefined;
    if (w) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    try {
      this.#closeTransport();
    } catch {
      // già chiuso
    }
  }
}
