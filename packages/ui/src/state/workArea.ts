import { ids, parseNodeId } from '../project/navigation/treeIds';

export type EditorKind =
  'tagTable' | 'allTags' | 'block' | 'udt' | 'source' | 'watchTable' | 'compare';
export interface EditorRef {
  /** `${kind}:${deviceId}:${objectId}`; "Mostra tutte le variabili" ha objectId ''. */
  key: string;
  kind: EditorKind;
  deviceId: string;
  objectId: string;
}
export type EditorTarget = Omit<EditorRef, 'key'>;
export type SplitMode = 'none' | 'vertical' | 'horizontal';

export interface WorkAreaState {
  editors: EditorRef[];
  split: SplitMode;
  /** Editor attivo in ciascun riquadro; il secondo conta solo con la divisione. */
  panes: [string | null, string | null];
  focusedPane: 0 | 1;
  /** Chiavi degli editor che vivono in una finestra separata. */
  detached: string[];
  /** Chiavi dal più al meno recentemente usato. */
  recent: string[];
  /** Richiesta di portare in primo piano la finestra separata di `key` (`n` la rende ripetibile). */
  focusRequest: { key: string; n: number } | null;
}

export const initialWorkArea = (): WorkAreaState => ({
  editors: [],
  split: 'none',
  panes: [null, null],
  focusedPane: 0,
  detached: [],
  recent: [],
  focusRequest: null,
});

export const editorKey = (kind: EditorKind, deviceId: string, objectId: string): string =>
  `${kind}:${deviceId}:${objectId}`;

export const toEditorRef = (t: EditorTarget): EditorRef => ({
  ...t,
  key: editorKey(t.kind, t.deviceId, t.objectId),
});

/** Nodo dell'albero che corrisponde all'editor. */
export function nodeIdOfEditor(e: EditorTarget): string {
  switch (e.kind) {
    case 'block':
      return ids.block(e.deviceId, e.objectId);
    case 'udt':
      return ids.udt(e.deviceId, e.objectId);
    case 'tagTable':
      return ids.tagTable(e.deviceId, e.objectId);
    case 'source':
      return ids.source(e.deviceId, e.objectId);
    case 'watchTable':
      return ids.watchTable(e.deviceId, e.objectId);
    case 'compare':
      return ids.block(e.deviceId, e.objectId);
    case 'allTags':
      return ids.folder(e.deviceId, 'tags-all');
  }
}

/** Editor che il nodo apre (blocco, UDT, tabella, "Mostra tutte le variabili"), altrimenti null. */
export function editorOfNode(nodeId: string): EditorTarget | null {
  const p = parseNodeId(nodeId);
  if (
    p.kind === 'block' ||
    p.kind === 'udt' ||
    p.kind === 'tagTable' ||
    p.kind === 'source' ||
    p.kind === 'watchTable'
  ) {
    return { kind: p.kind, deviceId: p.dev, objectId: p.id };
  }
  if (p.kind === 'folder' && p.folder === 'tags-all') {
    return { kind: 'allTags', deviceId: p.dev, objectId: '' };
  }
  return null;
}

const touch = (recent: string[], key: string) => [key, ...recent.filter((k) => k !== key)];

/**
 * Rende coerente lo stato: niente chiavi sconosciute o staccate nei riquadri, il focus sul primo
 * riquadro senza divisione, e i riquadri vuoti mostrano l'editor usato più di recente non già visibile.
 */
function normalize(wa: WorkAreaState): WorkAreaState {
  const known = new Set(wa.editors.map((e) => e.key));
  const detached = wa.detached.filter((k) => known.has(k));
  const shown = (k: string | null): k is string =>
    k !== null && known.has(k) && !detached.includes(k);
  const split = wa.split;
  const panes: [string | null, string | null] = [
    shown(wa.panes[0]) ? wa.panes[0] : null,
    split !== 'none' && shown(wa.panes[1]) && wa.panes[1] !== wa.panes[0] ? wa.panes[1] : null,
  ];
  const free = (k: string) => known.has(k) && !detached.includes(k) && !panes.includes(k);
  const recent = [...wa.recent.filter((k) => known.has(k))];
  for (const e of wa.editors) if (!recent.includes(e.key)) recent.push(e.key);
  const count = split === 'none' ? 1 : 2;
  for (let i = 0; i < count; i++) {
    if (panes[i] === null) panes[i] = recent.find(free) ?? null;
  }
  return {
    ...wa,
    detached,
    panes,
    recent,
    focusedPane: split === 'none' ? 0 : wa.focusedPane,
  };
}

/** Mostra `key` nel riquadro con il focus (o, se staccato, chiede di portare in primo piano la finestra). */
function show(wa: WorkAreaState, key: string): WorkAreaState {
  const recent = touch(wa.recent, key);
  if (wa.detached.includes(key)) {
    return { ...wa, recent, focusRequest: { key, n: (wa.focusRequest?.n ?? 0) + 1 } };
  }
  const panes: [string | null, string | null] = [...wa.panes];
  const other = wa.focusedPane === 0 ? 1 : 0;
  if (panes[other] === key) panes[other] = null; // lo stesso editor non sta in due riquadri
  panes[wa.focusedPane] = key;
  return normalize({ ...wa, panes, recent });
}

export function openEditor(wa: WorkAreaState, target: EditorTarget): WorkAreaState {
  const ref = toEditorRef(target);
  const editors = wa.editors.some((e) => e.key === ref.key) ? wa.editors : [...wa.editors, ref];
  return show({ ...wa, editors }, ref.key);
}

export function activateEditor(wa: WorkAreaState, key: string): WorkAreaState {
  return wa.editors.some((e) => e.key === key) ? show(wa, key) : wa;
}

/** Tiene solo gli editor per cui `keep` è vero. */
export function keepEditors(wa: WorkAreaState, keep: (e: EditorRef) => boolean): WorkAreaState {
  const editors = wa.editors.filter(keep);
  if (editors.length === wa.editors.length) return wa;
  const known = new Set(editors.map((e) => e.key));
  return normalize({
    ...wa,
    editors,
    panes: [
      wa.panes[0] && known.has(wa.panes[0]) ? wa.panes[0] : null,
      wa.panes[1] && known.has(wa.panes[1]) ? wa.panes[1] : null,
    ],
  });
}

export const closeEditor = (wa: WorkAreaState, key: string): WorkAreaState =>
  keepEditors(wa, (e) => e.key !== key);

export const closeAllEditors = (wa: WorkAreaState): WorkAreaState =>
  wa.editors.length === 0 ? wa : { ...initialWorkArea(), split: wa.split };

export function setSplit(wa: WorkAreaState, split: SplitMode): WorkAreaState {
  if (wa.split === split) return wa;
  // Accendendo la divisione il riquadro nuovo mostra l'editor usato prima (normalize lo riempie).
  return normalize({ ...wa, split });
}

export const focusPane = (wa: WorkAreaState, i: 0 | 1): WorkAreaState =>
  wa.split === 'none' || wa.focusedPane === i ? wa : { ...wa, focusedPane: i };

export function detachEditor(wa: WorkAreaState, key: string): WorkAreaState {
  if (!wa.editors.some((e) => e.key === key) || wa.detached.includes(key)) return wa;
  return normalize({ ...wa, detached: [...wa.detached, key] });
}

/** Riporta l'editor nei riquadri, in quello con il focus; senza effetto se non era staccato. */
export function attachEditor(wa: WorkAreaState, key: string): WorkAreaState {
  if (!wa.detached.includes(key)) return wa;
  return show({ ...wa, detached: wa.detached.filter((k) => k !== key) }, key);
}
