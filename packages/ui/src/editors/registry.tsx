import type { FC } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { findDevice } from '@baaportal/project';
import type { IconName } from '../icons';
import { useAppStore } from '../state/AppContext';
import { BlockEditor } from './block/BlockEditor';
import { CompareView } from './compare/CompareView';
import { OnlineDiagView } from './diag/OnlineDiagView';
import { DbEditor } from './db/DbEditor';
import { DeviceView } from './hw/DeviceView';
import { StationView } from './hw/StationView';
import { NetworkView } from './net/NetworkView';
import { SourceEditor } from './source/SourceEditor';
import { WatchTableView } from './watch/WatchTableView';
import { HmiScreenEditor } from './hmi/HmiScreenEditor';
import { CallStructureView } from './xref/CallStructureView';
import { AssignmentView } from './xref/AssignmentView';
import { ResourcesView } from './xref/ResourcesView';
import { CrossRefView } from './xref/CrossRefView';
import { UdtEditor } from './udt/UdtEditor';
import { AllTagsEditor } from './tags/AllTagsEditor';
import { TagTableEditor } from './tags/TagTableEditor';
import type { OpenDoc } from '../state/store';
import type { EditorKind, EditorRef } from '../state/workArea';

export interface EditorDef {
  kind: EditorKind;
  icon(ref: EditorRef, doc: OpenDoc): IconName;
  title(ref: EditorRef, doc: OpenDoc, t: TFunction): string;
  exists(ref: EditorRef, doc: OpenDoc): boolean;
  Component: FC<{ editor: EditorRef }>;
}

const BLOCK_ICON = {
  OB: 'objOb',
  FB: 'objFb',
  FC: 'objFc',
  DB: 'objDb',
  IDB: 'objIdb',
} as const satisfies Record<string, IconName>;

const device = (ref: EditorRef, doc: OpenDoc) => findDevice(doc.project, ref.deviceId);
const station = (ref: EditorRef, doc: OpenDoc) =>
  ref.objectId
    ? device(ref, doc)?.hardware?.stations?.find((s) => s.id === ref.objectId)
    : undefined;
const block = (ref: EditorRef, doc: OpenDoc) =>
  device(ref, doc)?.blocks.find((b) => b.id === ref.objectId);

/** Il DB è un blocco: l'editor sceglie la vista in base al tipo. */
function BlockOrDbEditor({ editor }: { editor: EditorRef }) {
  const kind = useAppStore((s) => {
    const dev = s.doc ? findDevice(s.doc.project, editor.deviceId) : undefined;
    return dev?.blocks.find((b) => b.id === editor.objectId)?.kind;
  });
  if (!kind) return null;
  return kind === 'DB' || kind === 'IDB' ? (
    <DbEditor editor={editor} />
  ) : (
    <BlockEditor editor={editor} />
  );
}

export const EDITORS: Record<EditorKind, EditorDef> = {
  block: {
    kind: 'block',
    icon: (r, d) => BLOCK_ICON[block(r, d)?.kind ?? 'FB'],
    title: (r, d) => {
      const b = block(r, d);
      return b ? `${b.name} [${b.kind === 'IDB' ? 'DB' : b.kind}${b.number}]` : '';
    },
    exists: (r, d) => block(r, d) !== undefined,
    Component: BlockOrDbEditor,
  },
  udt: {
    kind: 'udt',
    icon: () => 'objUdt',
    title: (r, d) => device(r, d)?.udts.find((u) => u.id === r.objectId)?.name ?? '',
    exists: (r, d) => !!device(r, d)?.udts.some((u) => u.id === r.objectId),
    Component: UdtEditor,
  },
  source: {
    kind: 'source',
    icon: () => 'objSource',
    title: (r, d) => device(r, d)?.sources.find((x) => x.id === r.objectId)?.name ?? '',
    exists: (r, d) => !!device(r, d)?.sources.some((x) => x.id === r.objectId),
    Component: SourceEditor,
  },
  watchTable: {
    kind: 'watchTable',
    icon: () => 'objWatch',
    title: (r, d) => device(r, d)?.watchTables.find((x) => x.id === r.objectId)?.name ?? '',
    exists: (r, d) => !!device(r, d)?.watchTables.some((x) => x.id === r.objectId),
    Component: WatchTableView,
  },
  hmiScreen: {
    kind: 'hmiScreen',
    icon: () => 'objHmi',
    title: (r, d) => device(r, d)?.hmi?.screens.find((x) => x.id === r.objectId)?.name ?? '',
    exists: (r, d) => !!device(r, d)?.hmi?.screens.some((x) => x.id === r.objectId),
    Component: HmiScreenEditor,
  },
  tagTable: {
    kind: 'tagTable',
    icon: () => 'objTagTable',
    title: (r, d) => device(r, d)?.tagTables.find((x) => x.id === r.objectId)?.name ?? '',
    exists: (r, d) => !!device(r, d)?.tagTables.some((x) => x.id === r.objectId),
    Component: TagTableEditor,
  },
  compare: {
    kind: 'compare',
    icon: (r, d) => BLOCK_ICON[block(r, d)?.kind ?? 'FB'],
    title: (r, d, t) => {
      const b = block(r, d);
      return b ? t('compareView.title', { name: b.name }) : '';
    },
    exists: (r, d) => block(r, d) !== undefined,
    Component: CompareView,
  },
  onlineDiag: {
    kind: 'onlineDiag',
    icon: () => 'treeOnlineDiag',
    title: (_r, _d, t) => t('onlineDiag.title'),
    exists: (r, d) => device(r, d) !== undefined,
    Component: OnlineDiagView,
  },
  crossRef: {
    kind: 'crossRef',
    icon: () => 'treeProgInfo',
    title: (_r, _d, t) => t('xref.title'),
    exists: (r, d) => device(r, d) !== undefined,
    Component: CrossRefView,
  },
  callStructure: {
    kind: 'callStructure',
    icon: () => 'treeProgInfo',
    title: (_r, _d, t) => t('callTree.title'),
    exists: (r, d) => device(r, d) !== undefined,
    Component: CallStructureView,
  },
  assignment: {
    kind: 'assignment',
    icon: () => 'treeProgInfo',
    title: (_r, _d, t) => t('assign.title'),
    exists: (r, d) => device(r, d) !== undefined,
    Component: AssignmentView,
  },
  resources: {
    kind: 'resources',
    icon: () => 'treeProgInfo',
    title: (_r, _d, t) => t('resources.title'),
    exists: (r, d) => device(r, d) !== undefined,
    Component: ResourcesView,
  },
  deviceView: {
    kind: 'deviceView',
    icon: () => 'treeDeviceConfig',
    // objectId vuoto: il rack della CPU; altrimenti la stazione ET 200 con quell'id.
    title: (r, d, t) => {
      const st = station(r, d);
      return st ? `${t('hw.title')}: ${st.name}` : t('hw.title');
    },
    exists: (r, d) => device(r, d) !== undefined && (r.objectId === '' || !!station(r, d)),
    Component: ({ editor }) =>
      editor.objectId ? <StationView editor={editor} /> : <DeviceView editor={editor} />,
  },
  networkView: {
    kind: 'networkView',
    icon: () => 'treeDevicesNetworks',
    title: (_r, _d, t) => t('net.title'),
    exists: () => true,
    Component: NetworkView,
  },
  allTags: {
    kind: 'allTags',
    icon: () => 'treeTags',
    title: (_r, _d, t) => t('editor.allTags'),
    exists: (r, d) => device(r, d) !== undefined,
    Component: AllTagsEditor,
  },
};

export function registerEditor(def: EditorDef): void {
  EDITORS[def.kind] = def;
}

export interface EditorInfo {
  icon: IconName;
  title: string;
  deviceName: string;
}

/** Icona, titolo e nome del dispositivo dell'editor; null se l'oggetto non esiste più. */
export function useEditorInfo(ref: EditorRef): EditorInfo | null {
  const { t } = useTranslation();
  const doc = useAppStore((s) => s.doc);
  if (!doc) return null;
  const def = EDITORS[ref.kind];
  if (!def.exists(ref, doc)) return null;
  return {
    icon: def.icon(ref, doc),
    title: def.title(ref, doc, t),
    deviceName: device(ref, doc)?.name ?? '',
  };
}
