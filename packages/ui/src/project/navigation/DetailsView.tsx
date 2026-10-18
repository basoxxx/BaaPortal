import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { findBlock, findDevice, findTagTable, findUdt, type ObjectRef } from '@baaportal/project';
import { Icon, type IconName } from '../../icons';
import '../../icons/tree';
import '../../icons/objects';
import { useAppStore } from '../../state/AppContext';
import type { OpenDoc } from '../../state/store';
import { beginDrag, endDrag } from './objectCommands';
import { parseNodeId } from './treeIds';
import { buildTree, type TreeNode } from './treeModel';

function find(node: TreeNode | null, id: string): TreeNode | null {
  if (!node) return null;
  if (node.id === id) return node;
  for (const c of node.children) {
    const f = find(c, id);
    if (f) return f;
  }
  return null;
}

interface DetailRow {
  key: string;
  icon?: IconName;
  enabled: boolean;
  ref?: ObjectRef;
  /** La prima cella è il nome. */
  cells: string[];
}

interface Table {
  /** Chiavi i18n delle intestazioni. */
  columns: string[];
  rows: DetailRow[];
}

const plain = (c: TreeNode, t: (k: string) => string): DetailRow => ({
  key: c.id,
  icon: c.icon,
  enabled: c.enabled,
  ...(c.ref ? { ref: c.ref } : {}),
  cells: [c.label ?? t(c.labelKey)],
});

/** Righe della vista dettagli: colonne e contenuto dipendono dal nodo selezionato (spec §8.2). */
function buildTable(
  doc: OpenDoc | null,
  selection: string | null,
  t: (k: string) => string,
): Table {
  const { project, onlineAccess } = buildTree(doc);
  const node =
    find(project, selection ?? '') ?? (selection === onlineAccess.id ? onlineAccess : null);
  const parsed = selection ? parseNodeId(selection) : null;
  const dev =
    doc && parsed && parsed.kind !== 'static' ? findDevice(doc.project, parsed.dev) : undefined;
  const children = node?.children ?? [];
  const area =
    parsed?.kind === 'folder'
      ? parsed.folder === 'blocks' || parsed.folder === 'tags' || parsed.folder === 'types'
        ? parsed.folder
        : null
      : parsed?.kind === 'group'
        ? parsed.area
        : null;

  if (dev && area === 'blocks') {
    return {
      columns: ['details.name', 'details.number', 'details.type', 'details.language'],
      rows: children.map((c) => {
        const b = c.ref?.kind === 'block' ? findBlock(dev, c.ref.id) : undefined;
        const cells = plain(c, t).cells;
        if (!b) return { ...plain(c, t), cells: [...cells, '', '', ''] };
        return {
          ...plain(c, t),
          cells: [
            b.name,
            String(b.number),
            t(`details.blockKind.${b.kind}`),
            b.kind === 'DB' || b.kind === 'IDB' ? '' : b.language,
          ],
        };
      }),
    };
  }
  if (dev && area === 'tags') {
    return {
      columns: ['details.name', 'details.tags'],
      rows: children.map((c) => {
        const tb = c.ref?.kind === 'tagTable' ? findTagTable(dev, c.ref.id) : undefined;
        return {
          ...plain(c, t),
          cells: [tb?.name ?? plain(c, t).cells[0]!, tb ? String(tb.tags.length) : ''],
        };
      }),
    };
  }
  if (dev && area === 'types') {
    return {
      columns: ['details.name', 'details.number'],
      rows: children.map((c) => {
        const u = c.ref?.kind === 'udt' ? findUdt(dev, c.ref.id) : undefined;
        return {
          ...plain(c, t),
          cells: [u?.name ?? plain(c, t).cells[0]!, u ? String(u.number) : ''],
        };
      }),
    };
  }
  if (dev && parsed?.kind === 'tagTable') {
    const table = findTagTable(dev, parsed.id);
    return {
      columns: ['details.name', 'details.dataType', 'details.address', 'details.tagComment'],
      rows: (table?.tags ?? []).map((g) => ({
        key: g.id,
        enabled: true,
        ref: { kind: 'tag', deviceId: dev.id, tableId: table!.id, id: g.id },
        cells: [g.name, g.type, g.address, g.comment],
      })),
    };
  }
  return { columns: ['details.name'], rows: children.map((c) => plain(c, t)) };
}

/** Righe che si possono trascinare sull'albero. */
const DRAGGABLE: ReadonlySet<string> = new Set(['block', 'udt', 'tagTable', 'tag']);

export function DetailsView() {
  const { t } = useTranslation();
  const doc = useAppStore((s) => s.doc);
  const selection = useAppStore((s) => s.selection);
  const table = useMemo(() => buildTable(doc, selection, (k) => t(k)), [doc, selection, t]);
  return (
    <table className="baa-table">
      <thead>
        <tr>
          {table.columns.map((c) => (
            <th key={c} scope="col">
              {t(c)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {table.rows.map((r) => (
          <tr
            key={r.key}
            data-testid="details-row"
            aria-disabled={r.enabled ? undefined : true}
            draggable={r.ref && DRAGGABLE.has(r.ref.kind) ? true : undefined}
            onDragStart={(e) => {
              if (!r.ref || !DRAGGABLE.has(r.ref.kind) || !('deviceId' in r.ref)) return;
              beginDrag(e.dataTransfer, doc, r.ref.deviceId, [r.ref]);
            }}
            onDragEnd={endDrag}
          >
            {r.cells.map((cell, i) => (
              <td key={i}>
                {i === 0 && r.icon ? <Icon name={r.icon} size={16} /> : null}
                {i === 0 && r.icon ? ' ' : null}
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
