import type { StoreApi } from 'zustand/vanilla';
import { EDITORS } from '../editors/registry';
import type { AppState } from './store';
import { keepEditors } from './workArea';

/** Dopo ogni cambiamento del documento chiude gli editor il cui oggetto non esiste più. */
export function attachEditorReconciler(store: StoreApi<AppState>): () => void {
  return store.subscribe((s, prev) => {
    if (s.doc === prev.doc || s.workArea.editors.length === 0) return;
    const doc = s.doc;
    const workArea = keepEditors(s.workArea, (e) => !!doc && EDITORS[e.kind].exists(e, doc));
    if (workArea !== s.workArea) store.setState({ workArea });
  });
}
