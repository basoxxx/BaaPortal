// Canale dalla tavolozza delle istruzioni all'editor di segmento KOP che ha il focus.
import type { LadInsertApi } from './LadNetworkEditor';

let current: LadInsertApi | null = null;

/** L'editor `api` prende il focus (`true`) o sparisce (`false`). */
export function setLadActive(api: LadInsertApi, active: boolean): void {
  if (active) current = api;
  else if (current === api) current = null;
}

/** L'editor KOP attivo, se c'è: l'ultimo che ha avuto il focus e ancora presente. */
export const activeLad = (): LadInsertApi | null => current;
