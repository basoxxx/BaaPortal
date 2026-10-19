// Documenti delle finestre separate: i loro campi hanno un focus proprio.
const detachedDocuments = new Set<Document>();

/** Una finestra separata registra il proprio documento; la funzione restituita lo toglie. */
export function registerEditDocument(doc: Document): () => void {
  detachedDocuments.add(doc);
  return () => {
    detachedDocuments.delete(doc);
  };
}

export function isTextField(el: Element | null): el is HTMLElement {
  return (
    !!el &&
    (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable)
  );
}

/** Toglie il focus al campo di testo attivo del documento: i campi a conferma committano la bozza sul blur. */
export function flushDocument(doc: Document): void {
  const el = doc.activeElement;
  if (isTextField(el)) el.blur();
}

/** Conferma le bozze nella finestra principale e in quelle separate. */
export function flushPendingEdits(): void {
  flushDocument(document);
  for (const doc of detachedDocuments) flushDocument(doc);
}
