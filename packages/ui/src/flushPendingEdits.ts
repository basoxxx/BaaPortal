/** Toglie il focus al campo di testo attivo: i campi a conferma committano la bozza sul blur. */
export function flushPendingEdits(): void {
  const el = document.activeElement as HTMLElement | null;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
    el.blur();
  }
}
