import type { StoreApi } from 'zustand/vanilla';
import { findCpu } from '@baaportal/catalog';
import {
  findBlock,
  findDevice,
  findTagTable,
  findUdt,
  renameWithReferences,
  uniqueName,
  type ObjectRef,
  type PlcDevice,
} from '@baaportal/project';
import { sameName, validateS7Name } from '@baaportal/s7-types';
import type { BaaBridge } from '../../bridge';
import { t } from '../../i18n';
import {
  copyToClipboard,
  forgetClipboard,
  readClipboard,
  type ClipboardItem,
  type ClipboardPayload,
} from '../../services/clipboard';
import type { AppState, OpenDoc } from '../../state/store';
import {
  addGroup,
  areaOfItem,
  areaOfRef,
  canRename,
  canRenameGroup,
  deleteGroup,
  deleteObjects,
  groupPaths,
  isStandardTable,
  moveTags,
  moveToGroup,
  pasteObjects,
  renameGroup,
} from '../objectActions';
import { ids, parseNodeId, type TreeArea } from './treeIds';

export interface ObjectCtx {
  store: StoreApi<AppState>;
  bridge: BaaBridge;
}

type ObjectsPayload = Extract<ClipboardPayload, { kind: 'objects' }>;
/** Bersaglio di un incolla o di un rilascio: area e gruppo ('' = la cartella stessa). */
export interface Container {
  dev: string;
  area: TreeArea;
  group: string;
  /** Il nodo è la cartella o il gruppo, non un oggetto che ne fa parte. */
  isContainer: boolean;
}

const newId = () => globalThis.crypto.randomUUID();
const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const lastOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const deviceOf = (doc: OpenDoc | null, id: string) =>
  doc ? findDevice(doc.project, id) : undefined;

/** Cartella o gruppo a cui appartiene il nodo, o null se il nodo non può contenere oggetti. */
export function containerOf(doc: OpenDoc | null, nodeId: string): Container | null {
  const p = parseNodeId(nodeId);
  if (p.kind === 'folder') {
    return p.folder === 'blocks' || p.folder === 'tags' || p.folder === 'types'
      ? { dev: p.dev, area: p.folder, group: '', isContainer: true }
      : null;
  }
  if (p.kind === 'group') return { dev: p.dev, area: p.area, group: p.path, isContainer: true };
  if (p.kind !== 'block' && p.kind !== 'udt' && p.kind !== 'tagTable') return null;
  const dev = deviceOf(doc, p.dev);
  const obj =
    p.kind === 'block'
      ? dev && findBlock(dev, p.id)
      : p.kind === 'udt'
        ? dev && findUdt(dev, p.id)
        : dev && findTagTable(dev, p.id);
  if (!obj) return null;
  const area = p.kind === 'block' ? 'blocks' : p.kind === 'udt' ? 'types' : 'tags';
  return { dev: p.dev, area, group: obj.group, isContainer: false };
}

/** Nodo della cartella di un'area. */
export const folderNodeId = (dev: string, area: TreeArea) => ids.folder(dev, area);

/** Blocchi, UDT e tabelle rappresentati dai nodi (gli altri nodi sono ignorati). */
export function refsOfNodes(nodeIds: Iterable<string>): ObjectRef[] {
  const out: ObjectRef[] = [];
  for (const n of nodeIds) {
    const p = parseNodeId(n);
    if (p.kind === 'block' || p.kind === 'udt' || p.kind === 'tagTable') {
      out.push({ kind: p.kind, deviceId: p.dev, id: p.id });
    }
  }
  return out;
}

export function groupsOfNodes(nodeIds: Iterable<string>) {
  const out: { dev: string; area: TreeArea; path: string }[] = [];
  for (const n of nodeIds) {
    const p = parseNodeId(n);
    if (p.kind === 'group') out.push({ dev: p.dev, area: p.area, path: p.path });
  }
  return out;
}

function itemsOf(dev: PlcDevice, refs: ObjectRef[]): ClipboardItem[] {
  const out: ClipboardItem[] = [];
  for (const r of refs) {
    if (r.kind === 'block') {
      const block = findBlock(dev, r.id);
      if (block) out.push({ type: 'block', block });
    } else if (r.kind === 'udt') {
      const udt = findUdt(dev, r.id);
      if (udt) out.push({ type: 'udt', udt });
    } else if (r.kind === 'tagTable') {
      const table = findTagTable(dev, r.id);
      if (table) out.push({ type: 'tagTable', table });
    }
  }
  return out;
}

const itemName = (i: ClipboardItem) =>
  i.type === 'block' ? i.block.name : i.type === 'udt' ? i.udt.name : i.table.name;
const itemRef = (deviceId: string, i: ClipboardItem): ObjectRef =>
  i.type === 'block'
    ? { kind: 'block', deviceId, id: i.block.id }
    : i.type === 'udt'
      ? { kind: 'udt', deviceId, id: i.udt.id }
      : { kind: 'tagTable', deviceId, id: i.table.id };

/** Oggetti dei nodi → appunti (testo: un nome per riga). false se non c'era nulla da copiare. */
export function copyNodes(ctx: ObjectCtx, nodeIds: Iterable<string>, cut: boolean): boolean {
  const doc = ctx.store.getState().doc;
  const refs = refsOfNodes(nodeIds);
  const first = refs[0];
  const dev = first && deviceOf(doc, first.deviceId);
  if (!first || !dev) return false;
  const items = itemsOf(
    dev,
    refs.filter((r) => r.deviceId === dev.id),
  );
  if (items.length === 0) return false;
  copyToClipboard(ctx.bridge, items.map(itemName).join('\n'), {
    kind: 'objects',
    deviceId: dev.id,
    items,
    cut,
  });
  return true;
}

function reportSkipped(store: StoreApi<AppState>, skipped: number): void {
  if (skipped > 0) {
    store.getState().pushMessage({
      severity: 'info',
      textKey: 'messages.pasteNoNumber',
      params: { count: String(skipped) },
    });
  }
}

/** Copia gli oggetti nel contenitore (un solo `edit`); con `removeFrom` elimina poi le origini. */
function pasteItems(
  store: StoreApi<AppState>,
  target: Container,
  payload: ObjectsPayload,
  removeFrom?: ObjectRef[],
): ObjectRef[] {
  let created: ObjectRef[] = [];
  store.getState().edit('history.paste', (p) => {
    const dev = findDevice(p, target.dev);
    if (!dev) return;
    const from: number[] = [];
    created = pasteObjects(dev, payload, target.group, findCpu(dev.cpu.typeId), newId, from);
    // Si eliminano solo le origini la cui copia è stata creata davvero.
    const done = removeFrom?.filter((_, i) => from.includes(i));
    const src = done?.[0] && findDevice(p, done[0].deviceId);
    if (src && done) deleteObjects(src, done);
  });
  reportSkipped(store, payload.items.length - created.length);
  return created;
}

export const selectRef = (store: StoreApi<AppState>, r: ObjectRef | undefined) => {
  const target =
    r?.kind === 'block'
      ? ids.block(r.deviceId, r.id)
      : r?.kind === 'udt'
        ? ids.udt(r.deviceId, r.id)
        : r?.kind === 'tagTable'
          ? ids.tagTable(r.deviceId, r.id)
          : null;
  if (target) store.getState().select(target);
};

/** Incolla il contenuto degli appunti nel contenitore del nodo. */
export async function pasteAt(ctx: ObjectCtx, nodeId: string): Promise<void> {
  const { store } = ctx;
  const target = containerOf(store.getState().doc, nodeId);
  const { payload } = await readClipboard(ctx.bridge);
  if (!target || payload?.kind !== 'objects') return;
  let items = payload.items.filter((i) => areaOfItem(i) === target.area);
  if (payload.cut) {
    // Dopo il taglio l'origine può essere cambiata: si incolla la versione attuale.
    const src = deviceOf(store.getState().doc, payload.deviceId);
    items = src
      ? itemsOf(
          src,
          items.map((i) => itemRef(payload.deviceId, i)),
        )
      : [];
    if (items.length === 0) forgetClipboard();
  }
  if (items.length === 0) return;
  const refs = items.map((i) => itemRef(payload.deviceId, i));

  if (payload.cut) {
    // Nello stesso PLC il taglio è uno spostamento: gli oggetti restano gli stessi.
    if (payload.deviceId === target.dev) {
      store.getState().edit('history.move', (p) => {
        const dev = findDevice(p, target.dev);
        if (dev) moveToGroup(dev, refs, target.group);
      });
    } else {
      const made = pasteItems(store, target, { ...payload, items }, refs);
      selectRef(store, made[0]);
    }
    forgetClipboard();
    return;
  }
  selectRef(store, pasteItems(store, target, { ...payload, items })[0]);
}

const MAX_LISTED = 10;

/** Elimina oggetti e gruppi dei nodi, dopo conferma. La Tabella standard resta con un messaggio. */
export async function deleteNodes(ctx: ObjectCtx, nodeIds: Iterable<string>): Promise<void> {
  const { store } = ctx;
  const doc = store.getState().doc;
  const all = [...nodeIds];
  const standard = (r: ObjectRef) => {
    const dev = deviceOf(doc, r.deviceId);
    return r.kind === 'tagTable' && !!dev && isStandardTable(dev, r.id);
  };
  const refs = refsOfNodes(all);
  const removable = refs.filter((r) => !standard(r));
  const groups = groupsOfNodes(all);
  if (removable.length < refs.length) {
    store.getState().pushMessage({ severity: 'warning', textKey: 'messages.standardTableLocked' });
  }
  if (removable.length === 0 && groups.length === 0) return;

  const names = [
    ...removable.flatMap((r) => {
      const dev = deviceOf(doc, r.deviceId);
      const items = dev ? itemsOf(dev, [r]) : [];
      return items.map(itemName);
    }),
    ...groups.map((g) => lastOf(g.path)),
  ];
  const listed = names.slice(0, MAX_LISTED);
  if (names.length > MAX_LISTED) {
    listed.push(t('objects.deleteMore', { count: names.length - MAX_LISTED }));
  }
  const yes = await ctx.bridge.askQuestion({
    title: t('objects.deleteTitle'),
    message: `${t('objects.deleteMessage')}\n\n${listed.join('\n')}`,
    yes: t('objects.yes'),
    no: t('objects.no'),
  });
  if (!yes) return;

  store.getState().edit('history.delete', (p) => {
    for (const g of groups) {
      const dev = findDevice(p, g.dev);
      if (dev) deleteGroup(dev, g.area, g.path);
    }
    for (const r of removable) {
      const dev = findDevice(p, r.deviceId);
      if (dev) deleteObjects(dev, [r]);
    }
  });
  const sel = store.getState().selection;
  const first = removable[0];
  const area = first ? areaOfRef(first) : groups[0]?.area;
  const dev = first?.deviceId ?? groups[0]?.dev;
  // La selezione non deve restare su un nodo che non esiste più.
  if (sel && area && dev && all.includes(sel)) store.getState().select(folderNodeId(dev, area));
}

// ---- rinomina -----------------------------------------------------------------------------

/** Nome attuale e possibilità di rinominare il nodo (blocchi, UDT, tabelle non standard, gruppi, PLC). */
export function renameInfo(doc: OpenDoc | null, nodeId: string): { name: string } | null {
  const p = parseNodeId(nodeId);
  const dev = 'dev' in p ? deviceOf(doc, p.dev) : undefined;
  if (!dev) return null;
  switch (p.kind) {
    case 'plc':
      return { name: dev.name };
    case 'group':
      return { name: lastOf(p.path) };
    case 'block': {
      const b = findBlock(dev, p.id);
      return b ? { name: b.name } : null;
    }
    case 'udt': {
      const u = findUdt(dev, p.id);
      return u ? { name: u.name } : null;
    }
    case 'tagTable': {
      const tb = findTagTable(dev, p.id);
      return tb && !isStandardTable(dev, tb.id) ? { name: tb.name } : null;
    }
    default:
      return null;
  }
}

export type RenameError = 'INVALID' | 'DUPLICATE';

/** Verifica il nome senza modificare nulla. */
export function checkRename(doc: OpenDoc | null, nodeId: string, name: string): RenameError | null {
  const p = parseNodeId(nodeId);
  const dev = 'dev' in p ? deviceOf(doc, p.dev) : undefined;
  if (!doc || !dev) return 'INVALID';
  if (p.kind === 'group') return canRenameGroup(dev, p.area, p.path, name);
  if (p.kind === 'plc') {
    if (!validateS7Name(name).ok) return 'INVALID';
    return doc.project.devices.some((d) => d.id !== dev.id && sameName(d.name, name))
      ? 'DUPLICATE'
      : null;
  }
  if (p.kind === 'block' || p.kind === 'udt' || p.kind === 'tagTable') {
    return canRename(dev, { kind: p.kind, deviceId: dev.id, id: p.id }, name);
  }
  return 'INVALID';
}

/** Rinomina il nodo (un solo `edit`); restituisce l'errore, oppure null se è andata a buon fine. */
export function renameNode(
  store: StoreApi<AppState>,
  nodeId: string,
  name: string,
): RenameError | null {
  const error = checkRename(store.getState().doc, nodeId, name);
  if (error) return error;
  const p = parseNodeId(nodeId);
  if (p.kind === 'group') {
    store.getState().edit('history.rename', (d) => {
      const dev = findDevice(d, p.dev);
      if (dev) renameGroup(dev, p.area, p.path, name);
    });
    const renamed = parentOf(p.path) === '' ? name : `${parentOf(p.path)}/${name}`;
    if (store.getState().selection === nodeId)
      store.getState().select(ids.group(p.dev, p.area, renamed));
    return null;
  }
  const ref: ObjectRef | null =
    p.kind === 'plc'
      ? { kind: 'device', deviceId: p.dev }
      : p.kind === 'block' || p.kind === 'udt' || p.kind === 'tagTable'
        ? { kind: p.kind, deviceId: p.dev, id: p.id }
        : null;
  if (ref) {
    store.getState().edit('history.rename', (d) => {
      const dev = findDevice(d, ref.deviceId);
      if (dev) renameWithReferences(dev, ref, name);
    });
  }
  return null;
}

/** Aggiunge un gruppo vuoto nel contenitore del nodo; restituisce l'id del suo nodo. */
export function addGroupAt(store: StoreApi<AppState>, nodeId: string): string | null {
  const c = containerOf(store.getState().doc, nodeId);
  const dev = c && deviceOf(store.getState().doc, c.dev);
  if (!c || !dev || !c.isContainer) return null;
  const siblings = [...groupPaths(dev, c.area)].filter((g) => parentOf(g) === c.group).map(lastOf);
  const name = uniqueName(t('defaults.group'), siblings);
  store.getState().edit('history.addGroup', (p) => {
    const d = findDevice(p, c.dev);
    if (d) addGroup(d, c.area, c.group, name);
  });
  return ids.group(c.dev, c.area, c.group === '' ? name : `${c.group}/${name}`);
}

// ---- trascinamento ------------------------------------------------------------------------

export interface DragData {
  deviceId: string;
  refs: ObjectRef[];
}
const DRAG_MIME = 'application/x-baaportal';
// Durante dragover i dati del trascinamento non sono leggibili: si ricordano qui.
let currentDrag: DragData | null = null;

interface DataTransferLike {
  setData(format: string, data: string): void;
  effectAllowed?: string;
}

/** Avvia il trascinamento di `refs` (tutti dello stesso PLC); i nomi vanno nel testo semplice. */
export function beginDrag(
  dt: DataTransferLike,
  doc: OpenDoc | null,
  deviceId: string,
  refs: ObjectRef[],
): void {
  const dev = deviceOf(doc, deviceId);
  currentDrag = { deviceId, refs };
  dt.setData(DRAG_MIME, JSON.stringify(currentDrag));
  const names = dev ? itemsOf(dev, refs).map(itemName) : [];
  const tagNames = refs.flatMap((r) =>
    r.kind === 'tag' && dev
      ? [findTagTable(dev, r.tableId)?.tags.find((x) => x.id === r.id)?.name ?? '']
      : [],
  );
  dt.setData('text/plain', [...names, ...tagNames].filter(Boolean).join('\n'));
  dt.effectAllowed = 'copyMove';
}
/** Il trascinamento in corso, per chi deve accettarlo o rifiutarlo durante `dragover`. */
export const peekDrag = (): DragData | null => currentDrag;
export const endDrag = (): void => {
  currentDrag = null;
};

/** Cosa succede se si rilascia il trascinamento corrente sul nodo: 'move', 'copy' o null (vietato). */
export function dropVerdict(doc: OpenDoc | null, nodeId: string): 'move' | 'copy' | null {
  const drag = currentDrag;
  if (!drag) return null;
  const target = parseNodeId(nodeId);
  if (drag.refs.length > 0 && drag.refs.every((r) => r.kind === 'tag')) {
    return target.kind === 'tagTable' &&
      target.dev === drag.deviceId &&
      drag.refs.some((r) => r.kind === 'tag' && r.tableId !== target.id)
      ? 'move'
      : null;
  }
  const c = containerOf(doc, nodeId);
  if (!c || !c.isContainer) return null;
  if (!drag.refs.some((r) => areaOfRef(r) === c.area)) return null;
  return c.dev === drag.deviceId ? 'move' : 'copy';
}

/** Rilascio sul nodo (un solo `edit`): sposta di gruppo, copia in un altro PLC o sposta i tag. */
export function dropOn(store: StoreApi<AppState>, nodeId: string): void {
  const drag = currentDrag;
  const doc = store.getState().doc;
  const verdict = dropVerdict(doc, nodeId);
  currentDrag = null;
  if (!drag || !verdict) return;
  const target = parseNodeId(nodeId);
  if (target.kind === 'tagTable') {
    store.getState().edit('history.moveTags', (p) => {
      const dev = findDevice(p, target.dev);
      if (dev) moveTags(dev, drag.refs, target.id);
    });
    return;
  }
  const c = containerOf(doc, nodeId)!;
  const refs = drag.refs.filter((r) => areaOfRef(r) === c.area);
  if (verdict === 'move') {
    store.getState().edit('history.move', (p) => {
      const dev = findDevice(p, c.dev);
      if (dev) moveToGroup(dev, refs, c.group);
    });
    return;
  }
  const src = deviceOf(doc, drag.deviceId);
  if (src) {
    pasteItems(store, c, { kind: 'objects', deviceId: drag.deviceId, items: itemsOf(src, refs) });
  }
}
