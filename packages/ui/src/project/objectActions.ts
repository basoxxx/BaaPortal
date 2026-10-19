import type { CpuType } from '@baaportal/catalog';
import {
  createNamer,
  findBlock,
  findTagTable,
  findUdt,
  nextFreeNumber,
  symbolNames,
  type Block,
  type Member,
  type NewId,
  type ObjectRef,
  type PlcDevice,
  type TagTable,
  type Udt,
} from '@baaportal/project';
import { sameName, validateS7Name } from '@baaportal/s7-types';
import type { ClipboardItem, ClipboardPayload } from '../services/clipboard';
import { MAX_UDT } from './navigation/addActions';
import type { TreeArea } from './navigation/treeIds';

type ObjectsPayload = Extract<ClipboardPayload, { kind: 'objects' }>;

/** Numeri validi per gli OB creati dall'utente (quelli sotto il 123 sono eventi di sistema). */
const FIRST_USER_OB = 123;
const MAX_OB = 32767;
const FALLBACK_MAX = 65535;

export const areaOfItem = (i: ClipboardItem): TreeArea =>
  i.type === 'block' ? 'blocks' : i.type === 'udt' ? 'types' : 'tags';

export const areaOfRef = (r: ObjectRef): TreeArea | null =>
  r.kind === 'block'
    ? 'blocks'
    : r.kind === 'udt'
      ? 'types'
      : r.kind === 'tagTable'
        ? 'tags'
        : null;

const cloneMembers = (list: Member[], newId: NewId): Member[] =>
  list.map((m) => ({
    ...structuredClone(m),
    id: newId(),
    ...(m.members ? { members: cloneMembers(m.members, newId) } : {}),
  }));

function cloneBlock(b: Block, newId: NewId): Block {
  const copy = structuredClone(b);
  copy.id = newId();
  if (copy.kind === 'DB') copy.members = cloneMembers(copy.members, newId);
  else if (copy.kind !== 'IDB') {
    const i = copy.interface;
    for (const k of ['input', 'output', 'inOut', 'static', 'temp'] as const) {
      i[k] = cloneMembers(i[k], newId);
    }
    copy.networks = copy.networks.map((n) => ({ ...n, id: newId() }));
  }
  return copy;
}

function numberTaken(d: PlcDevice, kind: Block['kind'], n: number): boolean {
  // DB e DB di istanza hanno un'unica numerazione.
  const family = (k: string) => (k === 'IDB' ? 'DB' : k);
  return d.blocks.some((b) => family(b.kind) === family(kind) && b.number === n);
}

function blockNumber(d: PlcDevice, b: Block, cpu: CpuType | undefined): number | null {
  if (!numberTaken(d, b.kind, b.number)) return b.number;
  if (b.kind === 'OB') {
    for (let n = FIRST_USER_OB; n <= MAX_OB; n++) if (!numberTaken(d, 'OB', n)) return n;
    return null;
  }
  const limits = cpu?.limits;
  if (b.kind === 'FB') return nextFreeNumber(d, 'FB', limits?.maxFb ?? FALLBACK_MAX);
  if (b.kind === 'FC') return nextFreeNumber(d, 'FC', limits?.maxFc ?? FALLBACK_MAX);
  return nextFreeNumber(d, 'DB', limits?.maxDb ?? FALLBACK_MAX);
}

type Namer = (base: string) => string;

function pasteTable(
  src: TagTable,
  group: string,
  names: { tables: Namer; symbols: Namer },
  newId: NewId,
): TagTable {
  const table = structuredClone(src);
  table.id = newId();
  table.group = group;
  table.name = names.tables(src.name);
  // I nomi di tag e costanti sono simboli del PLC: quelli già presenti si rinominano.
  for (const item of [...table.tags, ...table.constants]) {
    item.id = newId();
    item.name = names.symbols(item.name);
  }
  return table;
}

/**
 * Incolla nel gruppo `group` del PLC `target` (da usare dentro `edit`): clona gli oggetti con id nuovi.
 * Gli oggetti per cui non c'è un numero libero sono saltati; restituisce i riferimenti di quelli creati.
 * `copiedFrom`, se dato, riceve per ognuno l'indice dell'elemento di partenza in `payload.items`.
 */
export function pasteObjects(
  target: PlcDevice,
  payload: ObjectsPayload,
  group: string,
  cpu: CpuType | undefined,
  newId: NewId,
  copiedFrom?: number[],
): ObjectRef[] {
  const out: ObjectRef[] = [];
  const renamedFbs = new Map<string, string>(); // nome originale (minuscolo) → nome della copia
  // Un solo generatore di nomi per tutto l'incolla: i nomi dati restano presi per i successivi.
  const names = {
    symbols: createNamer(symbolNames(target)),
    tables: createNamer(target.tagTables.map((t) => t.name)),
  };
  for (const [index, item] of payload.items.entries()) {
    const before = out.length;
    if (item.type === 'block') {
      const number = blockNumber(target, item.block, cpu);
      if (number === null) continue;
      const copy = cloneBlock(item.block, newId);
      copy.number = number;
      copy.group = group;
      copy.name = names.symbols(item.block.name);
      if (copy.kind === 'FB') renamedFbs.set(item.block.name.toLowerCase(), copy.name);
      // Un DB di istanza incollato insieme al suo FB segue la copia, non l'originale.
      if (copy.kind === 'IDB') {
        copy.instanceOf = renamedFbs.get(copy.instanceOf.toLowerCase()) ?? copy.instanceOf;
      }
      target.blocks.push(copy);
      out.push({ kind: 'block', deviceId: target.id, id: copy.id });
    } else if (item.type === 'udt') {
      const taken = target.udts.some((u) => u.number === item.udt.number);
      const n = taken ? nextFreeNumber(target, 'UDT', MAX_UDT) : item.udt.number;
      if (n === null) continue;
      const copy: Udt = structuredClone(item.udt);
      copy.id = newId();
      copy.number = n;
      copy.group = group;
      copy.name = names.symbols(item.udt.name);
      copy.members = cloneMembers(copy.members, newId);
      target.udts.push(copy);
      out.push({ kind: 'udt', deviceId: target.id, id: copy.id });
    } else {
      const table = pasteTable(item.table, group, names, newId);
      target.tagTables.push(table);
      out.push({ kind: 'tagTable', deviceId: target.id, id: table.id });
    }
    if (out.length > before) copiedFrom?.push(index);
  }
  return out;
}

/** La Tabella delle variabili standard è la prima del dispositivo. */
export const isStandardTable = (d: PlcDevice, id: string): boolean => d.tagTables[0]?.id === id;

/** Elimina blocchi, UDT e tabelle; la tabella standard non si elimina mai. */
export function deleteObjects(device: PlcDevice, refs: ObjectRef[]): void {
  const gone = (kind: ObjectRef['kind']) =>
    new Set(refs.flatMap((r) => (r.kind === kind && 'id' in r ? [r.id] : [])));
  const blocks = gone('block');
  const udts = gone('udt');
  const tables = gone('tagTable');
  device.blocks = device.blocks.filter((b) => !blocks.has(b.id));
  device.udts = device.udts.filter((u) => !udts.has(u.id));
  device.tagTables = device.tagTables.filter((t, i) => i === 0 || !tables.has(t.id));
}

export function moveToGroup(device: PlcDevice, refs: ObjectRef[], group: string): void {
  for (const r of refs) {
    const o =
      r.kind === 'block'
        ? findBlock(device, r.id)
        : r.kind === 'udt'
          ? findUdt(device, r.id)
          : r.kind === 'tagTable'
            ? findTagTable(device, r.id)
            : undefined;
    if (o) o.group = group;
  }
}

/** Sposta i tag (nell'ordine dato) in coda alla tabella `toTableId`. */
export function moveTags(device: PlcDevice, tagRefs: ObjectRef[], toTableId: string): void {
  const to = findTagTable(device, toTableId);
  if (!to) return;
  for (const r of tagRefs) {
    if (r.kind !== 'tag' || r.tableId === toTableId) continue;
    const from = findTagTable(device, r.tableId);
    const i = from?.tags.findIndex((t) => t.id === r.id) ?? -1;
    if (from && i >= 0) to.tags.push(...from.tags.splice(i, 1));
  }
}

/** Verifica il nuovo nome di un oggetto. Blocchi e UDT condividono lo spazio dei simboli; le tabelle hanno il proprio. */
export function canRename(
  device: PlcDevice,
  ref: ObjectRef,
  name: string,
): 'INVALID' | 'DUPLICATE' | null {
  if (!validateS7Name(name).ok) return 'INVALID';
  let others: string[] = [];
  if (ref.kind === 'block' || ref.kind === 'udt') {
    const selfName = (ref.kind === 'block' ? findBlock(device, ref.id) : findUdt(device, ref.id))
      ?.name;
    // Il proprio nome non è un duplicato (si può cambiare solo la capitalizzazione).
    others = symbolNames(device);
    const i = selfName === undefined ? -1 : others.indexOf(selfName);
    if (i >= 0) others.splice(i, 1);
  } else if (ref.kind === 'tagTable') {
    others = device.tagTables.filter((t) => t.id !== ref.id).map((t) => t.name);
  }
  return others.some((o) => sameName(o, name)) ? 'DUPLICATE' : null;
}

// ---- gruppi -------------------------------------------------------------------------------

const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const lastOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const inside = (group: string, path: string) => group === path || group.startsWith(`${path}/`);

const objectsOf = (d: PlcDevice, area: TreeArea): { group: string }[] =>
  area === 'blocks' ? d.blocks : area === 'types' ? d.udts : d.tagTables;

/** Tutti i percorsi di gruppo dell'area, compresi gli antenati. */
export function groupPaths(device: PlcDevice, area: TreeArea): Set<string> {
  const out = new Set<string>();
  for (const path of [...device.groups[area], ...objectsOf(device, area).map((o) => o.group)]) {
    for (let p = path; p !== ''; p = parentOf(p)) out.add(p);
  }
  return out;
}

export function addGroup(device: PlcDevice, area: TreeArea, parent: string, name: string): string {
  const path = parent === '' ? name : `${parent}/${name}`;
  device.groups[area].push(path);
  return path;
}

export function canRenameGroup(
  device: PlcDevice,
  area: TreeArea,
  path: string,
  name: string,
): 'INVALID' | 'DUPLICATE' | null {
  // '/' separa i livelli del percorso.
  if (!validateS7Name(name).ok || name.includes('/')) return 'INVALID';
  const siblings = [...groupPaths(device, area)].filter(
    (g) => g !== path && parentOf(g) === parentOf(path),
  );
  return siblings.some((g) => sameName(lastOf(g), name)) ? 'DUPLICATE' : null;
}

/** Rinomina il gruppo e aggiorna oggetti e sottogruppi che lo attraversano. */
export function renameGroup(device: PlcDevice, area: TreeArea, path: string, name: string): void {
  const renamed = parentOf(path) === '' ? name : `${parentOf(path)}/${name}`;
  const rebase = (g: string) => (inside(g, path) ? renamed + g.slice(path.length) : g);
  device.groups[area] = device.groups[area].map(rebase);
  for (const o of objectsOf(device, area)) o.group = rebase(o.group);
}

/** Elimina il gruppo con tutto il suo contenuto. */
export function deleteGroup(device: PlcDevice, area: TreeArea, path: string): void {
  device.groups[area] = device.groups[area].filter((g) => !inside(g, path));
  if (area === 'blocks') device.blocks = device.blocks.filter((b) => !inside(b.group, path));
  else if (area === 'types') device.udts = device.udts.filter((u) => !inside(u.group, path));
  else {
    // La tabella standard non si elimina neanche con il suo gruppo: torna alla radice.
    const std = device.tagTables[0];
    if (std && inside(std.group, path)) std.group = '';
    device.tagTables = device.tagTables.filter((t, i) => i === 0 || !inside(t.group, path));
  }
}
