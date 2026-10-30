import type { ObjectRef } from '@baaportal/project';
import type { AppState } from '../../state/store';

export type PlcFolder =
  | 'device-config'
  | 'online-diag'
  | 'blocks'
  | 'blocks-add'
  | 'system-blocks'
  | 'online-only'
  | 'sources'
  | 'sources-add'
  | 'tags'
  | 'tags-all'
  | 'tags-add'
  | 'types'
  | 'types-add'
  | 'watch'
  | 'watch-add'
  | 'hmi'
  | 'hmi-add'
  | 'backup'
  | 'prog-info'
  | 'prog-xref'
  | 'prog-calls'
  | 'prog-assignment'
  | 'prog-resources';
export type TreeArea = 'blocks' | 'tags' | 'types';

const FOLDERS: ReadonlySet<string> = new Set<PlcFolder>([
  'device-config',
  'online-diag',
  'blocks',
  'blocks-add',
  'system-blocks',
  'online-only',
  'sources',
  'sources-add',
  'tags',
  'tags-all',
  'tags-add',
  'types',
  'types-add',
  'watch',
  'watch-add',
  'hmi',
  'hmi-add',
  'backup',
  'prog-info',
  'prog-xref',
  'prog-calls',
  'prog-assignment',
  'prog-resources',
]);
const AREAS: ReadonlySet<string> = new Set<TreeArea>(['blocks', 'tags', 'types']);

// Gli id di dispositivi e oggetti sono UUID: non contengono ':'. I percorsi dei gruppi, scelti
// dall'utente, sì (e anche '/'): per questo sono codificati.
export const ids = {
  plc: (dev: string) => `plc:${dev}`,
  folder: (dev: string, f: PlcFolder) => `plc:${dev}:${f}`,
  group: (dev: string, area: TreeArea, path: string) =>
    `plc:${dev}:${area}:group:${encodeURIComponent(path)}`,
  block: (dev: string, id: string) => `plc:${dev}:block:${id}`,
  tagTable: (dev: string, id: string) => `plc:${dev}:tagTable:${id}`,
  udt: (dev: string, id: string) => `plc:${dev}:udt:${id}`,
  source: (dev: string, id: string) => `plc:${dev}:source:${id}`,
  watchTable: (dev: string, id: string) => `plc:${dev}:watchTable:${id}`,
  hmiScreen: (dev: string, id: string) => `plc:${dev}:hmiScreen:${id}`,
  /** Blocco di sistema richiamato; `tag` è tipo e numero (SFB4). */
  sysBlock: (dev: string, tag: string) => `plc:${dev}:sysBlock:${tag}`,
  /** Blocco presente solo nella CPU (confronto online); `tag` è tipo e numero (DB7). */
  onlineBlock: (dev: string, tag: string) => `plc:${dev}:onlineBlock:${tag}`,
};

export type ParsedNodeId =
  | { kind: 'static'; id: string }
  | { kind: 'plc'; dev: string }
  | { kind: 'folder'; dev: string; folder: PlcFolder }
  | { kind: 'group'; dev: string; area: TreeArea; path: string }
  | {
      kind: 'block' | 'tagTable' | 'udt' | 'source' | 'watchTable' | 'hmiScreen' | 'sysBlock';
      dev: string;
      id: string;
    };

export function parseNodeId(id: string): ParsedNodeId {
  const parts = id.split(':');
  const dev = parts[1];
  if (parts[0] !== 'plc' || !dev) return { kind: 'static', id };
  const [, , a, b, c] = parts;
  if (parts.length === 2) return { kind: 'plc', dev };
  if (parts.length === 3 && a && FOLDERS.has(a)) {
    return { kind: 'folder', dev, folder: a as PlcFolder };
  }
  if (parts.length === 5 && a && AREAS.has(a) && b === 'group' && c !== undefined) {
    try {
      return { kind: 'group', dev, area: a as TreeArea, path: decodeURIComponent(c) };
    } catch {
      return { kind: 'static', id };
    }
  }
  if (
    parts.length === 4 &&
    b &&
    (a === 'block' ||
      a === 'tagTable' ||
      a === 'udt' ||
      a === 'source' ||
      a === 'watchTable' ||
      a === 'hmiScreen' ||
      a === 'sysBlock')
  ) {
    return { kind: a, dev, id: b };
  }
  return { kind: 'static', id };
}

/** Nodo che rappresenta l'oggetto: tag e costanti stanno nella loro tabella, i membri nel proprietario. */
export function nodeIdForRef(ref: ObjectRef): string | null {
  switch (ref.kind) {
    case 'device':
      return ids.plc(ref.deviceId);
    case 'block':
      return ids.block(ref.deviceId, ref.id);
    case 'udt':
      return ids.udt(ref.deviceId, ref.id);
    case 'tagTable':
      return ids.tagTable(ref.deviceId, ref.id);
    case 'tag':
    case 'constant':
      return ids.tagTable(ref.deviceId, ref.tableId);
    case 'source':
      return ids.source(ref.deviceId, ref.id);
    case 'watchTable':
      return ids.watchTable(ref.deviceId, ref.id);
    case 'hmiScreen':
      return ids.hmiScreen(ref.deviceId, ref.id);
    case 'member':
      return ref.ownerKind === 'udt'
        ? ids.udt(ref.deviceId, ref.ownerId)
        : ids.block(ref.deviceId, ref.ownerId);
  }
}

/** PLC su cui agiscono "Nuovo blocco": quello della selezione, altrimenti il primo. */
export function targetPlcId(s: Pick<AppState, 'doc' | 'selection'>): string | null {
  const devices = s.doc?.project.devices ?? [];
  const p = s.selection ? parseNodeId(s.selection) : null;
  if (p && p.kind !== 'static' && devices.some((d) => d.id === p.dev)) return p.dev;
  return devices[0]?.id ?? null;
}
