import {
  useCallback,
  useEffect,
  memo,
  useId,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { BaaBridge } from '../bridge';
import { copyToClipboard, readClipboard, type ClipboardPayload } from '../services/clipboard';
import { useServices } from '../state/AppContext';
import type { EditAction } from '../state/store';
import { useEditTarget } from '../state/useEditTarget';
import { CellEditor, type EditNav } from './CellEditor';
import './grid.css';

export interface GridColumn<R> {
  id: string;
  headerKey: string;
  /** Testo che spiega la colonna (suggerimento sull'intestazione). */
  headerTitleKey?: string;
  width: number;
  editor: 'text' | 'checkbox' | 'type' | 'none';
  get(row: R): string | boolean;
  readOnly?(row: R): boolean;
  /** Per 'type': elenco filtrato mentre si scrive. */
  suggestions?(row: R): string[];
}
export interface GridDiagnostic {
  severity: 'error' | 'warning';
  text: string;
}
export interface DataGridProps<R> {
  label: string;
  rows: R[];
  rowKey(row: R): string;
  columns: GridColumn<R>[];
  depth?(row: R): number;
  expandable?(row: R): boolean;
  expanded?: ReadonlySet<string>;
  onToggleExpand?(key: string): void;
  /** Righe di sezione: no. */
  rowSelectable?(row: R): boolean;
  onCommit(rowKey: string, columnId: string, value: string | boolean): void;
  /** Righe "<Aggiungi>": la griglia non crea righe da sola, chiama `onAdd`. */
  addRow?: {
    afterKey: string | null;
    labelKey: string;
    onAdd(columnId: string, value: string): void;
  }[];
  onDeleteRows?(keys: string[]): void;
  copyRows?(keys: string[]): { text: string; payload: ClipboardPayload };
  onPaste?(text: string, payload: ClipboardPayload | null, atKey: string | null): void;
  onFill?(sourceKey: string, count: number): void;
  diagnostic?(rowKey: string, columnId: string): GridDiagnostic | undefined;
  onRowDragStart?(keys: string[], e: DragEvent): void;
  onRowDragEnd?(): void;
  onDropOnRow?(e: DragEvent, rowKey: string | null): void;
  /** Se c'è, decide se il rilascio è ammesso (imposta `dropEffect` e fa `preventDefault`). */
  onDragOverRow?(e: DragEvent, rowKey: string | null): void;
  /** Classi in più per la riga o la cella (stile, non comportamento). */
  rowClassName?(row: R): string | undefined;
  cellClassName?(row: R, columnId: string): string | undefined;
  /** Chiede di selezionare una riga (dall'esterno, p.es. un risultato di ricerca); `n` la rende ripetibile. */
  reveal?: { key: string; n: number } | null;
  onRevealed?(n: number): void;
}

const PAGE = 10;
const INDENT = 16;
const NO_ROWS: never[] = [];

type Item<R> =
  { kind: 'data'; key: string; row: R; num: number } | { kind: 'add'; key: string; index: number };
interface Active {
  key: string;
  col: number;
}
interface Editing {
  key: string;
  col: number;
  /** Carattere che ha avviato la modifica (sostituisce il testo), o null con F2/Invio. */
  seed: string | null;
}

const addKey = (i: number) => `\u0000add:${i}`;

/** AltGr su Windows (Ctrl+Alt) e Opzione su macOS scrivono caratteri come @ # [ ]: non sono scorciatoie. */
function typesText(e: KeyboardEvent, platform: BaaBridge['platform']): boolean {
  if (e.key.length !== 1 || e.metaKey) return false;
  if (e.getModifierState('AltGraph')) return true;
  return platform === 'darwin' ? e.altKey && !e.ctrlKey : e.ctrlKey && e.altKey;
}

export function DataGrid<R>(props: DataGridProps<R>) {
  const {
    rows,
    rowKey,
    columns,
    onCommit,
    rowSelectable,
    onDeleteRows,
    copyRows,
    onPaste,
    onFill,
    addRow = NO_ROWS as NonNullable<DataGridProps<R>['addRow']>,
  } = props;
  const { t } = useTranslation();
  const { store, bridge } = useServices();
  const uid = useId();
  const gridRef = useRef<HTMLDivElement>(null);

  // Elenco di ciò che si vede: righe dati e righe "<Aggiungi>" dopo la riga indicata.
  const items = useMemo(() => {
    const after = new Map<string | null, number[]>();
    addRow.forEach((a, i) => {
      const k = a.afterKey;
      after.set(k, [...(after.get(k) ?? []), i]);
    });
    const known = new Set(rows.map(rowKey));
    const out: Item<R>[] = [];
    rows.forEach((row, n) => {
      const key = rowKey(row);
      out.push({ kind: 'data', key, row, num: n + 1 });
      for (const i of after.get(key) ?? []) out.push({ kind: 'add', key: addKey(i), index: i });
    });
    addRow.forEach((a, i) => {
      if (a.afterKey === null || !known.has(a.afterKey))
        out.push({ kind: 'add', key: addKey(i), index: i });
    });
    return out;
  }, [rows, rowKey, addRow]);
  const indexOf = useMemo(() => new Map(items.map((it, i) => [it.key, i])), [items]);

  const [active, setActive] = useState<Active | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [fill, setFillState] = useState<{ src: string; to: number } | null>(null);
  const fillRef = useRef(fill);
  const setFill = (f: { src: string; to: number } | null) => {
    fillRef.current = f;
    setFillState(f);
  };
  // Dopo certi cambi (tastiera, selezione, fine modifica) il focus va alla cella attiva.
  const [focusTick, setFocusTick] = useState(0);
  const requestFocus = () => setFocusTick((n) => n + 1);

  // La cella attiva sopravvive alla scomparsa della sua riga: si resta sulla stessa posizione.
  const lastIdx = useRef(0);
  const resolved = useMemo(() => {
    if (items.length === 0 || columns.length === 0) return null;
    const col = Math.min(active?.col ?? 0, columns.length - 1);
    const found = active ? indexOf.get(active.key) : undefined;
    const idx = found ?? Math.min(active ? lastIdx.current : 0, items.length - 1);
    return { idx, col };
  }, [active, items, indexOf, columns.length]);
  lastIdx.current = resolved?.idx ?? 0;
  const activeItem = resolved ? items[resolved.idx]! : null;

  const selectableItem = (it: Item<R>): it is Extract<Item<R>, { kind: 'data' }> =>
    it.kind === 'data' && (rowSelectable ? rowSelectable(it.row) : true);

  const selKeys = items
    .filter((it) => selectableItem(it) && selected.has(it.key))
    .map((it) => it.key);
  const actionKeys =
    selKeys.length > 0 ? selKeys : activeItem && selectableItem(activeItem) ? [activeItem.key] : [];

  const can: Partial<Record<EditAction, boolean>> = {
    copy: !!copyRows && actionKeys.length > 0,
    cut: !!copyRows && actionKeys.length > 0,
    paste: !!onPaste,
    delete: !!onDeleteRows && actionKeys.length > 0,
    rename: false,
    selectAll: true,
  };
  const run = async (action: EditAction) => {
    const doCopy = () => {
      const c = copyRows!(actionKeys);
      copyToClipboard(bridge, c.text, c.payload);
    };
    switch (action) {
      case 'copy':
        if (can.copy) doCopy();
        return;
      case 'cut':
        if (can.cut) {
          doCopy();
          onDeleteRows?.(actionKeys);
          setSelected(new Set());
          requestFocus();
        }
        return;
      case 'delete':
        if (can.delete) {
          onDeleteRows!(actionKeys);
          setSelected(new Set());
          requestFocus();
        }
        return;
      case 'paste': {
        if (!onPaste) return;
        const c = await readClipboard(bridge);
        onPaste(c.text, c.payload, activeItem?.kind === 'data' ? activeItem.key : null);
        return;
      }
      case 'selectAll':
        setSelected(new Set(items.filter(selectableItem).map((it) => it.key)));
    }
  };
  // Il bersaglio non vale durante la modifica: lì Mod+C/V spettano al campo di testo.
  // Un id per griglia: con i riquadri divisi due griglie non devono togliersi la destinazione.
  const focusProps = useEditTarget(store, `grid${uid}`, gridRef, can, run, editing !== null);

  const cellEl = useCallback((key: string, col: number): HTMLElement | null => {
    const colEl = (r: Element) => r.querySelectorAll<HTMLElement>('[data-col-id]')[col] ?? null;
    for (const r of gridRef.current?.querySelectorAll('[data-row-key]') ?? [])
      if ((r as HTMLElement).dataset.rowKey === key) return colEl(r);
    return null;
  }, []);
  useEffect(() => {
    if (focusTick === 0 || !resolved || editing) return;
    const it = items[resolved.idx]!;
    cellEl(it.key, resolved.col)?.focus();
    // Solo a una richiesta esplicita di focus.
  }, [focusTick]);

  // Una richiesta esterna seleziona la riga e la porta in vista; si esegue una volta sola.
  useEffect(() => {
    const r = props.reveal;
    if (!r) return;
    if (indexOf.has(r.key)) {
      setSelected(new Set([r.key]));
      anchor.current = r.key;
      setActive({ key: r.key, col: 0 });
      requestAnimationFrame(() =>
        [...(gridRef.current?.querySelectorAll<HTMLElement>('[data-row-key]') ?? [])]
          .find((el) => el.dataset.rowKey === r.key)
          ?.scrollIntoView?.({ block: 'nearest' }),
      );
    }
    props.onRevealed?.(r.n);
    // Solo alla richiesta, non a ogni ridisegno.
  }, [props.reveal]);

  const goTo = (idx: number, col: number) => {
    const it = items[Math.max(0, Math.min(items.length - 1, idx))];
    if (!it) return;
    setActive({ key: it.key, col: Math.max(0, Math.min(columns.length - 1, col)) });
    requestFocus();
  };

  const editableCell = (it: Item<R>, col: number): boolean => {
    const c = columns[col];
    if (!c || (c.editor !== 'text' && c.editor !== 'type')) return false;
    return it.kind === 'add' || !c.readOnly?.(it.row);
  };
  const startEdit = (it: Item<R>, col: number, seed: string | null) => {
    if (!editableCell(it, col)) return;
    setActive({ key: it.key, col });
    setEditing({ key: it.key, col, seed });
  };
  const toggleCheckbox = (it: Item<R>, col: number) => {
    const c = columns[col];
    if (it.kind !== 'data' || !c || c.editor !== 'checkbox' || c.readOnly?.(it.row)) return;
    onCommit(it.key, c.id, !c.get(it.row));
  };

  const finishEdit = (value: string, nav: EditNav) => {
    if (!editing || !resolved) return;
    const it = items[indexOf.get(editing.key) ?? -1];
    const col = columns[editing.col];
    setEditing(null);
    if (!it || !col) return;
    let added = false;
    if (it.kind === 'add') {
      if (value.trim() !== '') {
        addRow[it.index]?.onAdd(col.id, value);
        added = true;
      }
    } else if (value !== String(col.get(it.row))) onCommit(it.key, col.id, value);
    if (nav === 'blur') return;
    const idx = indexOf.get(editing.key) ?? 0;
    if (added || nav === 'stay') setActive({ key: it.key, col: editing.col });
    else if (nav === 'down') goTo(idx + 1, editing.col);
    else if (nav === 'right' || nav === 'left') {
      const dc = nav === 'right' ? 1 : -1;
      const c = editing.col + dc;
      // Oltre l'ultima colonna si passa alla riga seguente, prima della prima alla precedente.
      if (c >= columns.length) goTo(idx + 1, 0);
      else if (c < 0) goTo(idx - 1, columns.length - 1);
      else goTo(idx, c);
      return;
    }
    requestFocus();
  };

  const selectRow = (key: string, e: MouseEvent) => {
    const i = indexOf.get(key);
    const it = i === undefined ? undefined : items[i];
    if (!it || !selectableItem(it)) return;
    if (e.shiftKey && anchor.current !== null && indexOf.has(anchor.current)) {
      const a = indexOf.get(anchor.current)!;
      const [lo, hi] = a < i! ? [a, i!] : [i!, a];
      setSelected(
        new Set(
          items
            .slice(lo, hi + 1)
            .filter(selectableItem)
            .map((x) => x.key),
        ),
      );
    } else if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      if (!next.delete(key)) next.add(key);
      setSelected(next);
      anchor.current = key;
    } else {
      setSelected(new Set([key]));
      anchor.current = key;
    }
    setActive({ key, col: resolved?.col ?? 0 });
    requestFocus();
  };

  // --- Eventi delegati: una sola copia dei gestori per tutta la griglia ---
  const rowOf = (el: EventTarget | null) =>
    (el as HTMLElement | null)?.closest<HTMLElement>('[data-row-key]')?.dataset.rowKey ?? null;
  const colOf = (el: EventTarget | null) => {
    const id = (el as HTMLElement | null)?.closest<HTMLElement>('[data-col-id]')?.dataset.colId;
    return id === undefined ? -1 : columns.findIndex((c) => c.id === id);
  };
  const itemOf = (key: string | null) => (key === null ? undefined : items[indexOf.get(key) ?? -1]);

  const onFocus = (e: React.FocusEvent<HTMLDivElement>) => {
    focusProps.onFocus();
    const el = e.target as HTMLElement;
    if (el.dataset.colId === undefined) return;
    const key = rowOf(el);
    const col = colOf(el);
    if (key !== null && col >= 0 && (active?.key !== key || active.col !== col))
      setActive({ key, col });
  };
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const key = rowOf(target);
    if (key === null) return;
    if (target.closest('[data-rownum]')) return selectRow(key, e);
    const it = itemOf(key);
    if (!it) return;
    if (target.closest('[data-expander]')) return props.onToggleExpand?.(key);
    const col = colOf(target);
    if (target.closest('[data-checkbox]')) return toggleCheckbox(it, col);
    if (selected.size > 0 && !target.closest('input')) setSelected(new Set());
  };
  const onDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('input,[data-rownum],[data-expander],[data-checkbox]')) return;
    const it = itemOf(rowOf(target));
    const col = colOf(target);
    if (it && col >= 0) startEdit(it, col, null);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || !resolved || !activeItem) return;
    if ((e.ctrlKey || e.metaKey || e.altKey) && !typesText(e, bridge.platform)) return;
    if (colOf(target) < 0) return;
    const { idx, col } = resolved;
    const c = columns[col]!;
    const first = col === 0;
    const row = activeItem.kind === 'data' ? activeItem.row : null;
    const expandable = row !== null && !!props.expandable?.(row) && first;
    const isOpen = expandable && !!props.expanded?.has(activeItem.key);
    const stop = () => e.preventDefault();
    switch (e.key) {
      case 'ArrowDown':
        return (stop(), goTo(idx + 1, col));
      case 'ArrowUp':
        return (stop(), goTo(idx - 1, col));
      case 'ArrowRight':
        if (expandable && !isOpen) return (stop(), props.onToggleExpand?.(activeItem.key));
        return (stop(), goTo(idx, col + 1));
      case 'ArrowLeft':
        if (isOpen) return (stop(), props.onToggleExpand?.(activeItem.key));
        return (stop(), goTo(idx, col - 1));
      case 'Home':
        return (stop(), goTo(idx, 0));
      case 'End':
        return (stop(), goTo(idx, columns.length - 1));
      case 'PageDown':
        return (stop(), goTo(idx + PAGE, col));
      case 'PageUp':
        return (stop(), goTo(idx - PAGE, col));
      case 'Enter':
      case 'F2':
        return (stop(), startEdit(activeItem, col, null));
    }
    if (e.key === ' ' && c.editor === 'checkbox') return (stop(), toggleCheckbox(activeItem, col));
    if (e.key.length === 1) {
      // Un carattere stampabile avvia la modifica sostituendo il testo.
      if (editableCell(activeItem, col)) {
        stop();
        startEdit(activeItem, col, e.key);
      }
    }
  };

  // --- Riempimento automatico ---
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!(e.target as HTMLElement).closest('[data-fill-handle]') || !activeItem) return;
    setFill({ src: activeItem.key, to: resolved!.idx });
  };
  const onPointerOver = (e: PointerEvent<HTMLDivElement>) => {
    if (!fillRef.current) return;
    const i = indexOf.get(rowOf(e.target) ?? '');
    if (i !== undefined && fillRef.current.to !== i) setFill({ ...fillRef.current, to: i });
  };
  const filling = fill !== null;
  // Il riempimento si ferma alla prima riga "<Aggiungi>", che conta una volta sola.
  const fillLimit = (src: number, to: number) => {
    for (let i = src + 1; i <= to; i++) if (items[i]?.kind === 'add') return i;
    return to;
  };
  const fillLimitRef = useRef(fillLimit);
  fillLimitRef.current = fillLimit;
  useEffect(() => {
    if (!filling) return;
    const end = () => {
      const f = fillRef.current;
      setFill(null);
      const src = f ? (indexOf.get(f.src) ?? f.to) : 0;
      const count = f ? fillLimitRef.current(src, f.to) - src : 0;
      if (f && count > 0) onFill?.(f.src, count);
    };
    const abort = () => setFill(null);
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && abort();
    // La griglia può stare in una finestra separata: si ascolta la sua finestra.
    const view = gridRef.current?.ownerDocument.defaultView ?? window;
    view.addEventListener('pointerup', end);
    view.addEventListener('pointercancel', abort);
    view.addEventListener('keydown', onKey);
    return () => {
      view.removeEventListener('pointerup', end);
      view.removeEventListener('pointercancel', abort);
      view.removeEventListener('keydown', onKey);
    };
  }, [filling, indexOf, onFill]);
  const fillFrom = fill ? (indexOf.get(fill.src) ?? 0) : 0;
  const fillTo = fill ? fillLimit(fillFrom, fill.to) : 0;

  // --- Trascinamento di righe ---
  const onDragStart = (e: ReactDragEvent<HTMLDivElement>) => {
    const key = rowOf(e.target);
    if (key === null || !props.onRowDragStart) return;
    props.onRowDragStart(selKeys.includes(key) ? selKeys : [key], e.nativeEvent);
  };

  // Per ogni riga si calcolano i dati "per cella" (diagnostica, classi, rientro): se sono uguali
  // a quelli del disegno precedente si riusa lo stesso oggetto, così la riga non si ridisegna.
  const metaCache = useRef(new Map<string, RowMeta>());
  const nextMeta = new Map<string, RowMeta>();
  const metaFor = (key: string, row: R | null, canOpen: boolean): RowMeta => {
    const fresh: RowMeta =
      row === null
        ? EMPTY_META
        : {
            diags: columns.map((c) => props.diagnostic?.(key, c.id)),
            cellCls: columns.map((c) => props.cellClassName?.(row, c.id)),
            rowCls: props.rowClassName?.(row),
            depth: props.depth?.(row) ?? 0,
            canOpen,
            open: canOpen && !!props.expanded?.has(key),
          };
    const prev = metaCache.current.get(key);
    const meta = prev && sameMeta(prev, fresh) ? prev : fresh;
    nextMeta.set(key, meta);
    return meta;
  };
  useEffect(() => {
    metaCache.current = nextMeta;
  });

  // Gestori stabili per le righe: leggono sempre l'ultimo stato tramite un riferimento.
  const latest = useRef({ finishEdit });
  latest.current = { finishEdit };
  const onEditDone = useCallback(
    (value: string, nav: EditNav) => latest.current.finishEdit(value, nav),
    [],
  );
  const onEditCancel = useCallback(() => {
    setEditing(null);
    setFocusTick((n) => n + 1);
  }, []);

  const widths = `34px ${columns.map((c) => `${c.width}px`).join(' ')}`;
  const total = 34 + columns.reduce((n, c) => n + c.width, 0);

  return (
    <div
      ref={gridRef}
      role="grid"
      aria-label={props.label}
      aria-multiselectable="true"
      className="baa-grid"
      style={{ ['--baa-grid-cols' as string]: widths, minWidth: total }}
      onFocus={onFocus}
      onBlur={focusProps.onBlur}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerOver={onPointerOver}
      onMouseDown={(e) =>
        (e.target as HTMLElement).closest('[data-fill-handle],[data-expander]') &&
        e.preventDefault()
      }
      onDragStart={onDragStart}
      onDragEnd={props.onRowDragEnd}
      onDragOver={
        props.onDragOverRow
          ? (e) => props.onDragOverRow!(e.nativeEvent, rowOf(e.target))
          : props.onDropOnRow
            ? (e) => e.preventDefault()
            : undefined
      }
      onDrop={
        props.onDropOnRow
          ? (e) => {
              e.preventDefault();
              props.onDropOnRow!(e.nativeEvent, rowOf(e.target));
            }
          : undefined
      }
    >
      <div role="row" className="baa-grid-row baa-grid-head">
        <div role="columnheader" className="baa-grid-rownum" aria-label={t('grid.rowNumber')} />
        {columns.map((c) => (
          <div
            key={c.id}
            role="columnheader"
            className="baa-grid-cell"
            title={c.headerTitleKey ? t(c.headerTitleKey) : undefined}
          >
            {t(c.headerKey)}
          </div>
        ))}
      </div>
      {items.map((it, i) => {
        const isData = it.kind === 'data';
        const selectable = isData && selectableItem(it);
        const covered = fill !== null && i > fillFrom && i <= fillTo;
        const row = isData ? it.row : null;
        const canOpen = row !== null && !!props.expandable?.(row);
        return (
          <GridRow<R>
            key={it.key}
            itemKey={it.key}
            row={row}
            num={isData ? it.num : 0}
            addLabel={it.kind === 'add' ? t(addRow[it.index]!.labelKey) : null}
            addIndex={it.kind === 'add' ? it.index : -1}
            columns={columns}
            activeCol={resolved?.idx === i ? resolved.col : -1}
            selectable={selectable}
            selected={selectable && selected.has(it.key)}
            covered={covered}
            editing={editing?.key === it.key ? editing : null}
            meta={metaFor(it.key, row, canOpen)}
            draggable={isData && !!props.onRowDragStart}
            showFill={!!onFill}
            uid={uid}
            t={t}
            onDone={onEditDone}
            onCancel={onEditCancel}
          />
        );
      })}
    </div>
  );
}

interface RowMeta {
  diags: (GridDiagnostic | undefined)[];
  cellCls: (string | undefined)[];
  rowCls: string | undefined;
  depth: number;
  canOpen: boolean;
  open: boolean;
}
const EMPTY_META: RowMeta = {
  diags: [],
  cellCls: [],
  rowCls: undefined,
  depth: 0,
  canOpen: false,
  open: false,
};
const sameList = <T,>(a: T[], b: T[], eq: (x: T, y: T) => boolean) =>
  a.length === b.length && a.every((x, i) => eq(x, b[i]!));
const sameDiag = (a: GridDiagnostic | undefined, b: GridDiagnostic | undefined) =>
  a === b || (!!a && !!b && a.severity === b.severity && a.text === b.text);
const sameMeta = (a: RowMeta, b: RowMeta) =>
  a.rowCls === b.rowCls &&
  a.depth === b.depth &&
  a.canOpen === b.canOpen &&
  a.open === b.open &&
  sameList(a.diags, b.diags, sameDiag) &&
  sameList(a.cellCls, b.cellCls, Object.is);

interface GridRowProps<R> {
  itemKey: string;
  /** null per le righe "<Aggiungi>". */
  row: R | null;
  num: number;
  addLabel: string | null;
  addIndex: number;
  columns: GridColumn<R>[];
  /** Colonna attiva di questa riga, -1 se la cella attiva è altrove. */
  activeCol: number;
  selectable: boolean;
  selected: boolean;
  covered: boolean;
  /** Solo per la riga in modifica, altrimenti null. */
  editing: Editing | null;
  meta: RowMeta;
  draggable: boolean;
  showFill: boolean;
  uid: string;
  t: TFunction;
  onDone(value: string, nav: EditNav): void;
  onCancel(): void;
}

/** Una riga della griglia: si ridisegna solo se cambiano le sue proprietà (React.memo). */
function GridRowImpl<R>(p: GridRowProps<R>) {
  const { row, columns, meta, editing, t } = p;
  const isData = row !== null;
  return (
    <div
      role="row"
      data-row-key={p.itemKey}
      aria-selected={p.selectable ? p.selected : undefined}
      className={
        'baa-grid-row' +
        (p.selected ? ' is-selected' : '') +
        (p.covered ? ' is-fill-target' : '') +
        (isData ? '' : ' is-add') +
        (meta.rowCls ? ` ${meta.rowCls}` : '')
      }
    >
      <div role="rowheader" data-rownum="" className="baa-grid-rownum" draggable={p.draggable}>
        {isData ? p.num : ''}
      </div>
      {columns.map((c, ci) => {
        const isActive = p.activeCol === ci;
        const isEditing = editing !== null && editing.col === ci;
        const diag = meta.diags[ci];
        const diagId = `${p.uid}-d${encodeURIComponent(p.itemKey)}-${ci}`;
        const value = isData ? c.get(row) : '';
        const editable =
          (c.editor === 'text' || c.editor === 'type') && (!isData || !c.readOnly?.(row));
        const readOnly = !editable && c.editor !== 'checkbox';
        const label = t(c.headerKey);
        const cellCls = meta.cellCls[ci];
        return (
          <div
            key={c.id}
            role="gridcell"
            data-col-id={c.id}
            tabIndex={isActive ? 0 : -1}
            aria-readonly={readOnly || undefined}
            aria-describedby={diag ? diagId : undefined}
            title={diag?.text}
            className={
              'baa-grid-cell' +
              (diag ? ` is-${diag.severity}` : '') +
              (isActive ? ' is-active' : '') +
              (isEditing ? ' is-editing' : '') +
              (cellCls ? ` ${cellCls}` : '')
            }
          >
            <span
              className="baa-grid-content"
              data-indent={ci === 0 ? '' : undefined}
              style={ci === 0 ? { paddingLeft: meta.depth * INDENT } : undefined}
            >
              {ci === 0 && isData ? (
                meta.canOpen ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    data-expander=""
                    className={'baa-grid-expander' + (meta.open ? ' is-open' : '')}
                    aria-expanded={meta.open}
                    aria-label={t(meta.open ? 'grid.collapse' : 'grid.expand')}
                  />
                ) : (
                  <span className="baa-grid-expander-spacer" />
                )
              ) : null}
              {isEditing ? (
                <CellEditor
                  initial={editing.seed ?? String(value)}
                  selectAll={editing.seed === null}
                  listId={`${p.uid}-l`}
                  label={label}
                  {...(c.editor === 'type' && isData
                    ? { suggestions: c.suggestions?.(row) ?? [] }
                    : {})}
                  onDone={p.onDone}
                  onCancel={p.onCancel}
                />
              ) : c.editor === 'checkbox' && isData ? (
                <span
                  role="checkbox"
                  data-checkbox=""
                  aria-checked={value === true}
                  aria-label={label}
                  className={'baa-grid-check' + (value === true ? ' is-checked' : '')}
                />
              ) : ci === 0 && p.addLabel !== null ? (
                <span className="baa-grid-add">{p.addLabel}</span>
              ) : (
                <span className="baa-grid-text">{String(value)}</span>
              )}
            </span>
            {diag ? (
              <>
                <span className="baa-grid-diag" aria-hidden="true" />
                <span id={diagId} className="baa-grid-sr">
                  {diag.text}
                </span>
              </>
            ) : null}
            {isActive && !isEditing && p.showFill && isData ? (
              <span
                data-fill-handle=""
                className="baa-grid-fill"
                title={t('grid.fillHandle')}
                aria-hidden="true"
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
const GridRow = memo(GridRowImpl) as typeof GridRowImpl;
