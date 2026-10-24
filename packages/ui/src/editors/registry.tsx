import type { FC } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { findDevice } from '@baaportal/project';
import type { IconName } from '../icons';
import { useAppStore } from '../state/AppContext';
import { BlockEditor } from './block/BlockEditor';
import { DbEditor } from './db/DbEditor';
import { SourceEditor } from './source/SourceEditor';
import { WatchTableView } from './watch/WatchTableView';
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
  tagTable: {
    kind: 'tagTable',
    icon: () => 'objTagTable',
    title: (r, d) => device(r, d)?.tagTables.find((x) => x.id === r.objectId)?.name ?? '',
    exists: (r, d) => !!device(r, d)?.tagTables.some((x) => x.id === r.objectId),
    Component: TagTableEditor,
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
