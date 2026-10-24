import { createStore, useStore } from 'zustand';
import { findCpu } from '@baaportal/catalog';
import { findDevice, type Project } from '@baaportal/project';
import type { StoreApi } from 'zustand/vanilla';
import type { BaaBridge } from '../../bridge';
import { t } from '../../i18n';
import { copyToClipboard, type ClipboardItem } from '../../services/clipboard';
import { readProjectFile } from '../../services/projectService';
import type { AppState } from '../../state/store';
import { itemName, itemsOf, refsOfNodes, reportSkipped } from '../navigation/objectCommands';
import { targetPlcId, type TreeArea } from '../navigation/treeIds';
import { areaOfItem, pasteObjects } from '../objectActions';

/** Un progetto aperto per consultazione: letto una volta, mai modificato né salvato. */
export interface ReferenceProject {
  key: string;
  path: string;
  /** Congelato: la sola lettura è strutturale. */
  readonly doc: Readonly<Project>;
}

interface ReferenceState {
  list: ReferenceProject[];
  /** Riferimento portato in vista da una nuova apertura dello stesso file. */
  revealed: { key: string; tick: number } | null;
}

const refStore = createStore<ReferenceState>(() => ({ list: [], revealed: null }));
let counter = 0;

/** Separatore tra la chiave del riferimento e l'id del nodo (gli id dei nodi contengono ':'). */
const SEP = '|';
export const qualify = (key: string, nodeId: string) => `${key}${SEP}${nodeId}`;
export function unqualify(qualified: string): { key: string; nodeId: string } | null {
  const i = qualified.indexOf(SEP);
  return i > 0 ? { key: qualified.slice(0, i), nodeId: qualified.slice(i + 1) } : null;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** Aggiunge il file alla lista dei riferimenti; lo stesso percorso già aperto viene portato in vista. */
export async function openReference(path: string, bridge: BaaBridge): Promise<void> {
  const existing = refStore.getState().list.find((r) => r.path === path);
  if (existing) {
    refStore.setState((s) => ({
      revealed: { key: existing.key, tick: (s.revealed?.tick ?? 0) + 1 },
    }));
    return;
  }
  const read = await readProjectFile(bridge, path, t);
  if (!read.ok) {
    await bridge.showError(t('errors.title'), read.message);
    return;
  }
  // Nel frattempo lo stesso file può essere stato aperto da un'altra richiesta.
  if (refStore.getState().list.some((r) => r.path === path)) return;
  const ref: ReferenceProject = { key: `ref${++counter}`, path, doc: deepFreeze(read.project) };
  refStore.setState((s) => ({
    list: [...s.list, ref],
    revealed: { key: ref.key, tick: (s.revealed?.tick ?? 0) + 1 },
  }));
}

export function closeReference(key: string): void {
  refStore.setState((s) => ({ list: s.list.filter((r) => r.key !== key) }));
}

/** Solo per i test: svuota la lista. */
export function resetReferences(): void {
  refStore.setState({ list: [], revealed: null });
}

export const useReferences = (): ReferenceProject[] => useStore(refStore, (s) => s.list);
export const useRevealedReference = () => useStore(refStore, (s) => s.revealed);
export const useReferencesSnapshot = (): ReferenceProject[] => refStore.getState().list;

/** Blocchi, UDT e tabelle dei nodi (id qualificati) come elementi copiabili, copiati in profondità. */
function itemsFromReference(key: string, nodeIds: Iterable<string>) {
  const ref = refStore.getState().list.find((r) => r.key === key);
  const local = [...nodeIds].flatMap((q) => {
    const u = unqualify(q);
    return u && u.key === key ? [u.nodeId] : [];
  });
  const refs = refsOfNodes(local);
  const first = refs[0];
  const dev = ref && first && findDevice(ref.doc as Project, first.deviceId);
  if (!dev || !first) return null;
  const items = itemsOf(
    dev,
    refs.filter((r) => r.deviceId === dev.id),
  ).map((i) => structuredClone(i));
  return items.length > 0 ? { deviceId: dev.id, items } : null;
}

/** Riempie gli appunti con gli oggetti del riferimento (copia indipendente). false se non c'è nulla. */
export function copyFromReference(key: string, nodeIds: string[], bridge: BaaBridge): boolean {
  const got = itemsFromReference(key, nodeIds);
  if (!got) return false;
  copyToClipboard(bridge, got.items.map(itemName).join('\n'), {
    kind: 'objects',
    deviceId: got.deviceId,
    items: got.items,
  });
  return true;
}

/** Il progetto aperto ha un PLC dove incollare? */
export const canCopyIntoProject = (s: Pick<AppState, 'doc' | 'selection'>) =>
  targetPlcId(s) !== null;

const AREAS: TreeArea[] = ['blocks', 'types', 'tags'];

/** "Copia nel progetto": copia e incolla nella cartella corrispondente del PLC attivo, in un solo `edit`. */
export function copyIntoProject(
  store: StoreApi<AppState>,
  bridge: BaaBridge,
  key: string,
  nodeIds: string[],
): boolean {
  const got = itemsFromReference(key, nodeIds);
  const devId = targetPlcId(store.getState());
  if (!got || !devId) return false;
  copyToClipboard(bridge, got.items.map(itemName).join('\n'), {
    kind: 'objects',
    deviceId: got.deviceId,
    items: got.items,
  });
  let pasted = 0;
  store.getState().edit('history.paste', (p) => {
    const dev = findDevice(p, devId);
    if (!dev) return;
    for (const area of AREAS) {
      const items: ClipboardItem[] = got.items.filter((i) => areaOfItem(i) === area);
      if (items.length === 0) continue;
      const done = pasteObjects(
        dev,
        { kind: 'objects', deviceId: got.deviceId, items },
        '',
        findCpu(dev.cpu.typeId),
        () => globalThis.crypto.randomUUID(),
      );
      pasted += done.length;
    }
  });
  reportSkipped(store, got.items.length - pasted);
  return true;
}
