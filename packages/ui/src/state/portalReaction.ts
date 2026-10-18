import type { StoreApi } from 'zustand/vanilla';
import type { AppState } from './store';

/**
 * Reazioni del portale al ciclo di vita del documento (un solo punto per tutti i percorsi):
 * - documento caricato (apri/crea) nella vista portale: Avvio > Primi passi;
 *   nella vista progetto non cambia nulla; il salvataggio con nome non conta;
 * - documento chiuso: vista portale, Avvio > Apri progetto esistente.
 */
export function attachPortalReaction(store: StoreApi<AppState>): () => void {
  return store.subscribe((s, prev) => {
    if (s.docLoadId === prev.docLoadId) return;
    if (s.doc) {
      if (s.view !== 'portal') return;
      s.setPortal('start');
      s.setStartAction('firstSteps');
    } else if (prev.doc) {
      s.setView('portal');
      s.setPortal('start');
      s.setStartAction('open');
    }
  });
}
