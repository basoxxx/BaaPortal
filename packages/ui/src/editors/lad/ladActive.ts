// Canale dalla tavolozza delle istruzioni all'editor di segmento KOP che ha il focus.
import type { LadInsertApi } from './LadNetworkEditor';

/** L'editor attivo e il blocco a cui appartiene. */
export interface ActiveLad {
  api: LadInsertApi;
  deviceId: string;
  blockId: string;
}

let current: ActiveLad | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** L'editor `api` del blocco indicato prende il focus (`true`) o sparisce (`false`). */
export function setLadActive(
  api: LadInsertApi,
  active: boolean,
  owner: { deviceId: string; blockId: string },
): void {
  if (active) current = { api, ...owner };
  else if (current?.api === api) current = null;
  else return;
  emit();
}

/** L'ultimo editor KOP che ha avuto il focus e ancora presente. */
export const activeLad = (): ActiveLad | null => current;

export function subscribeLad(l: () => void): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}
