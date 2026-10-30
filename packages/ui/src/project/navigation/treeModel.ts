import { findCpu } from '@baaportal/catalog';
import type { Block, ObjectRef, PlcDevice } from '@baaportal/project';
import type { IconName } from '../../icons';
import { contextHashOf, hashOf } from '../compile/compileActions';
import type { CompareState, OnlineCompare } from '../../online/compare';
import type { OpenDoc } from '../../state/store';
import { systemBlocksOf, type SystemBlockUse } from './systemBlocks';
import { ids, type PlcFolder, type TreeArea } from './treeIds';

export interface TreeNode {
  id: string;
  labelKey: string;
  /** Etichetta già pronta (nome del progetto, di un oggetto…); se presente prevale su `labelKey`. */
  label?: string;
  icon: IconName;
  enabled: boolean;
  children: TreeNode[];
  ref?: ObjectRef;
  /** Stato del confronto con la CPU (solo online). */
  compare?: CompareState;
  /** Blocco presente solo nella CPU: sola lettura, senza menu, trascinamento o rinomina. */
  onlineOnly?: boolean;
  /** Blocco di sistema richiamato (nodo in sola lettura). */
  system?: SystemBlockUse;
  /** Cartelle e gruppi dove si può rilasciare un oggetto (Task 9). */
  dropArea?: TreeArea;
}

const leaf = (id: string, labelKey: string, icon: IconName, enabled = true): TreeNode => ({
  id,
  labelKey,
  icon,
  enabled,
  children: [],
});

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

const parentPath = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const lastSegment = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** Tutti i percorsi di gruppo noti, compresi gli antenati ('A/B' implica 'A'). */
function allGroupPaths(declared: string[], used: string[]): Set<string> {
  const out = new Set<string>();
  for (const path of [...declared, ...used]) {
    let p = path;
    while (p !== '') {
      out.add(p);
      p = parentPath(p);
    }
  }
  return out;
}

const blockTag = (b: Block) => `${b.kind === 'IDB' ? 'DB' : b.kind}${b.number}`;
const BLOCK_ICON: Record<Block['kind'], IconName> = {
  OB: 'objOb',
  FB: 'objFb',
  FC: 'objFc',
  DB: 'objDb',
  IDB: 'objIdb',
};

/** Gruppi (prima) e oggetti (poi) del gruppo `path`, ciascuno ordinato per nome. */
function areaChildren(
  dev: PlcDevice,
  area: TreeArea,
  path: string,
  groups: Set<string>,
  objects: { name: string; group: string; node: TreeNode }[],
): TreeNode[] {
  const subs = [...groups].filter((g) => parentPath(g) === path).sort(byName);
  const groupNodes = subs.map((g): TreeNode => ({
    id: ids.group(dev.id, area, g),
    labelKey: '',
    label: lastSegment(g),
    icon: 'objGroup',
    enabled: true,
    dropArea: area,
    children: areaChildren(dev, area, g, groups, objects),
  }));
  const own = objects
    .filter((o) => o.group === path)
    .sort((a, b) => byName(a.name, b.name))
    .map((o) => o.node);
  return [...groupNodes, ...own];
}

function folderNode(
  dev: PlcDevice,
  f: PlcFolder,
  labelKey: string,
  icon: IconName,
  enabled: boolean,
  children: TreeNode[] = [],
  dropArea?: TreeArea,
): TreeNode {
  return {
    id: ids.folder(dev.id, f),
    labelKey,
    icon,
    enabled,
    children,
    ...(dropArea ? { dropArea } : {}),
  };
}

/**
 * Stato di confronto di ogni blocco del PLC. Un blocco cambiato dopo il confronto (impronta
 * diversa) è «da compilare» finché non si ricompila e si confronta di nuovo.
 */
function compareStates(
  dev: PlcDevice,
  compare: OnlineCompare | undefined,
): Map<string, CompareState> {
  const out = new Map<string, CompareState>();
  if (!compare || compare.deviceId !== dev.id) return out;
  const context = contextHashOf(dev);
  const known = new Map(dev.blocks.map((b) => [b.id, b]));
  for (const r of compare.rows) {
    if (!r.blockId) continue;
    const b = known.get(r.blockId);
    if (!b) continue;
    out.set(b.id, compare.hashes[b.id] === hashOf(b, context) ? r.state : 'notCompiled');
  }
  return out;
}

function deviceNode(dev: PlcDevice, compare?: OnlineCompare): TreeNode {
  const states = compareStates(dev, compare);
  const onlineOnly =
    compare && compare.deviceId === dev.id ? compare.rows.filter((r) => !r.blockId) : [];
  const blockObjects = dev.blocks.map((b) => ({
    name: b.name,
    group: b.group,
    node: {
      id: ids.block(dev.id, b.id),
      labelKey: '',
      label: `${b.name} [${blockTag(b)}]`,
      icon: BLOCK_ICON[b.kind],
      enabled: true,
      children: [],
      ref: { kind: 'block', deviceId: dev.id, id: b.id },
      ...(states.has(b.id) ? { compare: states.get(b.id)! } : {}),
    } satisfies TreeNode,
  }));
  const tableObjects = dev.tagTables.map((t) => ({
    name: t.name,
    group: t.group,
    node: {
      id: ids.tagTable(dev.id, t.id),
      labelKey: '',
      label: `${t.name} [${t.tags.length}]`,
      icon: 'objTagTable',
      enabled: true,
      children: [],
      ref: { kind: 'tagTable', deviceId: dev.id, id: t.id },
    } satisfies TreeNode,
  }));
  const udtObjects = dev.udts.map((u) => ({
    name: u.name,
    group: u.group,
    node: {
      id: ids.udt(dev.id, u.id),
      labelKey: '',
      label: u.name,
      icon: 'objUdt',
      enabled: true,
      children: [],
      ref: { kind: 'udt', deviceId: dev.id, id: u.id },
    } satisfies TreeNode,
  }));
  const sourceNodes = [...dev.sources]
    .sort((a, b) => byName(a.name, b.name))
    .map((x): TreeNode => ({
      id: ids.source(dev.id, x.id),
      labelKey: '',
      label: x.name,
      icon: 'objSource',
      enabled: true,
      children: [],
      ref: { kind: 'source', deviceId: dev.id, id: x.id },
    }));
  const watchNodes = [...dev.watchTables]
    .sort((a, b) => byName(a.name, b.name))
    .map((w): TreeNode => ({
      id: ids.watchTable(dev.id, w.id),
      labelKey: '',
      label: `${w.name} [${w.rows.length}]`,
      icon: 'objWatch',
      enabled: true,
      children: [],
      ref: { kind: 'watchTable', deviceId: dev.id, id: w.id },
    }));
  const hmiNodes = [...(dev.hmi?.screens ?? [])]
    .sort((a, b) => byName(a.name, b.name))
    .map((x): TreeNode => ({
      id: ids.hmiScreen(dev.id, x.id),
      labelKey: '',
      label: x.name,
      icon: 'objHmi',
      enabled: true,
      children: [],
      ref: { kind: 'hmiScreen', deviceId: dev.id, id: x.id },
    }));
  const systemNodes = systemBlocksOf(dev).map((b): TreeNode => ({
    id: ids.sysBlock(dev.id, `${b.kind}${b.number}`),
    labelKey: '',
    label: `${b.name} [${b.kind}${b.number}]`,
    icon: b.kind === 'SFB' ? 'objFb' : 'objFc',
    enabled: true,
    children: [],
    system: b,
  }));
  const groupsOf = (area: TreeArea, objs: { group: string }[]) =>
    allGroupPaths(
      dev.groups[area],
      objs.map((o) => o.group),
    );
  const blocks = areaChildren(dev, 'blocks', '', groupsOf('blocks', blockObjects), blockObjects);
  const tables = areaChildren(dev, 'tags', '', groupsOf('tags', tableObjects), tableObjects);
  const types = areaChildren(dev, 'types', '', groupsOf('types', udtObjects), udtObjects);

  const cpuName = findCpu(dev.cpu.typeId)?.name ?? dev.cpu.typeId;
  return {
    id: ids.plc(dev.id),
    labelKey: '',
    label: `${dev.name} [${cpuName}]`,
    icon: 'objCpu',
    enabled: true,
    ref: { kind: 'device', deviceId: dev.id },
    children: [
      folderNode(dev, 'device-config', 'tree.plc.deviceConfig', 'treeDeviceConfig', true),
      folderNode(dev, 'online-diag', 'tree.plc.onlineDiag', 'treeOnlineDiag', true),
      folderNode(
        dev,
        'blocks',
        'tree.plc.blocks',
        'treeBlocks',
        true,
        [
          leaf(ids.folder(dev.id, 'blocks-add'), 'tree.plc.addBlock', 'treeAdd'),
          ...blocks,
          {
            ...leaf(ids.folder(dev.id, 'system-blocks'), 'tree.plc.systemBlocks', 'objGroup'),
            children: systemNodes,
          },
          ...(onlineOnly.length > 0
            ? [
                {
                  ...leaf(ids.folder(dev.id, 'online-only'), 'tree.plc.onlineOnly', 'objGroup'),
                  children: onlineOnly.map((r): TreeNode => ({
                    id: ids.onlineBlock(dev.id, `${r.type}${r.number}`),
                    labelKey: '',
                    label: `${r.type}${r.number}`,
                    icon: BLOCK_ICON[r.type === 'DB' ? 'DB' : (r.type as 'OB' | 'FB' | 'FC')],
                    enabled: true,
                    children: [],
                    compare: r.state,
                    onlineOnly: true,
                  })),
                } satisfies TreeNode,
              ]
            : []),
        ],
        'blocks',
      ),
      folderNode(dev, 'sources', 'tree.plc.sources', 'treeSources', true, [
        leaf(ids.folder(dev.id, 'sources-add'), 'tree.plc.addSource', 'treeAdd'),
        ...sourceNodes,
      ]),
      folderNode(
        dev,
        'tags',
        'tree.plc.tags',
        'treeTags',
        true,
        [
          leaf(ids.folder(dev.id, 'tags-all'), 'tree.plc.allTags', 'treeTags'),
          leaf(ids.folder(dev.id, 'tags-add'), 'tree.plc.addTagTable', 'treeAdd'),
          ...tables,
        ],
        'tags',
      ),
      folderNode(
        dev,
        'types',
        'tree.plc.types',
        'treeTypes',
        true,
        [leaf(ids.folder(dev.id, 'types-add'), 'tree.plc.addUdt', 'treeAdd'), ...types],
        'types',
      ),
      folderNode(dev, 'watch', 'tree.plc.watch', 'treeWatch', true, [
        leaf(ids.folder(dev.id, 'watch-add'), 'tree.plc.addWatchTable', 'treeAdd'),
        ...watchNodes,
      ]),
      folderNode(dev, 'hmi', 'tree.plc.hmi', 'treeHmi', true, [
        leaf(ids.folder(dev.id, 'hmi-add'), 'tree.plc.addHmiScreen', 'treeAdd'),
        ...hmiNodes,
      ]),
      folderNode(dev, 'backup', 'tree.plc.backup', 'treeBackup', false),
      folderNode(dev, 'prog-info', 'tree.plc.progInfo', 'treeProgInfo', true, [
        leaf(ids.folder(dev.id, 'prog-xref'), 'commands.tools.crossReferences', 'treeProgInfo'),
        leaf(ids.folder(dev.id, 'prog-calls'), 'commands.tools.callStructure', 'treeProgInfo'),
        leaf(
          ids.folder(dev.id, 'prog-assignment'),
          'commands.tools.assignmentList',
          'treeProgInfo',
        ),
        leaf(ids.folder(dev.id, 'prog-resources'), 'commands.tools.resources', 'treeProgInfo'),
      ]),
    ],
  };
}

export function buildTree(
  doc: OpenDoc | null,
  compare?: OnlineCompare,
): {
  project: TreeNode | null;
  onlineAccess: TreeNode;
} {
  const onlineAccess = leaf('online-access', 'tree.onlineAccess', 'treeOnlineAccess');
  if (!doc) return { project: null, onlineAccess };
  return {
    project: {
      id: 'project',
      labelKey: 'tree.project',
      label: doc.project.meta.name,
      icon: 'treeProject',
      enabled: true,
      children: [
        leaf('add-device', 'tree.addDevice', 'treeAddDevice'),
        leaf('devices-networks', 'tree.devicesNetworks', 'treeDevicesNetworks'),
        ...doc.project.devices.map((d) => deviceNode(d, compare)),
        leaf('common-data', 'tree.commonData', 'treeCommonData'),
        leaf('doc-settings', 'tree.docSettings', 'treeDocSettings'),
        leaf('languages', 'tree.languages', 'treeLanguages'),
      ],
    },
    onlineAccess,
  };
}
