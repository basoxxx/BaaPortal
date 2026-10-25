import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { findDevice } from '@baaportal/project';
import { Icon } from '../../icons';
import '../../icons/tree';
import '../../icons/objects';
import { ContextMenu, type ContextMenuItem } from '../../components/ContextMenu';
import { peekClipboardPayload } from '../../services/clipboard';
import { useAppStore, useServices } from '../../state/AppContext';
import type { EditAction } from '../../state/store';
import { useEditTarget } from '../../state/useEditTarget';
import { areaOfItem, isStandardTable } from '../objectActions';
import { useMnemonic } from '../../editors/awl/mnemonicPreference';
import { editorOfNode } from '../../state/workArea';
import {
  blockNodesOf,
  compileProgram,
  exportCompiledBlock,
  importBlocks,
} from '../compile/compileActions';
import { runAddNode } from './addActions';
import {
  addGroupAt,
  beginDrag,
  checkRename,
  containerOf,
  copyNodes,
  deleteNodes,
  dropOn,
  dropVerdict,
  endDrag,
  groupsOfNodes,
  pasteAt,
  refsOfNodes,
  renameInfo,
  renameNode,
  sourcesOfNodes,
  watchTablesOfNodes,
} from './objectCommands';
import {
  exportSource,
  generateBlocksFromSource,
  generateSourceFromNodes,
  objectsToGenerate,
} from './sourceActions';
import { exportTagTable, importTagTable } from './tagTableIo';
import { RenameInput } from './RenameInput';
import type { CompareState } from '../../online/compare';
import { preparePlcDownload } from '../../online/plcDownload';
import { buildTree, type TreeNode } from './treeModel';
import { getProgress } from '../progress';
import { parseNodeId } from './treeIds';

const TARGET_ID = 'tree';

/** Antenati del nodo `id` (dalla radice), o null se il nodo non esiste. */
function ancestorsOf(node: TreeNode, id: string): TreeNode[] | null {
  if (node.id === id) return [];
  for (const c of node.children) {
    const inner = ancestorsOf(c, id);
    if (inner) return [node, ...inner];
  }
  return null;
}

const BADGE_COLOR: Record<CompareState, string> = {
  same: 'var(--baa-awl-constant)',
  different: 'var(--baa-online)',
  offlineOnly: 'var(--baa-text-muted)',
  onlineOnly: 'var(--baa-text-muted)',
  notCompiled: 'var(--baa-disabled)',
  unreadable: 'var(--baa-online)',
};

/** Distintivo del confronto con la CPU, come in TIA: cerchio, cerchio pieno, mezzo cerchio, grigio. */
function CompareBadge({ state }: { state: CompareState }) {
  const { t } = useTranslation();
  const label = t(`compare.${state}`);
  const c = BADGE_COLOR[state];
  return (
    <svg
      role="img"
      aria-label={label}
      data-compare={state}
      width="10"
      height="10"
      viewBox="0 0 10 10"
      style={{ flex: 'none', marginLeft: 2 }}
    >
      <title>{label}</title>
      {state === 'same' ? (
        <circle cx="5" cy="5" r="3.5" fill="none" stroke={c} strokeWidth="1.5" />
      ) : state === 'different' ? (
        <circle cx="5" cy="5" r="4" fill={c} />
      ) : state === 'unreadable' ? (
        <path d="M5 1.5v4M5 7v1.5" stroke={c} strokeWidth="1.5" fill="none" />
      ) : state === 'notCompiled' ? (
        <circle
          cx="5"
          cy="5"
          r="3.5"
          fill="none"
          stroke={c}
          strokeWidth="1.5"
          strokeDasharray="2 1.5"
        />
      ) : (
        <>
          <circle cx="5" cy="5" r="3.5" fill="none" stroke={c} strokeWidth="1" />
          <path
            d={state === 'offlineOnly' ? 'M5 1.5a3.5 3.5 0 0 0 0 7z' : 'M5 1.5a3.5 3.5 0 0 1 0 7z'}
            fill={c}
          />
        </>
      )}
    </svg>
  );
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
  const { bridge } = useServices();
  // Selezione multipla (locale all'albero): il nodo attivo è comunque `selection`.
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [, setClipboardTick] = useState(0);

  const compare = useAppStore((s) => s.online.compare);
  const { project, onlineAccess } = useMemo(() => buildTree(doc, compare), [doc, compare]);
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

  const selected = useMemo<ReadonlySet<string>>(
    () => (selection && picked.has(selection) ? picked : new Set(selection ? [selection] : [])),
    [picked, selection],
  );
  const selectedIds = [...selected];
  const objectRefs = refsOfNodes(selectedIds);
  const groups = groupsOfNodes(selectedIds);
  const sourceNodes = sourcesOfNodes(selectedIds);
  const watchNodes = watchTablesOfNodes(selectedIds);
  const [mnemonic] = useMnemonic();
  const clip = peekClipboardPayload();
  const pasteTarget = selection ? containerOf(doc, selection) : null;
  const can: Partial<Record<EditAction, boolean>> = {
    // La tabella standard non si elimina, quindi non si taglia.
    cut:
      objectRefs.length > 0 &&
      !objectRefs.some((r) => {
        const d = doc && findDevice(doc.project, r.deviceId);
        return r.kind === 'tagTable' && !!d && isStandardTable(d, r.id);
      }),
    copy: objectRefs.length > 0,
    delete:
      objectRefs.length > 0 || groups.length > 0 || sourceNodes.length > 0 || watchNodes.length > 0,
    rename: selectedIds.length === 1 && renameInfo(doc, selectedIds[0]!) !== null,
    paste:
      clip?.kind === 'objects' &&
      !!pasteTarget &&
      clip.items.some((i) => areaOfItem(i) === pasteTarget.area),
    selectAll: selection !== null,
  };

  const selectAll = () => {
    const row = rows.find((r) => r.node.id === selection);
    if (!row) return;
    const siblings = rows.filter((r) => r.parent === row.parent).map((r) => r.node.id);
    // Oggetti, gruppi e sorgenti: tutto ciò che si può eliminare insieme.
    const selectable = (id: string) =>
      refsOfNodes([id]).length +
        groupsOfNodes([id]).length +
        sourcesOfNodes([id]).length +
        watchTablesOfNodes([id]).length >
      0;
    setPicked(new Set(siblings.filter(selectable)));
  };
  // Un'azione asincrona che fallisce (finestra, appunti) finisce in Informazioni, mai come rifiuto
  // non gestito.
  const settle = (p: void | Promise<void>): void | Promise<void> =>
    p?.catch((e: unknown) =>
      store.getState().pushMessage({
        severity: 'error',
        textKey: 'messages.actionFailed',
        params: { message: e instanceof Error ? e.message : String(e) },
      }),
    );
  const run = (action: EditAction): void | Promise<void> => {
    const ctx = { store, bridge };
    switch (action) {
      case 'copy':
      case 'cut':
        copyNodes(ctx, selectedIds, action === 'cut');
        setClipboardTick((n) => n + 1);
        return;
      case 'paste':
        return selection
          ? settle(pasteAt(ctx, selection).then(() => setClipboardTick((n) => n + 1)))
          : undefined;
      case 'delete':
        return settle(deleteNodes(ctx, selectedIds));
      case 'rename':
        if (selection && can.rename) setRenaming(selection);
        return;
      case 'selectAll':
        selectAll();
    }
  };
  // Con il focus nell'albero (o nel menu che ne è partito) i comandi di Modifica agiscono qui.
  const focusProps = useEditTarget(store, TARGET_ID, treeRef, can, run);

  // Finita la rinomina il focus torna al nodo.
  const wasRenaming = useRef(false);
  useEffect(() => {
    if (renaming === null && wasRenaming.current) focusNode(selection);
    wasRenaming.current = renaming !== null;
  }, [renaming]);

  function focusNode(id: string | null) {
    if (id) treeRef.current?.querySelector<HTMLElement>(`[data-testid="tree-node-${id}"]`)?.focus();
  }

  const pick = (id: string, viaKeyboard: boolean) => {
    focusPending.current = viaKeyboard;
    anchor.current = id;
    setPicked(new Set([id]));
    store.getState().select(id);
  };

  const onNodeClick = (e: MouseEvent, node: TreeNode) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const from = anchor.current ? rows.findIndex((r) => r.node.id === anchor.current) : -1;
    if (e.shiftKey && from >= 0) {
      const to = rows.findIndex((r) => r.node.id === node.id);
      const [lo, hi] = from < to ? [from, to] : [to, from];
      setPicked(new Set(rows.slice(lo, hi + 1).map((r) => r.node.id)));
      store.getState().select(node.id);
    } else if (ctrl) {
      const next = new Set(selected);
      if (next.has(node.id) && next.size > 1) next.delete(node.id);
      else next.add(node.id);
      anchor.current = node.id;
      setPicked(next);
      store.getState().select(next.has(node.id) ? node.id : [...next].pop()!);
    } else pick(node.id, false);
  };

  const openMenuAt = (nodeId: string, x: number, y: number) => {
    if (rows.find((r) => r.node.id === nodeId)?.node.onlineOnly) return; // sola lettura: nessun menu
    if (!selected.has(nodeId)) pick(nodeId, false);
    setMenu({ x, y, nodeId });
  };

  const openable = (nodeId: string) =>
    editorOfNode(nodeId) !== null && !!rows.find((r) => r.node.id === nodeId)?.node.enabled;
  const openNode = (nodeId: string): boolean => {
    const target = openable(nodeId) ? editorOfNode(nodeId) : null;
    if (target) store.getState().openEditor(target);
    return target !== null;
  };

  const menuItems = (nodeId: string): ContextMenuItem[] => {
    const act = (a: EditAction) => () => void run(a);
    const group = containerOf(doc, nodeId);
    const parsed = parseNodeId(nodeId);
    const ctx = { store, bridge };
    const sourceItems: ContextMenuItem[] =
      parsed.kind === 'source'
        ? [
            {
              id: 'generateBlocks',
              label: t('source.generateBlocks'),
              separator: true,
              run: () => void settle(generateBlocksFromSource(ctx, parsed.dev, parsed.id)),
            },
            {
              id: 'export',
              label: t('source.export'),
              run: () => void settle(exportSource(ctx, parsed.dev, parsed.id)),
            },
          ]
        : [];
    const tagIoItems: ContextMenuItem[] = [];
    if (parsed.kind === 'tagTable') {
      tagIoItems.push(
        {
          id: 'importTags',
          label: t('tagIo.import'),
          separator: true,
          run: () => void settle(importTagTable({ deviceId: parsed.dev, tableId: parsed.id }, ctx)),
        },
        {
          id: 'exportTags',
          label: t('tagIo.export'),
          run: () =>
            void settle(exportTagTable({ deviceId: parsed.dev, id: parsed.id }, 'xlsx', ctx)),
        },
      );
    } else if (parsed.kind === 'folder' && parsed.folder === 'tags') {
      tagIoItems.push({
        id: 'importTags',
        label: t('tagIo.import'),
        separator: true,
        run: () => void settle(importTagTable({ deviceId: parsed.dev }, ctx)),
      });
    }
    // Dei blocchi e dei tipi selezionati; sulle cartelle, di tutti quelli che contengono.
    const generateItems: ContextMenuItem[] =
      parsed.kind === 'block' ||
      parsed.kind === 'udt' ||
      (parsed.kind === 'folder' && (parsed.folder === 'blocks' || parsed.folder === 'types'))
        ? [
            {
              id: 'generateFromBlocks',
              label: t('source.generateFromBlocks'),
              separator: true,
              disabled: !objectsToGenerate(doc, selected.has(nodeId) ? selectedIds : [nodeId])?.refs
                .length,
              run: () =>
                void generateSourceFromNodes(
                  ctx,
                  selected.has(nodeId) ? selectedIds : [nodeId],
                  mnemonic,
                ),
            },
          ]
        : [];
    const inNodes = selected.has(nodeId) ? selectedIds : [nodeId];
    const compileItems: ContextMenuItem[] = [];
    if (parsed.kind === 'plc' || (parsed.kind === 'folder' && parsed.folder === 'blocks')) {
      compileItems.push(
        {
          id: 'compileChanges',
          label: t('objects.compileChanges'),
          separator: true,
          disabled: !!getProgress(),
          run: () => compileProgram(ctx, parsed.dev, 'changes'),
        },
        {
          id: 'compileFull',
          label: t('objects.compileFull'),
          disabled: !!getProgress(),
          run: () => compileProgram(ctx, parsed.dev, 'full'),
        },
      );
    }
    if (parsed.kind === 'folder' && parsed.folder === 'blocks') {
      compileItems.push({
        id: 'importBlocks',
        label: t('objects.importBlocks'),
        run: () => void settle(importBlocks(ctx, parsed.dev)),
      });
    }
    if (parsed.kind === 'block') {
      const blocks = blockNodesOf(inNodes);
      compileItems.push(
        {
          id: 'compileBlock',
          label: t('objects.compile'),
          separator: true,
          disabled: !blocks || !!getProgress(),
          run: () => blocks && compileProgram(ctx, blocks.deviceId, 'full', blocks.ids),
        },
        {
          id: 'exportCompiled',
          label: t('objects.exportCompiled'),
          disabled: inNodes.length !== 1,
          run: () => void settle(exportCompiledBlock(ctx, parsed.dev, parsed.id)),
        },
      );
      // Solo col PLC online: i blocchi scelti nell'albero, con l'anteprima del confronto.
      const online = store.getState().online;
      if (online.status === 'on' && online.deviceId === parsed.dev) {
        compileItems.push({
          id: 'downloadToDevice',
          label: t('objects.downloadToDevice'),
          disabled: !blocks || !!online.downloading || !!online.comparing || !!getProgress(),
          run: () => blocks && void settle(preparePlcDownload(ctx, blocks.ids)),
        });
      }
    }
    return [
      {
        id: 'open',
        label: t('objects.open'),
        disabled: !openable(nodeId),
        run: () => openNode(nodeId),
      },
      {
        id: 'cut',
        label: t('commands.edit.cut'),
        disabled: !can.cut,
        separator: true,
        run: act('cut'),
      },
      { id: 'copy', label: t('commands.edit.copy'), disabled: !can.copy, run: act('copy') },
      { id: 'paste', label: t('commands.edit.paste'), disabled: !can.paste, run: act('paste') },
      { id: 'delete', label: t('commands.edit.delete'), disabled: !can.delete, run: act('delete') },
      { id: 'rename', label: t('commands.edit.rename'), disabled: !can.rename, run: act('rename') },
      {
        id: 'addGroup',
        label: t('objects.addGroup'),
        disabled: !group?.isContainer,
        separator: true,
        run: () => {
          const id = addGroupAt(store, nodeId);
          if (!id) return;
          pick(id, false);
          setRenaming(id);
        },
      },
      ...sourceItems,
      ...generateItems,
      ...tagIoItems,
      ...compileItems,
      {
        id: 'properties',
        label: t('objects.properties'),
        separator: true,
        run: () => {
          pick(nodeId, false);
          store.getState().setInspectorTab('properties');
          store.getState().setPanel('inspector', { open: true });
        },
      },
    ];
  };

  const onDragStart = (e: DragEvent, node: TreeNode) => {
    const ids_ = selected.has(node.id) ? [...selected] : [node.id];
    const refs = refsOfNodes(ids_).filter((r) => r.deviceId === node.ref?.deviceId);
    if (refs.length === 0) return e.preventDefault();
    beginDrag(e.dataTransfer, doc, refs[0]!.deviceId, refs);
  };
  const onDragOver = (e: DragEvent, node: TreeNode) => {
    const verdict = dropVerdict(doc, node.id);
    if (verdict) {
      e.preventDefault();
      e.dataTransfer.dropEffect = verdict;
      setDropTarget(node.id);
    } else {
      e.dataTransfer.dropEffect = 'none';
      setDropTarget((cur) => (cur === node.id ? null : cur));
    }
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
    if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      openMenuAt(row.node.id, r.left + 24, r.bottom);
      e.preventDefault();
      e.stopPropagation(); // la barra dei menu apre il primo menu con F10
      return;
    }
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
        if (!row.node.enabled) return;
        if (!runAddNode(store, row.node.id, bridge) && !openNode(row.node.id)) return;
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  return (
    <>
      <ul
        role="tree"
        aria-label={t('panel.navigation')}
        aria-multiselectable="true"
        className="baa-tree"
        ref={treeRef}
        onFocus={focusProps.onFocus}
        onBlur={focusProps.onBlur}
      >
        {rows.map(({ node, level }, i) => {
          const hasKids = node.children.length > 0;
          const draggable =
            (node.ref?.kind === 'block' ||
              node.ref?.kind === 'udt' ||
              node.ref?.kind === 'tagTable') &&
            renaming !== node.id;
          return (
            <li
              key={node.id}
              role="treeitem"
              data-testid={`tree-node-${node.id}`}
              aria-level={level + 1}
              aria-selected={selected.has(node.id)}
              aria-expanded={hasKids ? !collapsed.has(node.id) : undefined}
              aria-disabled={node.enabled ? undefined : true}
              tabIndex={node.id === tabbableId ? 0 : -1}
              className={`baa-tree-node${dropTarget === node.id ? ' baa-drop-target' : ''}`}
              style={{ paddingLeft: 6 + level * 16 }}
              draggable={draggable || undefined}
              onClick={(e) => onNodeClick(e, node)}
              onDoubleClick={() => {
                if (!node.enabled || !(runAddNode(store, node.id, bridge) || openNode(node.id)))
                  toggle(node);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                openMenuAt(node.id, e.clientX, e.clientY);
              }}
              onKeyDown={(e) => onKeyDown(e, i)}
              onDragStart={(e) => onDragStart(e, node)}
              onDragEnd={() => {
                endDrag();
                setDropTarget(null);
              }}
              onDragOver={(e) => onDragOver(e, node)}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                  setDropTarget((cur) => (cur === node.id ? null : cur));
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                setDropTarget(null);
                dropOn(store, node.id);
              }}
            >
              <span className="baa-tree-twist" aria-hidden="true">
                {hasKids ? (collapsed.has(node.id) ? '▸' : '▾') : ''}
              </span>
              <Icon name={node.icon} size={16} />
              {node.compare ? <CompareBadge state={node.compare} /> : null}
              {renaming === node.id ? (
                <RenameInput
                  initial={renameInfo(doc, node.id)?.name ?? ''}
                  check={(name) => checkRename(doc, node.id, name)}
                  onCommit={(name) => void renameNode(store, node.id, name)}
                  onDone={() => setRenaming(null)}
                />
              ) : (
                <span className="baa-tree-label">{node.label ?? t(node.labelKey)}</span>
              )}
            </li>
          );
        })}
      </ul>
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={t('objects.menuLabel')}
          items={menuItems(menu.nodeId)}
          onClose={() => {
            setMenu(null);
            focusNode(menu.nodeId);
          }}
        />
      ) : null}
    </>
  );
}
