import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../icons';
import '../../icons/tree';
import '../../icons/objects';
import { useAppStore, useServices } from '../../state/AppContext';
import { runAddNode } from './addActions';
import { buildTree, type TreeNode } from './treeModel';

/** Antenati del nodo `id` (dalla radice), o null se il nodo non esiste. */
function ancestorsOf(node: TreeNode, id: string): TreeNode[] | null {
  if (node.id === id) return [];
  for (const c of node.children) {
    const inner = ancestorsOf(c, id);
    if (inner) return [node, ...inner];
  }
  return null;
}

interface Row {
  node: TreeNode;
  level: number;
  parent: TreeNode | null;
}

export function ProjectTree() {
  const { t } = useTranslation();
  const { store } = useServices();
  const doc = useAppStore((s) => s.doc);
  const selection = useAppStore((s) => s.selection);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const focusPending = useRef(false);
  const treeRef = useRef<HTMLUListElement>(null);

  const { project, onlineAccess } = useMemo(() => buildTree(doc), [doc]);
  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (node: TreeNode, level: number, parent: TreeNode | null) => {
      out.push({ node, level, parent });
      if (!collapsed.has(node.id)) node.children.forEach((c) => walk(c, level + 1, node));
    };
    if (project) walk(project, 0, null);
    walk(onlineAccess, 0, null);
    return out;
  }, [project, onlineAccess, collapsed]);

  // Un nodo selezionato da fuori (nuovo PLC, nuovo blocco) deve essere visibile: si aprono gli antenati.
  useEffect(() => {
    if (!selection || !project) return;
    const up = ancestorsOf(project, selection);
    if (!up) return;
    setCollapsed((prev) => {
      if (!up.some((n) => prev.has(n.id))) return prev;
      const next = new Set(prev);
      for (const n of up) next.delete(n.id);
      return next;
    });
    // Solo al cambiare della selezione: chiudere a mano un ramo non deve riaprirlo.
  }, [selection]);

  // Il focus segue la selezione quando questa cambia da tastiera.
  useEffect(() => {
    if (!focusPending.current || !selection) return;
    focusPending.current = false;
    treeRef.current?.querySelector<HTMLElement>(`[data-testid="tree-node-${selection}"]`)?.focus();
  }, [selection]);

  const selectedVisible = rows.some((r) => r.node.id === selection);
  const tabbableId = selectedVisible ? selection : rows[0]?.node.id;

  const pick = (id: string, viaKeyboard: boolean) => {
    focusPending.current = viaKeyboard;
    store.getState().select(id);
  };
  const toggle = (node: TreeNode, open?: boolean) => {
    if (node.children.length === 0) return;
    setCollapsed((prev) => {
      const next = new Set(prev);
      const isOpen = !prev.has(node.id);
      if (open ?? !isOpen) next.delete(node.id);
      else next.add(node.id);
      return next;
    });
  };

  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const row = rows[index]!;
    const hasKids = row.node.children.length > 0;
    const isOpen = !collapsed.has(row.node.id);
    switch (e.key) {
      case 'ArrowDown': {
        const n = rows[index + 1];
        if (n) pick(n.node.id, true);
        break;
      }
      case 'ArrowUp': {
        const n = rows[index - 1];
        if (n) pick(n.node.id, true);
        break;
      }
      case 'ArrowRight':
        if (hasKids && !isOpen) toggle(row.node, true);
        else if (hasKids) pick(row.node.children[0]!.id, true);
        break;
      case 'ArrowLeft':
        if (hasKids && isOpen) toggle(row.node, false);
        else if (row.parent) pick(row.parent.id, true);
        break;
      case 'Home':
        pick(rows[0]!.node.id, true);
        break;
      case 'End':
        pick(rows[rows.length - 1]!.node.id, true);
        break;
      case 'Enter':
        if (!row.node.enabled || !runAddNode(store, row.node.id)) return;
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  return (
    <ul role="tree" aria-label={t('panel.navigation')} className="baa-tree" ref={treeRef}>
      {rows.map(({ node, level }, i) => {
        const hasKids = node.children.length > 0;
        return (
          <li
            key={node.id}
            role="treeitem"
            data-testid={`tree-node-${node.id}`}
            aria-level={level + 1}
            aria-selected={selection === node.id}
            aria-expanded={hasKids ? !collapsed.has(node.id) : undefined}
            aria-disabled={node.enabled ? undefined : true}
            tabIndex={node.id === tabbableId ? 0 : -1}
            className="baa-tree-node"
            style={{ paddingLeft: 6 + level * 16 }}
            onClick={() => pick(node.id, false)}
            onDoubleClick={() => {
              if (!node.enabled || !runAddNode(store, node.id)) toggle(node);
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
  );
}
