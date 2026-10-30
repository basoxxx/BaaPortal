import { useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { findCpu } from '@baaportal/catalog';
import { generateAwlSource } from '@baaportal/importers';
import {
  createLibraryItem,
  emptyLibrary,
  findDevice,
  libraryItemObjects,
  type Library,
  type LibraryItem,
  type ObjectRef,
  type PlcDevice,
} from '@baaportal/project';
import { ContextMenu, type ContextMenuItem } from '../../components/ContextMenu';
import { Dialog } from '../../components/Dialog';
import { useMnemonic } from '../../editors/awl/mnemonicPreference';
import { Icon, type IconName } from '../../icons';
import '../../icons/objects';
import { useAppStore, useServices } from '../../state/AppContext';
import {
  beginInsertDrag,
  endDrag,
  peekDrag,
  refsOfNodes,
  reportSkipped,
  selectRef,
  watchTablesOfNodes,
} from '../navigation/objectCommands';
import { RenameInput } from '../navigation/RenameInput';
import { targetPlcId } from '../navigation/treeIds';
import {
  defaultResolution,
  findConflicts,
  insertLibraryItem,
  type Conflict,
  type Resolution,
} from './libraryInsert';
import {
  addFolder,
  addItem,
  checkFolderName,
  checkItemName,
  closeGlobalLibrary,
  deleteEntries,
  folderPaths,
  globalTitle,
  IEC_KEY,
  iecLibrary,
  moveItems,
  mutateLibrary,
  newGlobalLibrary,
  openGlobalLibrary,
  PROJECT_KEY,
  renameFolder,
  renameItem,
  saveGlobalLibrary,
  setGlobalEditing,
  useGlobalLibraries,
  type LibraryView,
} from './libraryStore';
import './library.css';

const newId = () => globalThis.crypto.randomUUID();
const EMPTY: Library = emptyLibrary();
const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const lastOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

type Row =
  | { type: 'folder'; id: string; path: string; level: number }
  | { type: 'item'; id: string; item: LibraryItem; level: number };

function iconOf(item: LibraryItem): IconName {
  const b = item.blocks[0];
  if (b)
    return b.kind === 'FB'
      ? 'objFb'
      : b.kind === 'FC'
        ? 'objFc'
        : b.kind === 'OB'
          ? 'objOb'
          : 'objDb';
  if (item.udts.length > 0) return 'objUdt';
  return item.tagTables.length > 0 ? 'objTagTable' : 'objWatch';
}

const matches = (item: LibraryItem, q: string) =>
  q === '' ||
  [item.name, item.comment, ...libraryItemObjects(item).map((o) => `${o.label} ${o.name}`)].some(
    (s) => s.toLowerCase().includes(q),
  );

/** Righe visibili: cartelle e modelli in ordine alfabetico; con una ricerca solo ciò che corrisponde. */
function buildRows(lib: Readonly<Library>, query: string, collapsed: ReadonlySet<string>): Row[] {
  const q = query.trim().toLowerCase();
  const items = lib.items.filter((i) => matches(i, q));
  const folders = [...folderPaths(lib)].filter(
    (f) => q === '' || items.some((i) => i.group === f || i.group.startsWith(`${f}/`)),
  );
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  const out: Row[] = [];
  const walk = (parent: string, level: number) => {
    for (const f of folders.filter((x) => parentOf(x) === parent).sort(byName)) {
      out.push({ type: 'folder', id: `folder:${f}`, path: f, level });
      if (q !== '' || !collapsed.has(f)) walk(f, level + 1);
    }
    for (const item of items
      .filter((i) => i.group === parent)
      .sort((a, b) => byName(a.name, b.name))) {
      out.push({ type: 'item', id: `item:${item.id}`, item, level });
    }
  };
  walk('', 0);
  return out;
}

/** Testo in sola lettura di un modello: la sorgente AWL di blocchi e UDT, poi le tabelle. */
function itemText(item: LibraryItem, mnemonic: ReturnType<typeof useMnemonic>[0]): string {
  const copy = structuredClone(item);
  const dev = { ...copy, id: 'library', name: '', sources: [] } as unknown as PlcDevice;
  const refs: ObjectRef[] = [
    ...copy.udts.map((u) => ({ kind: 'udt' as const, deviceId: dev.id, id: u.id })),
    ...copy.blocks.map((b) => ({ kind: 'block' as const, deviceId: dev.id, id: b.id })),
  ];
  const parts = refs.length > 0 ? [generateAwlSource(dev, refs, mnemonic).text] : [];
  for (const tb of copy.tagTables) {
    parts.push(
      [
        `// ${tb.name}`,
        ...tb.tags.map((x) => `${x.name}\t${x.type}\t${x.address}\t${x.comment}`),
      ].join('\n'),
    );
  }
  for (const w of copy.watchTables) {
    parts.push(
      [`// ${w.name}`, ...w.rows.map((r) => `${r.operand}\t${r.format}\t${r.modify ?? ''}`)].join(
        '\n',
      ),
    );
  }
  return parts.join('\n\n');
}

/** Ciò che si trascina da una riga della libreria (per spostarla in un'altra cartella). */
let internalDrag: { key: string; itemId: string } | null = null;

/** Cosa comporta la scelta fatta per uno scontro, e gli avvisi che valgono comunque. */
function conflictNote(c: Conflict, r: Resolution | undefined, t: TFunction): string {
  const notes: string[] = [];
  if (c.symbol && r === 'rename') notes.push(t('library.symbolRename', { at: c.symbol.at }));
  if (c.symbol && r === 'useExisting') {
    notes.push(t('library.symbolUseExisting', { at: c.symbol.existing ?? '' }));
  }
  if (r === 'replace' && c.callers.length > 0) {
    notes.push(t('library.replaceCallers', { names: c.callers.join(', ') }));
  }
  if (c.indirect) notes.push(t('library.indirectRefs'));
  return notes.join(' ');
}

function ConflictDialog({
  item,
  conflicts,
  onCancel,
  onOk,
}: {
  item: LibraryItem;
  conflicts: Conflict[];
  onCancel(): void;
  onOk(choices: Map<string, Resolution>): void;
}) {
  const { t } = useTranslation();
  const [choices, setChoices] = useState(
    () => new Map(conflicts.map((c) => [c.id, defaultResolution(c)])),
  );
  return (
    <Dialog
      title={t('library.conflictTitle', { name: item.name })}
      onClose={onCancel}
      onOk={() => onOk(choices)}
      testId="library-conflicts"
    >
      <p>{t('library.conflictMessage')}</p>
      <table className="baa-library-conflicts">
        <tbody>
          {conflicts.map((c) => (
            <tr key={c.id}>
              <td>
                {c.label} {c.name}
              </td>
              <td>
                {t(
                  c.nameTaken && c.numberTaken
                    ? 'library.takenBoth'
                    : c.nameTaken
                      ? 'library.takenName'
                      : 'library.takenNumber',
                )}
              </td>
              <td>
                <select
                  aria-label={t('library.resolutionFor', { name: c.name })}
                  value={choices.get(c.id)}
                  onChange={(e) =>
                    setChoices(new Map(choices).set(c.id, e.target.value as Resolution))
                  }
                >
                  {c.options.map((o) => (
                    <option key={o} value={o}>
                      {t(
                        o === 'useExisting' && c.kind === 'constant'
                          ? 'library.resolution.useExistingConstant'
                          : `library.resolution.${o}`,
                      )}
                    </option>
                  ))}
                </select>
              </td>
              <td>{conflictNote(c, choices.get(c.id), t)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}

/** Albero di una libreria con ricerca, menu contestuale, trascinamento e inserimento nel PLC. */
export function LibraryTree({ view }: { view: LibraryView }) {
  const { t } = useTranslation();
  const { store, bridge } = useServices();
  const [mnemonic] = useMnemonic();
  const hasDoc = useAppStore((s) => s.doc !== null);
  const hasTarget = useAppStore((s) => targetPlcId(s) !== null);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; row: Row } | null>(null);
  const [pending, setPending] = useState<{
    item: LibraryItem;
    deviceId: string;
    conflicts: Conflict[];
  } | null>(null);
  const [viewing, setViewing] = useState<LibraryItem | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const treeRef = useRef<HTMLUListElement>(null);
  const { key, library: lib, editable } = view;
  const rows = useMemo(() => buildRows(lib, query, collapsed), [lib, query, collapsed]);
  const mutate = (label: string, recipe: (l: Library) => void) =>
    mutateLibrary(store, key, label, recipe);

  const doInsert = (item: LibraryItem, deviceId: string, choices: Map<string, Resolution>) => {
    let result: ReturnType<typeof insertLibraryItem> | null = null;
    store.getState().edit('history.libraryInsert', (p) => {
      const d = findDevice(p, deviceId);
      if (d) result = insertLibraryItem(d, item, choices, findCpu(d.cpu.typeId), newId);
    });
    const done = result as ReturnType<typeof insertLibraryItem> | null;
    if (!done) return;
    reportSkipped(store, done.skipped);
    store.getState().pushMessage({
      severity: 'info',
      textKey: 'messages.libraryInserted',
      params: { name: item.name, count: String(done.created.length) },
    });
    selectRef(store, done.created[0]);
  };
  /** Inserisce nel PLC; se nomi o numeri sono presi chiede prima cosa fare. */
  const startInsert = (item: LibraryItem, deviceId: string | null) => {
    const doc = store.getState().doc;
    const dev = deviceId && doc ? findDevice(doc.project, deviceId) : undefined;
    if (!dev) return;
    const conflicts = findConflicts(dev, item);
    if (conflicts.length === 0) doInsert(item, dev.id, new Map());
    else setPending({ item, deviceId: dev.id, conflicts });
  };

  /** Nuovo modello dagli oggetti del progetto (con le dipendenze) nella cartella data. */
  const addFromProject = (deviceId: string, refs: ObjectRef[], folder: string) => {
    const doc = store.getState().doc;
    const dev = doc && findDevice(doc.project, deviceId);
    const item = dev && createLibraryItem(dev, refs, { group: folder, newId });
    if (item) mutate('history.libraryAdd', (l) => addItem(l, item));
  };
  const addSelection = () => {
    const sel = store.getState().selection;
    if (!sel) return;
    const refs: ObjectRef[] = [
      ...refsOfNodes([sel]),
      ...watchTablesOfNodes([sel]).map((w) => ({
        kind: 'watchTable' as const,
        deviceId: w.dev,
        id: w.id,
      })),
    ];
    if (refs[0]) addFromProject(refs[0].deviceId, refs, folderOf(selected));
  };
  const folderOf = (rowId: string | null) => {
    const r = rows.find((x) => x.id === rowId);
    return r?.type === 'folder' ? r.path : r?.type === 'item' ? r.item.group : '';
  };
  const toProjectLibrary = (item: LibraryItem) =>
    mutateLibrary(store, PROJECT_KEY, 'history.libraryAdd', (l) =>
      addItem(l, { ...structuredClone(item), id: newId(), group: '' }),
    );
  const remove = async (row: Row) => {
    const name = row.type === 'folder' ? lastOf(row.path) : row.item.name;
    const yes = await bridge.askQuestion({
      title: t('objects.deleteTitle'),
      message: `${t('library.deleteMessage')}\n\n${name}`,
      yes: t('objects.yes'),
      no: t('objects.no'),
    });
    if (!yes) return;
    mutate('history.libraryDelete', (l) =>
      row.type === 'folder'
        ? deleteEntries(l, [], [row.path])
        : deleteEntries(l, [row.item.id], []),
    );
  };
  const newFolder = (parent: string) => {
    let path = '';
    mutate('history.libraryAdd', (l) => (path = addFolder(l, parent)));
    if (path) {
      setSelected(`folder:${path}`);
      setRenaming(`folder:${path}`);
    }
  };

  const menuItems = (row: Row): ContextMenuItem[] =>
    row.type === 'item'
      ? [
          {
            id: 'insert',
            label: t('library.insert'),
            disabled: !hasTarget,
            run: () => startInsert(row.item, targetPlcId(store.getState())),
          },
          { id: 'view', label: t('library.view'), run: () => setViewing(row.item) },
          ...(key !== PROJECT_KEY
            ? [
                {
                  id: 'toProject',
                  label: t('library.toProject'),
                  disabled: !hasDoc,
                  run: () => toProjectLibrary(row.item),
                },
              ]
            : []),
          {
            id: 'rename',
            label: t('commands.edit.rename'),
            disabled: !editable,
            separator: true,
            run: () => setRenaming(row.id),
          },
          {
            id: 'delete',
            label: t('commands.edit.delete'),
            disabled: !editable,
            run: () => void remove(row),
          },
        ]
      : [
          {
            id: 'newFolder',
            label: t('library.newFolder'),
            disabled: !editable,
            run: () => newFolder(row.path),
          },
          {
            id: 'rename',
            label: t('commands.edit.rename'),
            disabled: !editable,
            run: () => setRenaming(row.id),
          },
          {
            id: 'delete',
            label: t('commands.edit.delete'),
            disabled: !editable,
            run: () => void remove(row),
          },
        ];

  const focusRow = (i: number) => {
    const r = rows[i];
    if (!r) return;
    setSelected(r.id);
    treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]')[i]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent, i: number) => {
    const row = rows[i]!;
    if (renaming) return;
    switch (e.key) {
      case 'ArrowDown':
        focusRow(i + 1);
        break;
      case 'ArrowUp':
        focusRow(i - 1);
        break;
      case 'ArrowRight':
      case 'ArrowLeft':
        if (row.type !== 'folder') return;
        setCollapsed((prev) => {
          const next = new Set(prev);
          if (e.key === 'ArrowRight') next.delete(row.path);
          else next.add(row.path);
          return next;
        });
        break;
      case 'Enter':
        if (row.type === 'item') setViewing(row.item);
        break;
      case 'F2':
        if (editable) setRenaming(row.id);
        break;
      case 'Delete':
        if (editable) void remove(row);
        break;
      case 'ContextMenu': {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setMenu({ x: r.left + 24, y: r.bottom, row });
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  };

  // Rilascio nella libreria: oggetti dall'albero del progetto, o un modello da spostare.
  const accepts = () =>
    editable &&
    ((internalDrag !== null && internalDrag.key === key) ||
      (peekDrag()?.refs.some(
        (r) => r.kind === 'block' || r.kind === 'udt' || r.kind === 'tagTable',
      ) ??
        false));
  const dropProps = (target: string, folder: string) => ({
    onDragOver: (e: DragEvent) => {
      if (!accepts()) return;
      e.preventDefault();
      e.stopPropagation();
      setDropOn(target);
    },
    onDragLeave: () => setDropOn((cur) => (cur === target ? null : cur)),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDropOn(null);
      const own = internalDrag;
      internalDrag = null;
      if (own && own.key === key) {
        mutate('history.libraryMove', (l) => moveItems(l, [own.itemId], folder));
        return;
      }
      const drag = peekDrag();
      endDrag();
      if (drag && !drag.insert && editable) addFromProject(drag.deviceId, drag.refs, folder);
    },
  });

  const tabbable = selected && rows.some((r) => r.id === selected) ? selected : rows[0]?.id;

  return (
    <div className="baa-library" data-testid={`library-${key}`}>
      <div className="baa-library-tools">
        <input
          type="search"
          value={query}
          placeholder={t('library.search')}
          aria-label={t('library.searchIn', { name: view.title })}
          onChange={(e) => setQuery(e.target.value)}
        />
        {editable ? (
          <>
            <button type="button" disabled={!hasDoc} onClick={addSelection}>
              {t('library.addSelection')}
            </button>
            <button type="button" onClick={() => newFolder(folderOf(selected))}>
              {t('library.newFolder')}
            </button>
          </>
        ) : null}
      </div>
      <ul
        role="tree"
        aria-label={view.title}
        aria-readonly={editable ? undefined : true}
        className={`baa-tree baa-library-tree${dropOn === '' ? ' baa-drop-target' : ''}`}
        ref={treeRef}
        {...dropProps('', '')}
      >
        {rows.length === 0 ? (
          <li className="baa-placeholder" role="none">
            {query.trim() === '' ? t('library.empty') : t('library.noMatch')}
          </li>
        ) : null}
        {rows.map((row, i) => {
          const isFolder = row.type === 'folder';
          const label = isFolder ? lastOf(row.path) : row.item.name;
          return (
            <li
              key={row.id}
              role="treeitem"
              data-testid={`library-row-${key}-${label}`}
              aria-level={row.level + 1}
              aria-selected={selected === row.id}
              aria-expanded={isFolder ? query.trim() !== '' || !collapsed.has(row.path) : undefined}
              tabIndex={row.id === tabbable ? 0 : -1}
              className={`baa-tree-node${dropOn === row.id ? ' baa-drop-target' : ''}`}
              style={{ paddingLeft: 6 + row.level * 16 }}
              title={isFolder ? undefined : row.item.comment || undefined}
              draggable={!isFolder && renaming !== row.id}
              onClick={() => setSelected(row.id)}
              onDoubleClick={() => {
                if (row.type === 'item') setViewing(row.item);
                else
                  setCollapsed((p) => {
                    const n = new Set(p);
                    if (n.has(row.path)) n.delete(row.path);
                    else n.add(row.path);
                    return n;
                  });
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setSelected(row.id);
                setMenu({ x: e.clientX, y: e.clientY, row });
              }}
              onKeyDown={(e) => onKeyDown(e, i)}
              onDragStart={(e) => {
                if (row.type !== 'item') return;
                const item = row.item;
                internalDrag = { key, itemId: item.id };
                beginInsertDrag(e.dataTransfer, item.name, (deviceId) =>
                  startInsert(item, deviceId),
                );
              }}
              onDragEnd={() => {
                internalDrag = null;
                endDrag();
              }}
              {...(isFolder ? dropProps(row.id, row.path) : {})}
            >
              <span className="baa-tree-twist" aria-hidden="true">
                {isFolder ? (collapsed.has(row.path) && query.trim() === '' ? '▸' : '▾') : ''}
              </span>
              <Icon name={isFolder ? 'objGroup' : iconOf(row.item)} size={16} />
              {renaming === row.id ? (
                <RenameInput
                  initial={label}
                  check={(name) =>
                    row.type === 'folder'
                      ? checkFolderName(lib, row.path, name)
                      : checkItemName(lib, row.item.id, name)
                  }
                  onCommit={(name) =>
                    mutate('history.libraryRename', (l) =>
                      row.type === 'folder'
                        ? renameFolder(l, row.path, name)
                        : renameItem(l, row.item.id, name),
                    )
                  }
                  onDone={() => setRenaming(null)}
                />
              ) : (
                <span className="baa-tree-label">{label}</span>
              )}
            </li>
          );
        })}
      </ul>
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={t('library.menuLabel')}
          items={menuItems(menu.row)}
          onClose={() => setMenu(null)}
          anchor={treeRef.current}
        />
      ) : null}
      {pending ? (
        <ConflictDialog
          item={pending.item}
          conflicts={pending.conflicts}
          onCancel={() => setPending(null)}
          onOk={(choices) => {
            setPending(null);
            doInsert(pending.item, pending.deviceId, choices);
          }}
        />
      ) : null}
      {viewing ? (
        <Dialog
          title={t('library.viewTitle', { name: viewing.name })}
          onClose={() => setViewing(null)}
          onOk={() => setViewing(null)}
          testId="library-view"
          footer={
            <button type="button" data-testid="dialog-ok" onClick={() => setViewing(null)}>
              {t('dialog.ok')}
            </button>
          }
        >
          {viewing.comment ? <p>{viewing.comment}</p> : null}
          <pre className="baa-library-source" tabIndex={0}>
            {itemText(viewing, mnemonic)}
          </pre>
        </Dialog>
      ) : null}
    </div>
  );
}

/** Sezione «Libreria di progetto» della task card Librerie. */
export function ProjectLibrary() {
  const { t } = useTranslation();
  const lib = useAppStore((s) => s.doc?.project.library);
  const hasDoc = useAppStore((s) => s.doc !== null);
  if (!hasDoc) return <p className="baa-placeholder">{t('library.noProject')}</p>;
  return (
    <LibraryTree
      view={{
        key: PROJECT_KEY,
        title: t('library.project'),
        library: lib ?? EMPTY,
        editable: true,
      }}
    />
  );
}

/** Sezione «Librerie globali»: la libreria standard IEC e i file `.baaplib` aperti. */
export function GlobalLibraries() {
  const { t } = useTranslation();
  const { bridge } = useServices();
  const globals = useGlobalLibraries();
  return (
    <div className="baa-library-list">
      <div className="baa-library-tools">
        <button type="button" onClick={() => void newGlobalLibrary(bridge)}>
          {t('library.newGlobal')}
        </button>
        <button type="button" onClick={() => void openGlobalLibrary(bridge)}>
          {t('library.openGlobal')}
        </button>
      </div>
      <section className="baa-reference">
        <header className="baa-reference-head">
          <strong>{t('library.iec')}</strong>
          <span className="baa-reference-path">{t('library.readOnly')}</span>
        </header>
        <LibraryTree
          view={{ key: IEC_KEY, title: t('library.iec'), library: iecLibrary(), editable: false }}
        />
      </section>
      {globals.map((g) => {
        const title = globalTitle(g);
        return (
          <section key={g.key} className="baa-reference" data-testid={`global-${title}`}>
            <header className="baa-reference-head">
              <strong>
                {title}
                {g.dirty ? ' *' : ''}
              </strong>
              <span className="baa-reference-path" title={g.path}>
                {g.editing ? t('library.editing') : t('library.readOnly')}
              </span>
              <button type="button" onClick={() => setGlobalEditing(g.key, !g.editing)}>
                {g.editing ? t('library.stopEditing') : t('library.edit')}
              </button>
              {g.dirty ? (
                <button type="button" onClick={() => void saveGlobalLibrary(bridge, g.key)}>
                  {t('library.save')}
                </button>
              ) : null}
              <button
                type="button"
                aria-label={t('library.close', { name: title })}
                title={t('library.close', { name: title })}
                onClick={() => void closeGlobalLibrary(bridge, g.key)}
              >
                ×
              </button>
            </header>
            <LibraryTree view={{ key: g.key, title, library: g.library, editable: g.editing }} />
          </section>
        );
      })}
    </div>
  );
}
