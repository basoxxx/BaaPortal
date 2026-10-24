import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Mc7Diagnostic, Project } from '@baaportal/project';
import type { DiagEntry, MonitorStep, SimMode } from '@baaportal/sim';
import type { LineMapRow } from '../editors/awl/monitorExtension';
import type { SimStats, SimWarning } from '../sim/protocol';
import type { ImportSummary } from '../project/navigation/tagTableIo';
import * as wa from './workArea';
import type { FindRequest, FindUi, TagReveal } from '../search/findState';
import { initialFindUi } from '../search/findState';
import { applyHistory, HISTORY_LIMIT, pushLimited, recordEdit, type HistoryEntry } from './history';

export { HISTORY_LIMIT, type HistoryEntry };
export type { EditorKind, EditorRef, WorkAreaState } from './workArea';

export type View = 'portal' | 'project';
export type PortalId = 'start' | 'devices' | 'plc' | 'online';
export type StartAction =
  'open' | 'new' | 'migrate' | 'close' | 'firstSteps' | 'installed' | 'help' | 'language';
/** Finestra modale aperta sopra la vista corrente. */
export type DialogState =
  | { kind: 'addDevice' }
  | { kind: 'addBlock'; deviceId: string }
  | { kind: 'collectKit' }
  | { kind: 'settings' }
  | { kind: 'importTagsReport'; fileName: string; tableName: string; summary: ImportSummary }
  | null;

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
  /** Se c'è, il testo da selezionare (spostamenti nel testo mostrato). */
  range?: { from: number; to: number };
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
export type InfoSubTab = 'general' | 'crossRefs' | 'compile';
/** Una riga della scheda Informazioni → Compila: l'esito di un blocco. */
export interface CompileRow {
  deviceId: string;
  blockId: string;
  name: string;
  /** Tipo e numero, p.es. FC5 (un DB di istanza è DB). */
  tag: string;
  status: 'ok' | 'warning' | 'error';
  errors: number;
  warnings: number;
  diagnostics: Mc7Diagnostic[];
}
export interface CompileSummary {
  blocks: number;
  errors: number;
  warnings: number;
}
/**
 * Esiti della compilazione nella sessione, per il documento aperto: non si salvano nel `.baap`.
 * `hashes` e `files` riguardano l'ultima compilazione riuscita di ogni blocco.
 */
export interface CompileState {
  rows: CompileRow[];
  summary: CompileSummary | null;
  hashes: Record<string, string>;
  files: Record<string, Uint8Array>;
  /** Mappa istruzioni MC7 → righe di testo dell'ultima compilazione riuscita (solo blocchi con testo). */
  lines: Record<string, LineMapRow[]>;
  /** Diagnostiche (avvisi) dell'ultima compilazione riuscita di ogni blocco. */
  diagnostics: Record<string, Mc7Diagnostic[]>;
  /** L'ultima compilazione è stata interrotta da Interrompi. */
  interrupted: boolean;
}
/** Richiesta all'editor di un blocco di portare il cursore a rete e riga (da 1); `n` la rende ripetibile. */
export interface CompileReveal {
  deviceId: string;
  blockId: string;
  network: number;
  line: number;
  /** Se c'è, il testo da selezionare nel segmento (spostamenti nel testo mostrato). */
  range?: { from: number; to: number };
  n: number;
}
export interface PanelState {
  open: boolean;
  pinned: boolean;
  size: number;
} // size in % del gruppo
export type PanelName = 'navigation' | 'details' | 'inspector' | 'taskCards';
export type TaskCardId = 'instructions' | 'test' | 'tasks' | 'libraries';

/** Simulatore: spento, in avvio (worker in creazione) o attivo sul dispositivo `deviceId`. */
export interface SimUiState {
  phase: 'off' | 'starting' | 'on';
  deviceId: string | null;
  /** Modo della CPU simulata dall'ultima notifica (STOP finché non arriva). */
  mode: SimMode;
  stats: SimStats | null;
  diagnostics: DiagEntry[];
  warnings: SimWarning[];
  inputs: Uint8Array;
  outputs: Uint8Array;
  /** Un «Carica nel dispositivo» è in corso su questa sessione. */
  downloading: boolean;
  /** Byte aggiunti a mano nel pannello I/O («+ byte»): solo per questa simulazione, non nel progetto. */
  ioExtra: { inputs: number[]; outputs: number[] };
  /** Blocchi caricati nel simulatore dall'ultimo «Carica nel dispositivo»: id → impronta di allora. */
  loaded: Record<string, string>;
  /** Osservazione del programma: il blocco aperto che si osserva (uno solo alla volta). */
  monitor: MonitorUiState | null;
  /** Passi dell'ultimo ciclo del blocco osservato (`null` finché non arrivano o se non disponibile). */
  monitorSteps: MonitorStep[] | null;
  /** ACCU in esadecimale (predefinito) o in decimale; non si salva. */
  monitorHex: boolean;
}

/** Perché l'osservazione non è disponibile (`ok` = disponibile). */
export type MonitorReason = 'ok' | 'notLoaded' | 'stale' | 'noLines';

export interface MonitorUiState {
  deviceId: string;
  blockId: string;
  reason: MonitorReason;
  /** L'editor ha testo non ancora confermato: finché c'è, i valori si sospendono. */
  edited: boolean;
}

export const SIM_OFF: SimUiState = {
  phase: 'off',
  deviceId: null,
  mode: 'STOP',
  stats: null,
  diagnostics: [],
  warnings: [],
  inputs: new Uint8Array(0),
  outputs: new Uint8Array(0),
  downloading: false,
  ioExtra: { inputs: [], outputs: [] },
  loaded: {},
  monitor: null,
  monitorSteps: null,
  monitorHex: true,
};

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
  infoSubTab: InfoSubTab;
  compile: CompileState;
  /** Stato del simulatore (la sessione vera sta in `sim/simController`). */
  sim: SimUiState;
  setSim(patch: Partial<SimUiState>): void;
  compileReveal: CompileReveal | null;
  status: { textKey: string; params?: Record<string, string> } | null;
  panels: Record<PanelName, PanelState>;
  referenceProjectsOpen: boolean;
  taskCard: TaskCardId;
  workArea: wa.WorkAreaState;
  /** Trova e sostituisci: campi, opzioni e risultati dell'ultima ricerca. */
  find: FindUi;
  /** Chiede al pannello di dare il focus a un campo (`n` la rende ripetibile). */
  findRequest: FindRequest | null;
  /** Chiede all'editor delle variabili di selezionare una riga. */
  tagReveal: TagReveal | null;
  patchFind(patch: Partial<FindUi>): void;
  setFindRequest(r: Omit<FindRequest, 'n'> | null): void;
  revealTag(r: Omit<TagReveal, 'n'>): void;
  clearTagReveal(n: number): void;
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
  setInfoSubTab(t: InfoSubTab): void;
  /** Inizio di una compilazione: la scheda Compila si svuota. */
  beginCompile(): void;
  /**
   * Fine: righe e riepilogo; `compiled` ricorda impronta e file dei blocchi riusciti. Un blocco
   * fallito (`failed`) conserva l'ultimo file buono con la sua impronta: l'esportazione lo riusa
   * solo se l'impronta coincide con quella attuale, quindi un file vecchio non esce per sbaglio.
   */
  finishCompile(r: {
    rows: CompileRow[];
    summary: CompileSummary;
    compiled: Record<
      string,
      { hash: string; file: Uint8Array; diagnostics: Mc7Diagnostic[]; lines?: LineMapRow[] }
    >;
    failed: string[];
    interrupted?: boolean;
  }): void;
  /** Apre l'editor del blocco e chiede di portare il cursore a rete e riga. */
  openBlockAt(t: Omit<CompileReveal, 'n'>): void;
  clearCompileReveal(n: number): void;
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

const emptyCompile = (): CompileState => ({
  rows: [],
  summary: null,
  hashes: {},
  files: {},
  lines: {},
  diagnostics: {},
  interrupted: false,
});

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
    infoSubTab: 'general',
    compile: emptyCompile(),
    compileReveal: null,
    status: null,
    panels: structuredClone(DEFAULT_PANELS),
    referenceProjectsOpen: false,
    taskCard: 'instructions',
    workArea: wa.initialWorkArea(),
    find: initialFindUi(),
    findRequest: null,
    tagReveal: null,
    patchFind: (patch) => set((s) => ({ find: { ...s.find, ...patch } })),
    setFindRequest: (r) =>
      set((s) => ({ findRequest: r ? { ...r, n: (s.findRequest?.n ?? 0) + 1 } : null })),
    revealTag: (r) => set((s) => ({ tagReveal: { ...r, n: (s.tagReveal?.n ?? 0) + 1 } })),
    clearTagReveal: (n) => set((s) => (s.tagReveal?.n === n ? { tagReveal: null } : s)),
    setView: (view) => set({ view }),
    setPortal: (portal) => set({ portal }),
    setStartAction: (startAction) => set({ startAction }),
    history: { past: [], future: [] },
    sim: SIM_OFF,
    setSim: (patch) => set((s) => ({ sim: { ...s.sim, ...patch } })),
    setDoc: (doc) => {
      if (doc) revisionCounter = doc.revision; // il prossimo edit prende revision + 1
      set((s) => ({
        doc: doc ? withDirty(doc) : null,
        docLoadId: s.docLoadId + 1,
        workArea: wa.closeAllEditors(s.workArea),
        dialog: null,
        compile: emptyCompile(),
        compileReveal: null,
        find: initialFindUi(),
        findRequest: null,
        tagReveal: null,
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
    setInfoSubTab: (infoSubTab) => set({ infoSubTab }),
    beginCompile: () =>
      set((s) => ({ compile: { ...s.compile, rows: [], summary: null, interrupted: false } })),
    finishCompile: ({ rows, summary, compiled, interrupted }) =>
      set((s) => {
        const hashes = { ...s.compile.hashes };
        const files = { ...s.compile.files };
        const lines = { ...s.compile.lines };
        const diagnostics = { ...s.compile.diagnostics };
        for (const [id, c] of Object.entries(compiled)) {
          hashes[id] = c.hash;
          files[id] = c.file;
          if (c.lines) lines[id] = c.lines;
          else delete lines[id];
          diagnostics[id] = c.diagnostics;
        }
        return {
          compile: {
            rows,
            summary,
            hashes,
            files,
            lines,
            diagnostics,
            interrupted: interrupted ?? false,
          },
        };
      }),
    openBlockAt: (t) => {
      if (!get().doc) return;
      const target = { kind: 'block' as const, deviceId: t.deviceId, objectId: t.blockId };
      set((s) => ({
        workArea: wa.openEditor(s.workArea, target),
        selection: wa.nodeIdOfEditor(target),
        compileReveal: { ...t, n: (s.compileReveal?.n ?? 0) + 1 },
      }));
    },
    clearCompileReveal: (n) => set((s) => (s.compileReveal?.n === n ? { compileReveal: null } : s)),
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
