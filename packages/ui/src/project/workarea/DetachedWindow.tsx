import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { handleShortcutKeydown } from '../../commands/useShortcuts';
import { useEditorInfo } from '../../editors/registry';
import { flushDocument, registerEditDocument } from '../../flushPendingEdits';
import { useAppStore, useServices } from '../../state/AppContext';
import type { EditorRef } from '../../state/workArea';
import { EditorFrame } from './EditorFrame';

/** Nome della finestra: la main accetta solo /^baa-editor-[A-Za-z0-9-]+$/, e le chiavi contengono ':'. */
export function windowName(key: string): string {
  let h = 0x811c9dc5; // FNV-1a a 32 bit
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  return `baa-editor-${(h >>> 0).toString(16)}`;
}

/** Porta nella finestra figlia stili e classi del tema della finestra principale. */
function copyTheme(from: Document, to: Document): void {
  for (const node of from.head.querySelectorAll('style, link[rel="stylesheet"]')) {
    const copy = to.importNode(node, true);
    if (copy instanceof HTMLLinkElement && node instanceof HTMLLinkElement) copy.href = node.href;
    to.head.appendChild(copy);
  }
  to.documentElement.className = from.documentElement.className;
  for (const attr of from.documentElement.attributes) {
    if (attr.name.startsWith('data-')) to.documentElement.setAttribute(attr.name, attr.value);
  }
}

/** Un editor staccato: la finestra figlia ospita, tramite portale, il suo albero React. */
export function DetachedWindow({ editor }: { editor: EditorRef }) {
  const ctx = useServices();
  const { store } = ctx;
  const info = useEditorInfo(editor);
  const focusRequest = useAppStore((s) => s.workArea.focusRequest);
  const [child, setChild] = useState<{ win: Window; root: HTMLElement } | null>(null);

  useEffect(() => {
    const win = window.open('', windowName(editor.key), 'width=1000,height=700');
    if (!win) {
      // Finestra negata: l'editor resta nell'area di lavoro.
      store.getState().attachEditor(editor.key);
      store.getState().pushMessage({ severity: 'warning', textKey: 'messages.detachBlocked' });
      return;
    }
    copyTheme(document, win.document);
    const root = win.document.createElement('div');
    root.className = 'baa-detached-root';
    win.document.body.appendChild(root);
    const onKeyDown = (e: KeyboardEvent) => void handleShortcutKeydown(e, ctx);
    const onGone = () => {
      // La bozza del campo in modifica si conferma prima che l'editor torni nell'area di lavoro.
      flushDocument(win.document);
      store.getState().attachEditor(editor.key);
    };
    const unregister = registerEditDocument(win.document);
    win.document.addEventListener('keydown', onKeyDown);
    win.addEventListener('pagehide', onGone);
    win.addEventListener('beforeunload', onGone);
    setChild({ win, root });
    return () => {
      unregister();
      win.document.removeEventListener('keydown', onKeyDown);
      win.removeEventListener('pagehide', onGone);
      win.removeEventListener('beforeunload', onGone);
      setChild(null);
      win.close();
    };
    // La finestra vive quanto l'editor staccato.
  }, [editor.key]);

  useEffect(() => {
    if (child && info) child.win.document.title = info.title;
  }, [child, info?.title]);

  useEffect(() => {
    if (child && focusRequest?.key === editor.key) child.win.focus();
  }, [child, focusRequest]);

  return child ? createPortal(<EditorFrame editor={editor} detached />, child.root) : null;
}

/** Le finestre separate dipendono dallo stato, non dalla vista: restano aperte passando al portale. */
export function DetachedWindows() {
  const detached = useAppStore((s) => s.workArea.detached);
  const editors = useAppStore((s) => s.workArea.editors);
  return (
    <>
      {editors
        .filter((e) => detached.includes(e.key))
        .map((e) => (
          <DetachedWindow key={e.key} editor={e} />
        ))}
    </>
  );
}
