// Apertura dei riferimenti incrociati e della struttura di richiamo, col filtro iniziale (dal menu,
// dall'albero o dall'operando sotto il cursore con Maiusc+F11).
import type { StoreApi } from 'zustand/vanilla';
import { EditorView } from '@codemirror/view';
import { mapOperands } from '@baaportal/ladfbd';
import { findDevice, xrefOperandAt, type Project, type XrefUse } from '@baaportal/project';
import { currentMnemonic } from '../awl/mnemonicPreference';
import type { AppState } from '../../state/store';

type Store = StoreApi<AppState>;

/** Ultima richiesta di filtro; `n` la rende ripetibile (lo stesso testo una seconda volta). */
export interface XrefRequest {
  deviceId: string;
  filter: string;
  n: number;
}
let request: XrefRequest = { deviceId: '', filter: '', n: 0 };
const listeners = new Set<() => void>();

export const xrefRequest = (): XrefRequest => request;
export function subscribeXrefRequest(l: () => void): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}

/** Apre i riferimenti incrociati del dispositivo filtrati su `filter` (vuoto: tutto il programma). */
export function openCrossRef(store: Store, deviceId: string, filter = ''): void {
  request = { deviceId, filter, n: request.n + 1 };
  listeners.forEach((l) => l());
  store.getState().openEditor({ kind: 'crossRef', deviceId, objectId: '' });
}

/** Il filtro per un nodo dell'albero: il blocco come `FC1` (`DB2` per un DB di istanza), il PLC: nessuno. */
export function blockFilter(
  doc: { project: Project } | null,
  node: { kind: string; dev: string; id?: string },
): string {
  if (node.kind !== 'block' || !doc) return '';
  const b = findDevice(doc.project, node.dev)?.blocks.find((x) => x.id === node.id);
  return b ? `${b.kind === 'IDB' ? 'DB' : b.kind}${b.number}` : '';
}

export function openCallStructure(store: Store, deviceId: string): void {
  store.getState().openEditor({ kind: 'callStructure', deviceId, objectId: '' });
}

/** Porta l'editor del blocco sul punto d'uso: riga AWL o SCL, o elemento KOP/FUP. */
export function openUse(store: Store, deviceId: string, use: XrefUse): void {
  store.getState().openBlockAt({
    deviceId,
    blockId: use.blockId,
    network: use.network,
    line: use.line,
    ...(use.elemId ? { elemId: use.elemId } : {}),
  });
}

// L'ultimo editor di testo (AWL o SCL) che ha avuto il focus: la scorciatoia lo toglie prima del comando.
let lastCode: Element | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener('focusin', (e) => {
    const cm = (e.target as Element | null)?.closest?.('.cm-editor');
    if (cm) lastCode = cm;
  });
}

const WORD = /[\w."#%[\]]/;

/**
 * L'operando sotto il cursore nell'ultimo editor di codice del blocco `blockId` (solo se sta ancora
 * nella pagina): con il parser AWL, o la parola intorno al cursore in SCL. Altrimenti il testo
 * selezionato, o ''.
 */
export function operandUnderCursor(
  s: AppState,
  target: { deviceId: string; blockId: string },
): string {
  const view = lastCode?.isConnected ? EditorView.findFromDOM(lastCode as HTMLElement) : null;
  const dev = s.doc ? findDevice(s.doc.project, target.deviceId) : undefined;
  const block = dev?.blocks.find((b) => b.id === target.blockId);
  const frame = `editor-frame-block:${target.deviceId}:${target.blockId}`;
  const frameOf = (el: Element | null | undefined) =>
    el?.closest('[data-testid^="editor-frame-"]')?.getAttribute('data-testid');
  // KOP/FUP: il primo operando dell'elemento del grafico che ha il focus.
  const elem = document.activeElement?.closest('[data-lad-id],[data-fup-id]');
  const elemId = elem?.getAttribute('data-lad-id') ?? elem?.getAttribute('data-fup-id');
  if (
    dev &&
    block &&
    block.kind !== 'DB' &&
    block.kind !== 'IDB' &&
    elemId &&
    frameOf(elem) === frame
  ) {
    let first = '';
    for (const n of block.networks) {
      if (!n.lad) continue;
      mapOperands(n.lad, (value, _role, at) => {
        if (!first && at.id === elemId && value.trim()) first = value.trim();
        return value;
      });
    }
    if (first) return xrefOperandAt(dev, block.id, `L ${first}`, 2, 'international') ?? first;
  }
  if (view && dev && block && frameOf(lastCode) === frame) {
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    const col = head - line.from;
    if (block.kind !== 'DB' && block.kind !== 'IDB' && block.language !== 'SCL') {
      const m = currentMnemonic() === 'de' ? 'german' : 'international';
      const found = xrefOperandAt(dev, block.id, line.text, col, m);
      if (found) return found;
    }
    // shortcut: in SCL la parola intorno al cursore, senza il parser SCL; basta per simboli e indirizzi.
    let from = col;
    let to = col;
    while (from > 0 && WORD.test(line.text[from - 1]!)) from--;
    while (to < line.text.length && WORD.test(line.text[to]!)) to++;
    const word = line.text.slice(from, to).trim();
    if (word) return word;
  }
  const sel = window.getSelection()?.toString() ?? '';
  return /[\r\n]/.test(sel) ? '' : sel.trim();
}
