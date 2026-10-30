import type { StoreApi } from 'zustand/vanilla';
import type { BaaBridge } from '../bridge';
import { ONLINE_MAX_ITEMS } from '../editors/watch/watchRows';
import { t } from '../i18n';
import type { AppState } from '../state/store';
import type { Timers } from './diagController';
import type { PlcWatchTarget, PlcWatchValue } from './plcTypes';
import {
  WatchOnlineController,
  type WatchCommandOutcome,
  type WatchOnlineState,
} from './watchOnline';

const keyOf = (t: PlcWatchTarget): string => JSON.stringify(t);

/** Lo stesso insieme di metodi che la tabella usa per osservare e comandare sul PLC. */
export interface WatchOnlineClient {
  subscribe(fn: () => void): () => void;
  getState(): WatchOnlineState;
  setPlan(rowIds: string[], items: PlcWatchTarget[]): void;
  start(): void;
  stop(): void;
  command(
    writes: { rowId: string; target: PlcWatchTarget; data: Uint8Array }[],
  ): Promise<WatchCommandOutcome>;
}

interface ClientData {
  rowIds: string[];
  keys: string[];
  targets: PlcWatchTarget[];
  state: WatchOnlineState;
  listeners: Set<() => void>;
  /** Righe lasciate fuori perché il limite della richiesta è già occupato dalle altre tabelle. */
  over: Set<string>;
}

/**
 * Un solo giro di letture per CPU per tutte le tabelle che osservano: le richieste si uniscono, gli
 * operandi uguali si leggono una volta, e il limite di 200 righe vale per l'insieme (le righe in
 * più, nell'ordine in cui le tabelle hanno acceso «Osserva tutto», danno un errore di riga).
 */
export class WatchOnlineHub {
  private engine: WatchOnlineController;
  /** Tabelle che osservano, in ordine di accensione. */
  private running = new Set<ClientData>();
  private warned = false;

  constructor(
    private readonly store: StoreApi<AppState>,
    bridge: BaaBridge,
    timers?: Timers,
  ) {
    this.engine = new WatchOnlineController(store, bridge, timers);
    this.engine.subscribe(() => this.onEngine());
  }

  client(): WatchOnlineClient {
    const d: ClientData = {
      rowIds: [],
      keys: [],
      targets: [],
      state: { running: false, values: null },
      listeners: new Set(),
      over: new Set(),
    };
    return {
      subscribe: (fn) => {
        d.listeners.add(fn);
        return () => d.listeners.delete(fn);
      },
      getState: () => d.state,
      setPlan: (rowIds, items) => {
        d.rowIds = rowIds;
        d.targets = items;
        d.keys = items.map(keyOf);
        if (this.running.has(d)) this.sync();
      },
      start: () => {
        if (d.state.running || this.store.getState().online.status !== 'on') return;
        this.running.add(d);
        this.set(d, { running: true, values: null });
        this.sync();
      },
      stop: () => {
        if (!this.running.delete(d)) return;
        d.over.clear();
        this.set(d, { running: false, values: null });
        this.sync();
      },
      command: (writes) => this.engine.command(writes),
    };
  }

  private set(d: ClientData, patch: Partial<WatchOnlineState>): void {
    d.state = { ...d.state, ...patch };
    for (const fn of [...d.listeners]) fn();
  }

  /** Piano unico delle tabelle che osservano; avvia o ferma il giro. */
  private sync(): void {
    const unique = new Map<string, PlcWatchTarget>();
    let overflowing = false;
    for (const d of this.running) {
      d.over = new Set();
      d.keys.forEach((k, i) => {
        if (unique.has(k)) return;
        if (unique.size < ONLINE_MAX_ITEMS) unique.set(k, d.targets[i]!);
        else d.over.add(d.rowIds[i]!);
      });
      overflowing ||= d.over.size > 0;
    }
    if (overflowing && !this.warned) {
      this.store.getState().pushMessage({
        severity: 'warning',
        textKey: 'messages.watchSharedLimit',
        params: { max: String(ONLINE_MAX_ITEMS) },
      });
    }
    this.warned = overflowing;
    this.engine.setPlan([...unique.keys()], [...unique.values()]);
    if (this.running.size === 0) this.engine.stop();
    else {
      this.engine.start();
      if (!this.engine.getState().running) this.lost();
    }
    this.publish();
  }

  private lost(): void {
    for (const d of [...this.running]) {
      this.running.delete(d);
      d.over.clear();
      this.set(d, { running: false, values: null });
    }
  }

  private onEngine(): void {
    if (!this.engine.getState().running && this.running.size > 0) this.lost();
    else this.publish();
  }

  /** Ai valori letti si aggiungono gli errori delle righe fuori limite. */
  private publish(): void {
    const { values: read, paused = false } = this.engine.getState();
    for (const d of this.running) {
      if ((d.state.paused ?? false) !== paused) this.set(d, { paused: paused || undefined });
      const values: Record<string, PlcWatchValue> = {};
      d.rowIds.forEach((id, i) => {
        const v = d.over.has(id)
          ? { error: t('watch.sharedLimit', { max: ONLINE_MAX_ITEMS }) }
          : read?.[d.keys[i]!];
        if (v) values[id] = v;
      });
      const next = Object.keys(values).length > 0 ? values : null;
      if (next || d.state.values) this.set(d, { values: next });
    }
  }
}

const hubs = new WeakMap<StoreApi<AppState>, WatchOnlineHub>();
/** Il gestore condiviso del collegamento di questo store. */
export function watchHubFor(store: StoreApi<AppState>, bridge: BaaBridge): WatchOnlineHub {
  let h = hubs.get(store);
  if (!h) hubs.set(store, (h = new WatchOnlineHub(store, bridge)));
  return h;
}
