import { useEffect, useRef, useState, type FocusEvent, type RefObject } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import type { AppState, EditAction } from './store';

const MENUS_SELECTOR = '[role="menu"],[role="menubar"]';

/**
 * Registra l'elemento come destinazione dei comandi di Modifica finché ha il focus, o finché il
 * focus è in un menu partito da lì. `suspended` toglie temporaneamente la destinazione (ad esempio
 * durante la modifica di una cella, quando i tasti spettano al campo di testo).
 */
export function useEditTarget(
  store: StoreApi<AppState>,
  id: string,
  containerRef: RefObject<HTMLElement | null>,
  can: Partial<Record<EditAction, boolean>>,
  run: (action: EditAction) => void | Promise<void>,
  suspended = false,
) {
  const [hasFocus, setHasFocus] = useState(false);
  // Il bersaglio dei comandi chiama sempre la versione più recente di `run`.
  const runRef = useRef(run);
  runRef.current = run;
  const canKey = JSON.stringify(can);
  const active = hasFocus && !suspended;

  useEffect(() => {
    const s = store.getState();
    if (active) s.setEditTarget({ id, can, run: (a) => runRef.current(a) });
    else if (s.editTarget?.id === id) s.setEditTarget(null);
    // `can` cambia solo se cambia canKey.
  }, [active, canKey, store, id]);
  useEffect(
    () => () => {
      if (store.getState().editTarget?.id === id) store.getState().setEditTarget(null);
    },
    [store, id],
  );
  // Il focus che passa a un altro elemento (non ai menu) toglie la destinazione.
  useEffect(() => {
    if (!hasFocus) return;
    const onFocusIn = (e: FocusEvent | globalThis.FocusEvent) => {
      const el = e.target as Element | null;
      if (el && !containerRef.current?.contains(el) && !el.closest(MENUS_SELECTOR))
        setHasFocus(false);
    };
    // Il documento dell'elemento: in una finestra separata non è quello principale.
    const doc = containerRef.current?.ownerDocument ?? document;
    doc.addEventListener('focusin', onFocusIn);
    return () => doc.removeEventListener('focusin', onFocusIn);
  }, [hasFocus, containerRef]);

  return {
    onFocus: () => setHasFocus(true),
    onBlur: (e: FocusEvent) => {
      const next = e.relatedTarget as Element | null;
      if (next && (containerRef.current?.contains(next) || next.closest(MENUS_SELECTOR))) return;
      setHasFocus(false);
    },
  };
}
