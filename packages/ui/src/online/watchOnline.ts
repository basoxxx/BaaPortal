import type { StoreApi } from 'zustand/vanilla';
import type { BaaBridge } from '../bridge';
import type { WatchRowError } from '../editors/watch/watchRows';
import type { AppState } from '../state/store';
import type { Timers } from './diagController';
import type { PlcWatchTarget, PlcWatchValue } from './plcTypes';

export interface WatchOnlineState {
  /** L'osservazione sul PLC è attiva (si ferma da sola se il collegamento si perde). */
  running: boolean;
  /** Ultimi valori per riga; `null` finché non ne è arrivato uno e dopo ogni fermata. */
  values: Record<string, PlcWatchValue> | null;
}

export type WatchCommandOutcome =
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; errors: Record<string, WatchRowError>; written: number };

const REAL_TIMERS: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/** Ritmo: dalla fine della richiesta precedente (ms). */
export const WATCH_PERIOD_MS = 500;

const keyOf = (t: PlcWatchTarget): string => JSON.stringify(t);
const host = (message: string): WatchRowError => ({ key: 'HOST', params: { message } });

/**
 * Osservazione e comando di una tabella di controllo sul PLC collegato. Una richiesta alla volta,
 * la successiva 500 ms dopo la fine della precedente; in pausa a finestra nascosta; si ferma da
 * sola se il collegamento si perde e non riparte. Un giro che fallisce intero dà l'errore a tutte
 * le righe e l'osservazione continua. Il comando non si ripete mai.
 */
export class WatchOnlineController {
  private state: WatchOnlineState = { running: false, values: null };
  private listeners = new Set<() => void>();
  private rowIds: string[] = [];
  private items: PlcWatchTarget[] = [];
  /** L'operando con cui è stato letto l'ultimo valore di ogni riga. */
  private valueKeys = new Map<string, string>();
  private timer: unknown;
  private inFlight = false;
  private session = 0;
  private commanding = false;
  private unsub: (() => void) | undefined;
  private onVisibility = (): void => {
    if (!this.state.running || document.hidden) return;
    if (this.timer === undefined && !this.inFlight) void this.tick(this.session);
  };

  constructor(
    private readonly store: StoreApi<AppState>,
    private readonly bridge: BaaBridge,
    private readonly timers: Timers = REAL_TIMERS,
  ) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getState = (): WatchOnlineState => this.state;

  private set(patch: Partial<WatchOnlineState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of [...this.listeners]) fn();
  }

  /** Le righe da leggere (nell'ordine) e i loro operandi; i valori di una riga cambiata si tolgono. */
  setPlan(rowIds: string[], items: PlcWatchTarget[]): void {
    const same =
      rowIds.length === this.rowIds.length &&
      rowIds.every((id, i) => id === this.rowIds[i] && keyOf(items[i]!) === keyOf(this.items[i]!));
    this.rowIds = rowIds;
    this.items = items;
    if (same) return;
    const old = this.state.values;
    if (!old) return;
    const now = new Map(rowIds.map((id, i) => [id, keyOf(items[i]!)]));
    const kept = Object.fromEntries(
      Object.entries(old).filter(([id]) => now.get(id) === this.valueKeys.get(id)),
    );
    if (Object.keys(kept).length !== Object.keys(old).length) {
      this.set({ values: Object.keys(kept).length > 0 ? kept : null });
    }
  }

  start(): void {
    if (this.state.running) return;
    if (this.store.getState().online.status !== 'on') return;
    this.session++;
    this.state = { running: true, values: null };
    for (const fn of [...this.listeners]) fn();
    this.unsub = this.store.subscribe((s) => {
      if (s.online.status !== 'on') this.stop();
    });
    document.addEventListener('visibilitychange', this.onVisibility);
    if (!this.inFlight) void this.tick(this.session);
  }

  stop(): void {
    if (!this.state.running) return;
    this.session++;
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
    this.unsub?.();
    this.unsub = undefined;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.set({ running: false, values: null });
  }

  private async tick(session: number): Promise<void> {
    if (session !== this.session || this.inFlight) return;
    this.timer = undefined;
    if (this.store.getState().online.status !== 'on') {
      this.stop();
      return;
    }
    if (document.hidden) return; // finestra nascosta: in pausa fino a `visibilitychange`
    const rowIds = this.rowIds;
    const items = this.items;
    if (rowIds.length === 0) {
      this.schedule(session);
      return;
    }
    this.inFlight = true;
    let result: Awaited<ReturnType<BaaBridge['plcReadWatch']>>;
    try {
      result = await this.bridge.plcReadWatch(items);
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    this.inFlight = false;
    if (session !== this.session) return;
    if (this.store.getState().online.status !== 'on') {
      this.stop(); // collegamento perso durante il giro
      return;
    }
    // Le righe cambiate durante il giro non prendono il valore di un operando vecchio.
    const now = new Map(this.rowIds.map((id, i) => [id, keyOf(this.items[i]!)]));
    const values: Record<string, PlcWatchValue> = {};
    this.valueKeys = new Map();
    rowIds.forEach((id, i) => {
      const key = keyOf(items[i]!);
      if (now.get(id) !== key) return;
      this.valueKeys.set(id, key);
      values[id] = result.ok
        ? (result.values[i] ?? { error: 'Valore mancante' })
        : { error: result.error };
    });
    this.set({ values: Object.keys(values).length > 0 ? values : null });
    this.schedule(session);
  }

  private schedule(session: number): void {
    if (document.hidden) return;
    this.timer = this.timers.set(() => void this.tick(session), WATCH_PERIOD_MS);
  }

  /**
   * «Comanda» sul PLC: la conferma è nel processo principale; una volta sola, senza ripetizioni.
   * L'esito di ogni riga va nella colonna «Valore di comando».
   */
  async command(
    writes: { rowId: string; target: PlcWatchTarget; data: Uint8Array }[],
  ): Promise<WatchCommandOutcome> {
    if (this.commanding) return { kind: 'error', message: 'Comando già in corso' };
    this.commanding = true;
    try {
      let r: Awaited<ReturnType<BaaBridge['plcWriteVars']>>;
      try {
        r = await this.bridge.plcWriteVars(writes.map((w) => ({ target: w.target, data: w.data })));
      } catch (e) {
        return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
      }
      if (!r.ok)
        return 'cancelled' in r ? { kind: 'cancelled' } : { kind: 'error', message: r.error };
      const errors: Record<string, WatchRowError> = {};
      let written = 0;
      writes.forEach((w, i) => {
        const x = r.results[i];
        if (x && x.ok) written++;
        else errors[w.rowId] = host(x ? x.error : 'Esito mancante');
      });
      return { kind: 'done', errors, written };
    } finally {
      this.commanding = false;
    }
  }
}
