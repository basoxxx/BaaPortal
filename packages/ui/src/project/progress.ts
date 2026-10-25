import { useSyncExternalStore } from 'react';

/** Operazione lunga in corso, mostrata nella barra di stato (§8.2 punto 12). */
export interface Progress {
  labelKey: string;
  done: number;
  total: number;
  cancel?: () => void;
}

let current: Progress | null = null;
const listeners = new Set<() => void>();

function set(p: Progress | null): void {
  current = p;
  for (const l of [...listeners]) l();
}

export const getProgress = (): Progress | null => current;

export function useProgress(): Progress | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

/** Errore con cui il lavoro dice a `runWithProgress` di essersi fermato su richiesta (tra due passi). */
export class Interrupted extends Error {
  constructor() {
    super('interrotto');
    this.name = 'AbortError';
  }
}

/**
 * Esegue un lavoro in `total` passi mostrando l'avanzamento nella barra di stato. `step` avanza di
 * uno; `signal` scatta con Interrompi e il lavoro lo controlla solo tra un passo e l'altro, poi
 * lancia `Interrupted`: l'esito è allora 'interrotto'. Una sola operazione alla volta.
 */
export async function runWithProgress<T>(
  labelKey: string,
  total: number,
  work: (step: () => void, signal: AbortSignal) => Promise<T>,
): Promise<T | 'interrotto'> {
  const ctrl = new AbortController();
  set({ labelKey, done: 0, total, cancel: () => ctrl.abort() });
  const step = () => {
    if (current) set({ ...current, done: Math.min(current.done + 1, current.total) });
  };
  try {
    return await work(step, ctrl.signal);
  } catch (e) {
    if (e instanceof Interrupted) return 'interrotto';
    throw e;
  } finally {
    set(null);
  }
}

/**
 * Avanzamento guidato da fuori (un'operazione del processo principale): `update` ne dà lo stato,
 * `end` lo toglie. `cancel` è il pulsante Interrompi. Una sola operazione alla volta.
 */
export function beginProgress(
  labelKey: string,
  cancel: () => void,
): { update(done: number, total: number): void; end(): void } {
  set({ labelKey, done: 0, total: 0, cancel });
  return {
    update: (done, total) => {
      if (current?.labelKey === labelKey) set({ ...current, done, total });
    },
    end: () => {
      if (current?.labelKey === labelKey) set(null);
    },
  };
}
