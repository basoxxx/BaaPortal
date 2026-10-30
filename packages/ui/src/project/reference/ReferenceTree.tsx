import { useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ContextMenu, type ContextMenuItem } from '../../components/ContextMenu';
import { Icon } from '../../icons';
import '../../icons/tree';
import '../../icons/objects';
import { useAppStore, useServices } from '../../state/AppContext';
import type { EditAction } from '../../state/store';
import { useEditTarget } from '../../state/useEditTarget';
import { Dialog } from '../../components/Dialog';
import { ReadOnlyObjects } from '../../components/ReadOnlyObjects';
import { beginInsertDrag, endDrag, refsOfNodes } from '../navigation/objectCommands';
import { buildTree, type TreeNode } from '../navigation/treeModel';
import {
  canCopyIntoProject,
  copyFromReference,
  copyIntoProject,
  insertFromReference,
  qualify,
  readOnlyObjectsOf,
  unqualify,
  type ReferenceProject,
} from './referenceStore';

/** Le voci "Aggiungi…" del progetto aperto non hanno senso in un riferimento. */
const isAddEntry = (id: string) =>
  id === 'add-device' || /:(blocks|sources|tags|types)-add$/.test(id);

function prune(node: TreeNode): TreeNode {
  return { ...node, children: node.children.filter((c) => !isAddEntry(c.id)).map(prune) };
}

function findNode(node: TreeNode, id: string): TreeNode | undefined {
  if (node.id === id) return node;
  for (const c of node.children) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return undefined;
}

interface Row {
  node: TreeNode;
  level: number;
  parent: TreeNode | null;
}

/** Albero di un riferimento: sola lettura. Non usa mai i comandi che modificano il progetto aperto. */
export function ReferenceTree({ reference }: { reference: ReferenceProject }) {
  const { t } = useTranslation();
  const { store, bridge } = useServices();
  const ownDoc = useAppStore((s) => s.doc);
  const selection = useAppStore((s) => s.selection);
  const hasTarget = canCopyIntoProject({ doc: ownDoc, selection });
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null);
  const [viewing, setViewing] = useState<{ title: string; objects: ReadOnlyObjects } | null>(null);
  const anchor = useRef<string | null>(null);
  const treeRef = useRef<HTMLUListElement>(null);
  const key = reference.key;

  const root = useMemo(() => {
    const { project } = buildTree({
      project: reference.doc,
      filePath: reference.path,
      dirty: false,
      revision: 0,
      savedRevision: 0,
    });
    return project ? prune(project) : null;
  }, [reference]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (node: TreeNode, level: number, parent: TreeNode | null) => {
      out.push({ node, level, parent });
      if (!collapsed.has(node.id)) node.children.forEach((c) => walk(c, level + 1, node));
    };
    if (root) walk(root, 0, null);
    return out;
  }, [root, collapsed]);

  const q = (id: string) => qualify(key, id);
  const selectedIds = [...picked];
  const copyable = refsOfNodes(selectedIds.map((id) => unqualify(id)?.nodeId ?? '')).length > 0;
  // Solo la copia agisce: ogni comando che modifica il progetto è spento.
  const can: Partial<Record<EditAction, boolean>> = {
    copy: copyable,
    cut: false,
    paste: false,
    delete: false,
    rename: false,
    selectAll: false,
  };
  const run = (action: EditAction) => {
    if (action === 'copy') copyFromReference(key, selectedIds, bridge);
  };
  const focusProps = useEditTarget(store, 'reference-tree', treeRef, can, run);

  const pick = (id: string) => {
    anchor.current = id;
    setPicked(new Set([id]));
    setActive(id);
  };
  const onClick = (e: MouseEvent, node: TreeNode) => {
    const id = q(node.id);
    if (e.shiftKey && anchor.current) {
      const from = rows.findIndex((r) => q(r.node.id) === anchor.current);
      const to = rows.findIndex((r) => r.node.id === node.id);
      const [lo, hi] = from < to ? [from, to] : [to, from];
      setPicked(new Set(rows.slice(lo, hi + 1).map((r) => q(r.node.id))));
      setActive(id);
    } else if (e.ctrlKey || e.metaKey) {
      const next = new Set(picked);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      anchor.current = id;
      setPicked(next);
      setActive(id);
    } else pick(id);
  };
  const toggle = (node: TreeNode, open?: boolean) => {
    if (node.children.length === 0) return;
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (open ?? prev.has(node.id)) next.delete(node.id);
      else next.add(node.id);
      return next;
    });
  };
  /** Apre l'oggetto del nodo in sola lettura (con i grafici KOP/FUP). */
  const openReadOnly = (node: TreeNode) => {
    const objects = readOnlyObjectsOf(key, [q(node.id)]);
    if (objects) setViewing({ title: node.label ?? t(node.labelKey), objects });
  };

  const menuItems = (nodeId: string): ContextMenuItem[] => {
    const nodes = picked.has(q(nodeId)) ? selectedIds : [q(nodeId)];
    const objs = refsOfNodes(nodes.map((id) => unqualify(id)?.nodeId ?? '')).length > 0;
    return [
      {
        id: 'copy',
        label: t('commands.edit.copy'),
        disabled: !objs,
        run: () => void copyFromReference(key, nodes, bridge),
      },
      {
        id: 'openReadOnly',
        label: t('library.view'),
        disabled: !objs,
        run: () => {
          const n = root && findNode(root, nodeId);
          if (n) openReadOnly(n);
        },
      },
      {
        id: 'copyIntoProject',
        label: t('reference.copyIntoProject'),
        disabled: !objs || !hasTarget,
        run: () => void copyIntoProject(store, bridge, key, nodes),
      },
      { id: 'cut', label: t('commands.edit.cut'), disabled: true, separator: true, run: () => {} },
      { id: 'paste', label: t('commands.edit.paste'), disabled: true, run: () => {} },
      { id: 'delete', label: t('commands.edit.delete'), disabled: true, run: () => {} },
      { id: 'rename', label: t('commands.edit.rename'), disabled: true, run: () => {} },
    ];
  };

  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const row = rows[index]!;
    const hasKids = row.node.children.length > 0;
    const isOpen = !collapsed.has(row.node.id);
    const move = (r: Row | undefined) => {
      if (!r) return;
      pick(q(r.node.id));
      treeRef.current
        ?.querySelector<HTMLElement>(`[data-testid="reference-node-${q(r.node.id)}"]`)
        ?.focus();
    };
    switch (e.key) {
      case 'ArrowDown':
        move(rows[index + 1]);
        break;
      case 'ArrowUp':
        move(rows[index - 1]);
        break;
      case 'ArrowRight':
        if (hasKids && !isOpen) toggle(row.node, true);
        else if (hasKids) move(rows[index + 1]);
        break;
      case 'ArrowLeft':
        if (hasKids && isOpen) toggle(row.node, false);
        else move(rows.find((r) => r.node === row.parent));
        break;
      case 'Enter':
        if (row.node.ref) openReadOnly(row.node);
        else toggle(row.node);
        break;
      case 'ContextMenu': {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setMenu({ x: r.left + 24, y: r.bottom, nodeId: row.node.id });
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  };

  const tabbable =
    active && rows.some((r) => q(r.node.id) === active) ? active : q(rows[0]?.node.id ?? '');

  return (
    <>
      <ul
        role="tree"
        aria-label={reference.path}
        aria-multiselectable="true"
        aria-readonly="true"
        className="baa-tree"
        ref={treeRef}
        onFocus={focusProps.onFocus}
        onBlur={focusProps.onBlur}
      >
        {rows.map(({ node, level }, i) => {
          const id = q(node.id);
          const hasKids = node.children.length > 0;
          return (
            <li
              key={id}
              role="treeitem"
              data-testid={`reference-node-${id}`}
              aria-level={level + 1}
              aria-selected={picked.has(id)}
              aria-expanded={hasKids ? !collapsed.has(node.id) : undefined}
              aria-disabled={node.enabled ? undefined : true}
              tabIndex={id === tabbable ? 0 : -1}
              className="baa-tree-node"
              style={{ paddingLeft: 6 + level * 16 }}
              draggable={Boolean(node.ref)}
              onClick={(e) => onClick(e, node)}
              onDoubleClick={() => (node.ref ? openReadOnly(node) : toggle(node))}
              onDragStart={(e) => {
                const nodes = picked.has(id) ? selectedIds : [id];
                beginInsertDrag(e.dataTransfer, node.label ?? t(node.labelKey), (deviceId, drop) =>
                  insertFromReference(store, key, nodes, deviceId, drop),
                );
              }}
              onDragEnd={() => endDrag()}
              onContextMenu={(e) => {
                e.preventDefault();
                if (!picked.has(id)) pick(id);
                setMenu({ x: e.clientX, y: e.clientY, nodeId: node.id });
              }}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              <span className="baa-tree-twist" aria-hidden="true">
                {hasKids ? (collapsed.has(node.id) ? '▸' : '▾') : ''}
              </span>
              <Icon name={node.icon} size={16} />
              <span className="baa-tree-label">{node.label ?? t(node.labelKey)}</span>
            </li>
          );
        })}
      </ul>
      {viewing ? (
        <Dialog
          title={t('reference.viewTitle', { name: viewing.title })}
          onClose={() => setViewing(null)}
          onOk={() => setViewing(null)}
          testId="reference-view"
          footer={
            <button type="button" data-testid="dialog-ok" onClick={() => setViewing(null)}>
              {t('dialog.ok')}
            </button>
          }
        >
          <ReadOnlyObjects objects={viewing.objects} />
        </Dialog>
      ) : null}
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={t('objects.menuLabel')}
          items={menuItems(menu.nodeId)}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </>
  );
}
