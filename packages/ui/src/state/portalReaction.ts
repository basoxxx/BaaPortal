import type { StoreApi } from 'zustand/vanilla';
import type { AppState } from './store';

/**
 * Dopo un'apertura o una creazione riuscita nella vista portale si resta nel portale,
 * su Avvio > Primi passi. Nella vista progetto non cambia nulla.
 * Reagisce al cambio di `doc.filePath` verso un nuovo valore non nullo.
 */
export function attachPortalReaction(store: StoreApi<AppState>): () => void {
  return store.subscribe((s, prev) => {
    const path = s.doc?.filePath ?? null;
    if (path === null || path === (prev.doc?.filePath ?? null)) return;
    if (s.view !== 'portal') return;
    s.setPortal('start');
    s.setStartAction('firstSteps');
  });
}
