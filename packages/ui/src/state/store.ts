import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Project } from '@baaportal/project';
import * as wa from './workArea';
import { applyHistory, HISTORY_LIMIT, pushLimited, recordEdit, type HistoryEntry } from './history';

export { HISTORY_LIMIT, type HistoryEntry };
export type { EditorKind, EditorRef, WorkAreaState } from './workArea';

export type View = 'portal' | 'project';
export type PortalId = 'start' | 'devices' | 'plc' | 'online';
export type StartAction =
  'open' | 'new' | 'migrate' | 'close' | 'firstSteps' | 'installed' | 'help' | 'language';
/** Finestra modale aperta sopra la vista corrente. */
export type DialogState = { kind: 'addDevice' } | { kind: 'addBlock'; deviceId: string } | null;

export type EditAction = 'cut' | 'copy' | 'paste' | 'delete' | 'rename' | 'selectAll';
/** Chi riceve i comandi del menu Modifica: l'elemento (albero, griglia…) che ha il focus. */
export interface EditTarget {
  id: string;
  can: Partial<Record<EditAction, boolean>>;
  run(action: EditAction): void | Promise<void>;
}
export type InspectorTab = 'properties' | 'info' | 'diagnostics';

export interface OpenDoc {
  project: Project;
  filePath: string;
  dirty: boolean;
  /** Numero dell'ultima modifica applicata; undo/redo lo riportano a quello della voce. */
  revision: number;
  savedRevision: number;
}
/** Dove porta il clic su un messaggio: una sorgente, a riga e colonna (da 1). */
export interface InfoTarget {
  kind: 'source';
  deviceId: string;
  sourceId: string;
  line: number;
  col: number;
}
/** Richiesta all'editor di una sorgente di portare il cursore in un punto (`n` la rende ripetibile). */
export interface SourceReveal extends Omit<InfoTarget, 'kind'> {
  n: number;
}
export interface InfoMessage {
  id: number;
  /** Data locale AAAA-MM-GG. */
  date: string;
  time: string;
  severity: 'info' | 'warning' | 'error';
  textKey: string;
  params?: Record<string, string>;
  target?: InfoTarget;
}
export interface PanelState {
  open: boolean;
  pinned: boolean;
  size: number;
} // size in % del gruppo
export type PanelName = 'navigation' | 'details' | 'inspector' | 'taskCards';
export type TaskCardId = 'instructions' | 'test' | 'tasks' | 'libraries';

export interface AppState {
  view: View;
  portal: PortalId;
  startAction: StartAction;
  doc: OpenDoc | null;
  /** Cresce a ogni documento caricato (apertura, creazione, chiusura); non cresce con il salvataggio. */
  docLoadId: number;
  history: { past: HistoryEntry[]; future: HistoryEntry[] };
  /** Id del nodo selezionato nell'albero (vedi navigation/treeIds). */
  selection: string | null;
  dialog: DialogState;
  editTarget: EditTarget | null;
  inspectorTab: InspectorTab;
  messages: InfoMessage[];
  reveal: SourceReveal | null;
  status: { textKey: string; params?: Record<string, string> } | null;
  panels: Record<PanelName, PanelState>;
  referenceProjectsOpen: boolean;
  taskCard: TaskCardId;
  workArea: wa.WorkAreaState;
  setView(v: View): void;
  setPortal(p: PortalId): void;
  setStartAction(a: StartAction): void;
  setDoc(d: OpenDoc | null): void; // nuovo documento caricato o chiuso
  /** Modifica il progetto con una ricetta immer; false (e nessuna voce) se non cambia nulla. */
  edit(labelKey: string, recipe: (draft: Project) => void): boolean;
  undo(): void;
  redo(): void;
  /** Dopo un salvataggio: nessuna voce di cronologia. */
  markSaved(a: { filePath: string; revision: number; modifiedAt: string }): void;
  select(id: string | null): void;
  openDialog(d: NonNullable<DialogState>): void;
  closeDialog(): void;
  setEditTarget(t: EditTarget | null): void;
  setInspectorTab(t: InspectorTab): void;
  pushMessage(m: Omit<InfoMessage, 'id' | 'time' | 'date'>): void; // aggiorna anche status
  /** Apre la sorgente (come editor) e chiede di portare il cursore alla riga e colonna. */
  openSourceAt(t: Omit<InfoTarget, 'kind'>): void;
  /** L'editor ha eseguito la richiesta. */
  clearReveal(n: number): void;
  setPanel(name: PanelName, patch: Partial<PanelState>): void;
  setReferenceProjectsOpen(o: boolean): void;
  setTaskCard(t: TaskCardId): void;
  /** Apre l'editor (o lo attiva, o porta in primo piano la sua finestra) e seleziona il suo nodo. */
  openEditor(target: wa.EditorTarget): void;
  closeEditor(key: string): void;
  closeAllEditors(): void;
  /** Attiva l'editor nel riquadro con il focus e seleziona il suo nodo. */
  activateEditor(key: string): void;
  setSplit(mode: wa.SplitMode): void;
  focusPane(i: 0 | 1): void;
  detachEditor(key: string): void;
  attachEditor(key: string): void;
}

export const DEFAULT_PANELS: Record<PanelName, PanelState> = {
  navigation: { open: true, pinned: true, size: 20 },
  details: { open: true, pinned: true, size: 25 },
  inspector: { open: true, pinned: true, size: 30 },
  taskCards: { open: true, pinned: true, size: 22 },
};

const pad = (n: number) => String(n).padStart(2, '0');
const formatDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const formatTime = (d: Date) =>
  `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

export function createAppStore(now: () => Date = () => new Date()): StoreApi<AppState> {
  let nextId = 1;
  // Il contatore delle revisioni cresce sempre: dopo un undo, un nuovo edit non riusa numeri.
  let revisionCounter = 0;
  const withDirty = (d: OpenDoc): OpenDoc => ({ ...d, dirty: d.revision !== d.savedRevision });
  return createStore<AppState>()((set, get) => ({
    view: 'portal',
    portal: 'start',
    startAction: 'open',
    doc: null,
    docLoadId: 0,
    selection: null,
    dialog: null,
    editTarget: null,
    inspectorTab: 'properties',
    messages: [],
    reveal: null,
    status: null,
    panels: structuredClone(DEFAULT_PANELS),
    referenceProjectsOpen: false,
    taskCard: 'instructions',
    workArea: wa.initialWorkArea(),
    setView: (view) => set({ view }),
    setPortal: (portal) => set({ portal }),
    setStartAction: (startAction) => set({ startAction }),
    history: { past: [], future: [] },
    setDoc: (doc) => {
      if (doc) revisionCounter = doc.revision; // il prossimo edit prende revision + 1
      set((s) => ({
        doc: doc ? withDirty(doc) : null,
        docLoadId: s.docLoadId + 1,
        workArea: wa.closeAllEditors(s.workArea),
        dialog: null,
        history: { past: [], future: [] },
      }));
    },
    edit: (labelKey, recipe) => {
      const { doc, history } = get();
      if (!doc) return false;
      const rec = recordEdit(doc.project, recipe);
      if (!rec) return false;
      const after = ++revisionCounter;
      const entry: HistoryEntry = {
        labelKey,
        patches: rec.patches,
        inverse: rec.inverse,
        before: doc.revision,
        after,
      };
      set({
        doc: withDirty({ ...doc, project: rec.next, revision: after }),
        history: { past: pushLimited(history.past, entry), future: [] },
      });
      return true;
    },
    undo: () => {
      const { doc, history } = get();
      const entry = history.past[history.past.length - 1];
      if (!doc || !entry) return;
      set({
        doc: withDirty({
          ...doc,
          project: applyHistory(doc.project, entry.inverse),
          revision: entry.before,
        }),
        history: { past: history.past.slice(0, -1), future: [entry, ...history.future] },
      });
    },
    redo: () => {
      const { doc, history } = get();
      const entry = history.future[0];
      if (!doc || !entry) return;
      set({
        doc: withDirty({
          ...doc,
          project: applyHistory(doc.project, entry.patches),
          revision: entry.after,
        }),
        history: { past: [...history.past, entry], future: history.future.slice(1) },
      });
    },
    markSaved: ({ filePath, revision, modifiedAt }) =>
      set((s) =>
        s.doc
          ? {
              doc: withDirty({
                ...s.doc,
                filePath,
                savedRevision: revision,
                project: { ...s.doc.project, meta: { ...s.doc.project.meta, modifiedAt } },
              }),
            }
          : s,
      ),
    select: (selection) => set({ selection }),
    openDialog: (dialog) => set({ dialog }),
    closeDialog: () => set({ dialog: null }),
    setEditTarget: (editTarget) => set({ editTarget }),
    setInspectorTab: (inspectorTab) => set({ inspectorTab }),
    pushMessage: (m) =>
      set((s) => {
        const at = now();
        return {
          messages: [
            ...s.messages,
            { ...m, id: nextId++, date: formatDate(at), time: formatTime(at) },
          ],
          status: { textKey: m.textKey, ...(m.params ? { params: m.params } : {}) },
        };
      }),
    openSourceAt: (t) => {
      if (!get().doc) return;
      const target = { kind: 'source' as const, deviceId: t.deviceId, objectId: t.sourceId };
      set((s) => ({
        workArea: wa.openEditor(s.workArea, target),
        selection: wa.nodeIdOfEditor(target),
        reveal: { ...t, n: (s.reveal?.n ?? 0) + 1 },
      }));
    },
    clearReveal: (n) => set((s) => (s.reveal?.n === n ? { reveal: null } : s)),
    setPanel: (name, patch) =>
      set((s) => ({ panels: { ...s.panels, [name]: { ...s.panels[name], ...patch } } })),
    setReferenceProjectsOpen: (referenceProjectsOpen) => set({ referenceProjectsOpen }),
    setTaskCard: (taskCard) => set({ taskCard }),
    openEditor: (target) => {
      if (!get().doc) return;
      set((s) => ({
        workArea: wa.openEditor(s.workArea, target),
        selection: wa.nodeIdOfEditor(target),
      }));
    },
    activateEditor: (key) => {
      const e = get().workArea.editors.find((x) => x.key === key);
      if (!e) return;
      set((s) => ({
        workArea: wa.activateEditor(s.workArea, key),
        selection: wa.nodeIdOfEditor(e),
      }));
    },
    closeEditor: (key) => set((s) => ({ workArea: wa.closeEditor(s.workArea, key) })),
    closeAllEditors: () => set((s) => ({ workArea: wa.closeAllEditors(s.workArea) })),
    setSplit: (mode) => set((s) => ({ workArea: wa.setSplit(s.workArea, mode) })),
    focusPane: (i) => set((s) => ({ workArea: wa.focusPane(s.workArea, i) })),
    detachEditor: (key) => set((s) => ({ workArea: wa.detachEditor(s.workArea, key) })),
    attachEditor: (key) => set((s) => ({ workArea: wa.attachEditor(s.workArea, key) })),
  }));
}
