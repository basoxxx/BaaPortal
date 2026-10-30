import type { FoundDevice, NetInterface, PlcScanEvent, PlcScanStartResult } from '@baaportal/ui';
import { hostsToScan, listInterfaces } from './interfaces';
import { createIdentify, createProbe, scanSubnet, type IdentifyFn, type ProbeFn } from './scan';

/** La pagina finisce: finestra distrutta, pagina ricaricata (un nuovo renderer) o renderer caduto. */
const GONE = ['destroyed', 'did-navigate', 'render-process-gone'] as const;
type GoneEvent = (typeof GONE)[number];

/** Quanto serve di una finestra: abbastanza per i test senza Electron. */
export interface ScanOwner {
  isDestroyed(): boolean;
  send(channel: string, event: PlcScanEvent): void;
  once(event: GoneEvent, cb: () => void): unknown;
  removeListener(event: GoneEvent, cb: () => void): unknown;
}

type ScanBody = PlcScanEvent extends infer E
  ? E extends unknown
    ? Omit<E, 'scanId'>
    : never
  : never;

export interface ScanServiceOptions {
  probe?: ProbeFn;
  identify?: IdentifyFn;
  interfaces?: () => NetInterface[];
  /** Intervallo minimo tra due eventi di avanzamento (ms): al più 10 al secondo, come kit.ts. */
  progressIntervalMs?: number;
  maxHosts?: number;
}

interface Run {
  ctl: AbortController;
  id: number;
  onGone: () => void;
  finished: Promise<void>;
}

/**
 * Una ricerca di dispositivi accessibili per finestra. Una nuova ricerca interrompe la
 * precedente, la finestra distrutta o ricaricata, il renderer caduto o l'uscita dall'app
 * (`cancelAll`) la interrompono; nessun evento va a una finestra distrutta o a una pagina nuova.
 */
export class ScanService {
  private readonly runs = new Map<ScanOwner, Run>();
  private nextId = 1;
  private readonly probe: ProbeFn;
  private readonly identify: IdentifyFn;
  private readonly interfaces: () => NetInterface[];
  private readonly progressIntervalMs: number;
  private readonly maxHosts: number;

  constructor(o: ScanServiceOptions = {}) {
    this.probe = o.probe ?? createProbe();
    this.identify = o.identify ?? createIdentify();
    this.interfaces = o.interfaces ?? (() => listInterfaces());
    this.progressIntervalMs = o.progressIntervalMs ?? 100;
    this.maxHosts = o.maxHosts ?? 1024;
  }

  listInterfaces(): NetInterface[] {
    return this.interfaces();
  }

  /** Avvia la ricerca sull'interfaccia con questo indirizzo; `finished` della esecuzione non è atteso. */
  start(owner: ScanOwner, address: string): PlcScanStartResult {
    this.cancel(owner); // una sola ricerca per finestra
    if (owner.isDestroyed()) return { ok: false, error: 'Finestra chiusa' };
    const iface = this.interfaces().find((i) => i.address === address);
    if (!iface) return { ok: false, error: 'Interfaccia di rete non disponibile' };
    const hosts = hostsToScan(iface.address, iface.netmask, this.maxHosts);
    const scanId = this.nextId++;
    const ctl = new AbortController();
    // Dopo la fine della pagina nessun evento: andrebbe al renderer nuovo, che non l'ha chiesta.
    let gone = false;
    const emit = (event: ScanBody): void => {
      if (!gone && !owner.isDestroyed()) owner.send('plc:scanEvent', { scanId, ...event });
    };
    const onGone = (): void => {
      gone = true;
      ctl.abort();
    };
    for (const e of GONE) owner.once(e, onGone);

    let found = 0;
    let lastProgress = 0;
    let pending: { done: number; total: number } | null = null;
    const finished = (async () => {
      try {
        await scanSubnet(hosts, {
          probe: this.probe,
          identify: this.identify,
          signal: ctl.signal,
          onFound: (device: FoundDevice) => {
            found++;
            emit({ kind: 'found', device });
          },
          onProgress: (done, total) => {
            const now = Date.now();
            if (done < total && now - lastProgress < this.progressIntervalMs) {
              pending = { done, total };
              return;
            }
            lastProgress = now;
            pending = null;
            emit({ kind: 'progress', done, total });
          },
        });
        if (!ctl.signal.aborted && pending) {
          const p: { done: number; total: number } = pending;
          emit({ kind: 'progress', done: p.done, total: p.total });
        }
        emit({ kind: 'done', found, cancelled: ctl.signal.aborted });
      } catch (err) {
        emit({ kind: 'error', error: err instanceof Error ? err.message : String(err) });
      } finally {
        for (const e of GONE) owner.removeListener(e, onGone);
        if (this.runs.get(owner)?.id === scanId) this.runs.delete(owner);
      }
    })();
    this.runs.set(owner, { ctl, id: scanId, onGone, finished });
    return { ok: true, scanId, total: hosts.length };
  }

  /** Interrompe la ricerca della finestra (se c'è); l'evento `done` con `cancelled` la chiude. */
  cancel(owner: ScanOwner): void {
    const run = this.runs.get(owner);
    if (!run) return;
    this.runs.delete(owner);
    run.ctl.abort();
  }

  /** Uscita dall'app: interrompe tutte le ricerche e aspetta che abbiano finito. */
  async cancelAll(): Promise<void> {
    const runs = [...this.runs.values()];
    this.runs.clear();
    for (const r of runs) r.ctl.abort();
    await Promise.all(runs.map((r) => r.finished));
  }
}
