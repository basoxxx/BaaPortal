import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Project, ProjectMeta } from '@baaportal/project';

export type View = 'portal' | 'project';
export type PortalId = 'start' | 'devices' | 'plc' | 'online';
export type StartAction = 'open' | 'new' | 'migrate' | 'close' | 'firstSteps' | 'installed' | 'help' | 'language';
export type TreeNodeId =
  | 'project' | 'add-device' | 'devices-networks' | 'common-data' | 'doc-settings' | 'languages' | 'online-access';

export interface OpenDoc { project: Project; filePath: string; dirty: boolean }
export interface InfoMessage {
  id: number;
  /** Data locale AAAA-MM-GG. */
  date: string;
  time: string;
  severity: 'info' | 'warning' | 'error';
  textKey: string;
  params?: Record<string, string>;
}
export interface PanelState { open: boolean; pinned: boolean; size: number } // size in % del gruppo
export type PanelName = 'navigation' | 'details' | 'inspector' | 'taskCards';
export type TaskCardId = 'instructions' | 'test' | 'tasks' | 'libraries';

export interface AppState {
  view: View;
  portal: PortalId;
  startAction: StartAction;
  doc: OpenDoc | null;
  /** Cresce a ogni documento caricato (apertura, creazione, chiusura); non cresce con il salvataggio. */
  docLoadId: number;
  selection: TreeNodeId | null;
  messages: InfoMessage[];
  status: { textKey: string; params?: Record<string, string> } | null;
  panels: Record<PanelName, PanelState>;
  referenceProjectsOpen: boolean;
  taskCard: TaskCardId;
  setView(v: View): void;
  setPortal(p: PortalId): void;
  setStartAction(a: StartAction): void;
  setDoc(d: OpenDoc | null): void; // nuovo documento caricato o chiuso
  replaceDoc(d: OpenDoc): void; // stesso documento dopo un salvataggio (anche con nome nuovo)
  updateMeta(patch: Partial<Pick<ProjectMeta, 'author' | 'comment'>>): void; // imposta dirty
  select(id: TreeNodeId | null): void;
  pushMessage(m: Omit<InfoMessage, 'id' | 'time' | 'date'>): void; // aggiorna anche status
  setPanel(name: PanelName, patch: Partial<PanelState>): void;
  setReferenceProjectsOpen(o: boolean): void;
  setTaskCard(t: TaskCardId): void;
}

export const DEFAULT_PANELS: Record<PanelName, PanelState> = {
  navigation: { open: true, pinned: true, size: 20 },
  details: { open: true, pinned: true, size: 25 },
  inspector: { open: true, pinned: true, size: 30 },
  taskCards: { open: true, pinned: true, size: 22 },
};

const pad = (n: number) => String(n).padStart(2, '0');
const formatDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const formatTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

export function createAppStore(now: () => Date = () => new Date()): StoreApi<AppState> {
  let nextId = 1;
  return createStore<AppState>()((set) => ({
    view: 'portal',
    portal: 'start',
    startAction: 'open',
    doc: null,
    docLoadId: 0,
    selection: null,
    messages: [],
    status: null,
    panels: structuredClone(DEFAULT_PANELS),
    referenceProjectsOpen: false,
    taskCard: 'instructions',
    setView: (view) => set({ view }),
    setPortal: (portal) => set({ portal }),
    setStartAction: (startAction) => set({ startAction }),
    setDoc: (doc) => set((s) => ({ doc, docLoadId: s.docLoadId + 1 })),
    replaceDoc: (doc) => set({ doc }),
    updateMeta: (patch) =>
      set((s) =>
        s.doc
          ? { doc: { ...s.doc, dirty: true, project: { ...s.doc.project, meta: { ...s.doc.project.meta, ...patch } } } }
          : s,
      ),
    select: (selection) => set({ selection }),
    pushMessage: (m) =>
      set((s) => {
        const at = now();
        return {
          messages: [...s.messages, { ...m, id: nextId++, date: formatDate(at), time: formatTime(at) }],
          status: { textKey: m.textKey, ...(m.params ? { params: m.params } : {}) },
        };
      }),
    setPanel: (name, patch) => set((s) => ({ panels: { ...s.panels, [name]: { ...s.panels[name], ...patch } } })),
    setReferenceProjectsOpen: (referenceProjectsOpen) => set({ referenceProjectsOpen }),
    setTaskCard: (taskCard) => set({ taskCard }),
  }));
}
