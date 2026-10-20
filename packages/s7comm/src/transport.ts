import { S7Error } from './errors';

/**
 * Trasporto di byte, indipendente dalla piattaforma. `send` è usato solo dal punto di controllo
 * `S7Connection.sendFrame`, dopo il filtro di sola lettura. I callback si registrano una volta.
 */
export interface Transport {
  send(bytes: Uint8Array): void;
  onData(cb: (chunk: Uint8Array) => void): void;
  onClose(cb: (err?: Error) => void): void;
  close(): void;
}

export type TransportFactory = (
  host: string,
  port: number,
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<Transport>;

class MemoryEnd implements Transport {
  peer!: MemoryEnd;
  private dataCb: ((chunk: Uint8Array) => void) | undefined;
  private closeCb: ((err?: Error) => void) | undefined;
  private backlog: Uint8Array[] = [];
  private closedPending = false;
  private isClosed = false;

  send(bytes: Uint8Array): void {
    if (this.isClosed) throw new S7Error('CLOSED', 'trasporto in memoria chiuso');
    const copy = bytes.slice();
    const peer = this.peer;
    queueMicrotask(() => peer.deliver(copy));
  }

  onData(cb: (chunk: Uint8Array) => void): void {
    this.dataCb = cb;
    const pending = this.backlog;
    this.backlog = [];
    for (const c of pending) cb(c);
  }

  onClose(cb: (err?: Error) => void): void {
    this.closeCb = cb;
    if (this.closedPending) {
      this.closedPending = false;
      cb();
    }
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    const peer = this.peer;
    queueMicrotask(() => peer.remoteClosed());
  }

  private deliver(chunk: Uint8Array): void {
    if (this.isClosed) return;
    if (this.dataCb) this.dataCb(chunk);
    else this.backlog.push(chunk);
  }

  private remoteClosed(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    if (this.closeCb) this.closeCb();
    else this.closedPending = true;
  }
}

/** Due estremità collegate; la consegna è asincrona (microtask) e `close()` chiude anche l'altra. */
export function memoryTransportPair(): [Transport, Transport] {
  const a = new MemoryEnd();
  const b = new MemoryEnd();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/**
 * Fabbrica di trasporti che tiene almeno `minMs` tra l'ultima risposta e la richiesta successiva,
 * anche dentro i pezzi di una SZL o di un upload (le richieste partono sempre in ordine).
 */
export function pacedFactory(inner: TransportFactory, minMs: number): TransportFactory {
  if (minMs <= 0) return inner;
  return async (host, port, timeoutMs, signal) => {
    const t = await inner(host, port, timeoutMs, signal);
    let lastRx: number | undefined;
    let lastAt = 0;
    const wrapped: Transport = {
      send(bytes) {
        const now = Date.now();
        const at = Math.max(now, lastAt, lastRx === undefined ? 0 : lastRx + minMs);
        if (at <= now) {
          lastAt = now;
          t.send(bytes);
          return;
        }
        lastAt = at;
        const copy = bytes.slice();
        setTimeout(() => {
          try {
            t.send(copy);
          } catch {
            // la chiusura la segnala onClose o il timeout della richiesta
          }
        }, at - now);
      },
      onData(cb) {
        t.onData((c) => {
          lastRx = Date.now();
          cb(c);
        });
      },
      onClose: (cb) => t.onClose(cb),
      close: () => t.close(),
    };
    return wrapped;
  };
}
