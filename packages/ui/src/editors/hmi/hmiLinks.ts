// Da dove legge e dove scrive il runtime HMI: il PLC collegato (giro di letture condiviso con le
// tabelle di controllo, scritture dal processo principale) o il simulatore.
import type { StoreApi } from 'zustand/vanilla';
import type { WatchTarget } from '@baaportal/project';
import type { BaaBridge } from '../../bridge';
import { watchHubFor } from '../../online/watchHub';
import type { WatchValue } from '../../sim/protocol';
import { simControllerFor } from '../../sim/simController';
import type { AppState } from '../../state/store';

export interface HmiLinkState {
  running: boolean;
  /** Ultimi valori per chiave (vedi `targetKey`); `null` finché non ne arriva uno. */
  values: Record<string, WatchValue> | null;
}

export interface HmiLink {
  subscribe(fn: () => void): () => void;
  getState(): HmiLinkState;
  /** Le voci da leggere: una chiave per voce. */
  setPlan(keys: string[], targets: WatchTarget[]): void;
  start(): void;
  stop(): void;
  /** Scrive un valore; `null` se scritto, altrimenti il motivo. `jog`: pressione a impulsi. */
  write(target: WatchTarget, data: Uint8Array, jog?: boolean): Promise<string | null>;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * PLC collegato: le letture passano dal giro condiviso con le tabelle di controllo (un solo giro
 * per CPU, al più 200 voci in tutto); le scritture da `plcHmiWrite` con il token della conferma
 * del runtime in scrittura (senza, il processo principale le rifiuta).
 */
export function plcHmiLink(
  store: StoreApi<AppState>,
  bridge: BaaBridge,
  token: string | undefined,
): HmiLink {
  const c = watchHubFor(store, bridge).client();
  return {
    subscribe: c.subscribe,
    getState: c.getState,
    setPlan: c.setPlan,
    start: c.start,
    stop: c.stop,
    write: async (target, data, jog) => {
      if (token === undefined) return 'Runtime in sola lettura';
      let r: Awaited<ReturnType<BaaBridge['plcHmiWrite']>>;
      try {
        r = await bridge.plcHmiWrite(token, [{ target, data }], jog);
      } catch (e) {
        return errorText(e);
      }
      if (!r.ok) return 'cancelled' in r ? 'Annullato' : r.error;
      const x = r.results[0];
      return x?.ok ? null : x ? x.error : 'Esito mancante';
    },
  };
}

/** Ritmo delle letture sul simulatore (ms, dalla fine della precedente). */
export const SIM_HMI_PERIOD_MS = 200;

/** Simulatore: letture una tantum a ritmo fisso, una alla volta; si ferma se la simulazione finisce. */
export function simHmiLink(store: StoreApi<AppState>, deviceId: string): HmiLink {
  const ctl = simControllerFor(store);
  const listeners = new Set<() => void>();
  let state: HmiLinkState = { running: false, values: null };
  let keys: string[] = [];
  let targets: WatchTarget[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let session = 0;
  const set = (patch: Partial<HmiLinkState>) => {
    state = { ...state, ...patch };
    for (const fn of [...listeners]) fn();
  };
  const stop = () => {
    if (!state.running) return;
    session++;
    clearTimeout(timer);
    set({ running: false, values: null });
  };
  const tick = async (s: number) => {
    const k = keys;
    let values: WatchValue[] | null = [];
    if (targets.length > 0) {
      try {
        values = await ctl.readItems(deviceId, targets);
      } catch (e) {
        values = targets.map(() => ({ error: errorText(e) }));
      }
    }
    if (s !== session) return;
    if (values === null) return stop(); // simulazione spenta o di un altro PLC
    // Valori di un piano cambiato nel frattempo: si scartano.
    if (k === keys) set({ values: Object.fromEntries(k.map((x, i) => [x, values[i]!])) });
    timer = setTimeout(() => void tick(s), SIM_HMI_PERIOD_MS);
  };
  return {
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getState: () => state,
    setPlan: (k, t) => {
      keys = k;
      targets = t;
    },
    start: () => {
      if (state.running) return;
      set({ running: true, values: null });
      void tick(++session);
    },
    stop,
    write: async (target, data) => {
      try {
        const r = await ctl.writeItems(deviceId, [{ ...target, data }]);
        if (!r) return 'Simulazione non attiva';
        const x = r[0];
        return x && 'ok' in x ? null : x ? x.error : 'Esito mancante';
      } catch (e) {
        return errorText(e);
      }
    },
  };
}
