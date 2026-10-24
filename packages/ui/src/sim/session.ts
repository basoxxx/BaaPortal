import type { SimCpuProps } from '@baaportal/sim';
import type { SimNotice, SimRequest, SimWireMessage, SimWireRequest } from './protocol';

/** La parte di `Worker` che serve alla sessione (i test la sostituiscono con un finto worker). */
export interface SimWorkerLike {
  postMessage(message: SimWireRequest): void;
  terminate(): void;
  onmessage: ((e: { data: SimWireMessage }) => void) | null;
  onerror: ((e: { message?: string }) => void) | null;
  onmessageerror: ((e: unknown) => void) | null;
}

export interface SimSessionOptions {
  cpuTypeId: string;
  props: SimCpuProps;
  /** Fabbrica del worker; predefinita: il worker vero (modulo dello stesso origine, senza `blob:`). */
  createWorker?: () => SimWorkerLike;
}

function defaultWorker(): SimWorkerLike {
  // Produzione: la build emette uno script IIFE, che va caricato come worker classico (un modulo da
  // file:// è bloccato). Sviluppo: il server di Vite serve moduli, quindi serve `module`.
  const dev = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;
  if (dev)
    return new Worker(new URL('./simWorker.ts', import.meta.url), {
      type: 'module',
    }) as unknown as SimWorkerLike;
  return new Worker(new URL('./simWorker.ts', import.meta.url)) as unknown as SimWorkerLike;
}

/** Lato renderer: parla con l'ospite del simulatore nel Worker per richiesta/risposta numerate. */
export class SimSession {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: never) => void; reject: (e: Error) => void }
  >();
  private readonly listeners = new Set<(n: SimNotice) => void>();
  private disposed = false;

  private constructor(private readonly worker: SimWorkerLike) {
    worker.onmessage = (e) => this.receive(e.data);
    worker.onerror = (e) => this.fail(new Error(e.message ?? 'errore del worker del simulatore'));
    worker.onmessageerror = () => this.fail(new Error('messaggio del worker illeggibile'));
  }

  /** Crea il worker e avvia la CPU simulata; se l'avvio fallisce il worker è terminato. */
  static async start(o: SimSessionOptions): Promise<SimSession> {
    const s = new SimSession((o.createWorker ?? defaultWorker)());
    try {
      await s.request({ op: 'start', cpuTypeId: o.cpuTypeId, props: o.props });
    } catch (e) {
      s.dispose();
      throw e;
    }
    return s;
  }

  request<T = void>(req: SimRequest): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('simulazione terminata'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject });
      this.worker.postMessage({ id, req });
    });
  }

  /** Registra un ascoltatore delle notifiche; restituisce la cancellazione. */
  onNotice(cb: (n: SimNotice) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Termina il worker (niente resta in esecuzione) e rifiuta le richieste pendenti. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    this.listeners.clear();
    this.failAll(new Error('simulazione terminata'));
  }

  private receive(m: SimWireMessage): void {
    if (m.type === 'notice') {
      if (m.notice.kind === 'error') {
        this.fail(new Error(m.notice.message));
        return;
      }
      for (const cb of [...this.listeners]) cb(m.notice);
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.ok) p.resolve(m.value as never);
    else p.reject(new Error(m.error));
  }

  /** Guasto del worker: la sessione è finita (worker terminato, richieste rifiutate). */
  private fail(e: Error): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    this.listeners.clear();
    this.failAll(e);
  }

  private failAll(e: Error): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) p.reject(e);
  }
}
