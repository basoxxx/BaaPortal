// Editor grafico di un segmento KOP: componente controllato, non modifica mai `net`.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BOX_CATALOG,
  PALETTE,
  addOutput,
  closeBranchAfter,
  findElem,
  insertElem,
  openBranch,
  removeElem,
  updateElem,
} from '@baaportal/ladfbd';
import type {
  BoxGroup,
  BoxKind,
  InsertPoint,
  LadElem,
  LadNetwork,
  LadOut,
} from '@baaportal/ladfbd';
import { CELL_H, CELL_W, LadElement } from './LadElement';
import { LAD_TOOL_KEYS, ladAction } from './ladKeys';
import type { LadAction } from './ladKeys';
import { layoutNetwork } from './ladLayout';
import type { LadCell } from './ladLayout';
import {
  fieldPatch,
  fieldValue,
  fieldsOf,
  findNodeById,
  newBox,
  nodeOfPoint,
  placeOf,
} from './ladOps';
import './lad.css';

export const LAD_DRAG_TYPE = 'application/x-baaportal-lad';
const HISTORY_KEY = 'history.editLad';
const PAD = 12;

type Selection = { t: 'elem'; id: string } | { t: 'slot'; at: InsertPoint } | null;
type Editing = { id: string; field: number; value: string };

type Props = {
  net: LadNetwork;
  index: number;
  diagnostics: Map<string, string[]>;
  readOnly: boolean;
  onChange: (next: LadNetwork, labelKey: string) => void;
  /** Generatore di id; di norma `crypto.randomUUID`. */
  newId?: () => string;
};

const defaultId = () => globalThis.crypto.randomUUID();
const BOX_GROUPS = Object.values(BOX_CATALOG).reduce<Map<BoxGroup, BoxKind[]>>((m, d) => {
  m.set(d.group, [...(m.get(d.group) ?? []), d.kind]);
  return m;
}, new Map());

/** Cella più vicina a `from` nella direzione data (coordinate del centro). */
function neighbour(cells: LadCell[], from: LadCell, dir: 'left' | 'right' | 'up' | 'down') {
  const c = (x: LadCell) => [x.col + x.w / 2, x.row + x.h / 2] as const;
  const [fx, fy] = c(from);
  let best: LadCell | undefined;
  let bestScore = Infinity;
  for (const x of cells) {
    if (x === from) continue;
    const [cx, cy] = c(x);
    const dx = cx - fx;
    const dy = cy - fy;
    const [main, side] = dir === 'left' || dir === 'right' ? [dx, dy] : [dy, dx];
    const sign = dir === 'left' || dir === 'up' ? -1 : 1;
    if (main * sign <= 0) continue;
    const score = Math.abs(side) * 4 + Math.abs(main);
    if (score < bestScore) {
      bestScore = score;
      best = x;
    }
  }
  return best;
}

export function LadNetworkEditor({
  net,
  index,
  diagnostics,
  readOnly,
  onChange,
  newId = defaultId,
}: Props) {
  const { t } = useTranslation();
  const layout = useMemo(() => layoutNetwork(net), [net]);
  const [sel, setSel] = useState<Selection>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [status, setStatus] = useState('');
  const [menu, setMenu] = useState(false);
  const canvas = useRef<HTMLDivElement>(null);
  const openBranchId = useRef<string | null>(null);
  const wantFocus = useRef(false);
  const finished = useRef(false);

  // Dopo un'azione da tastiera o dalla barra, il fuoco segue la selezione appena la rete è aggiornata.
  useEffect(() => {
    if (!wantFocus.current || editing) return;
    if (!sel) {
      wantFocus.current = false;
      canvas.current?.focus();
      return;
    }
    if (sel.t === 'slot') {
      wantFocus.current = false;
      canvas.current?.focus();
      return;
    }
    const el = canvas.current?.querySelector<HTMLElement>(`[data-lad-id="${sel.id}"]`);
    if (el) {
      wantFocus.current = false;
      el.focus();
    }
  });

  const elemOf = (id: string) => findElem(net, id) as (LadElem | LadOut) | undefined;
  const rootId = net.root.id;

  /** Dove inserire: dopo la selezione, nel punto scelto o in fondo alla serie principale. */
  function target(): { at: InsertPoint; nodeId: string } {
    if (sel?.t === 'slot') {
      return { at: sel.at, nodeId: nodeOfPoint(net, sel.at) ?? rootId };
    }
    if (sel?.t === 'elem') {
      const p = placeOf(net, sel.id);
      if (p?.t === 'elem') return { at: p.at(p.index + 1), nodeId: p.nodeId };
      if (p?.t === 'out') {
        const len = findNodeById(net.root, p.nodeId)?.series.length ?? 0;
        return { at: { node: p.nodeId, index: len }, nodeId: p.nodeId };
      }
    }
    return { at: { node: rootId, index: net.root.series.length }, nodeId: rootId };
  }

  /** Esegue una modifica: una sola chiamata a `onChange`, oppure un messaggio se non è possibile. */
  function apply(make: () => LadNetwork, next?: Selection) {
    let result: LadNetwork;
    try {
      result = make();
    } catch {
      setStatus(t('lad.cannotDo'));
      return false;
    }
    setStatus('');
    onChange(result, HISTORY_KEY);
    if (next !== undefined) setSel(next);
    wantFocus.current = true;
    return true;
  }

  function insertNew(elem: LadElem) {
    const { at } = target();
    apply(() => insertElem(net, at, elem), { t: 'elem', id: elem.id });
  }

  function addContact(neg: boolean) {
    insertNew({ id: newId(), k: 'contact', neg, op: '' });
  }

  function addCoil() {
    const { nodeId } = target();
    const node = findNodeById(net.root, nodeId);
    const empty = node?.outs.find((o) => !('series' in o) && o.k === 'coil' && o.op === '');
    if (empty) {
      setSel({ t: 'elem', id: empty.id });
      wantFocus.current = true;
      setStatus('');
      return;
    }
    const out: LadOut = { id: newId(), k: 'coil', op: '' };
    apply(() => addOutput(net, nodeId, out), { t: 'elem', id: out.id });
  }
  function doOpenBranch() {
    if (sel?.t !== 'elem' || placeOf(net, sel.id)?.t !== 'elem') return;
    const id = sel.id;
    let last = '';
    const gen = () => (last = newId());
    const ok = apply(() => openBranch(net, id, gen));
    if (ok) {
      openBranchId.current = last;
      setSel({ t: 'elem', id: last });
    }
  }

  function doCloseBranch() {
    const from = openBranchId.current;
    if (sel?.t !== 'elem' || !from || !findElem(net, from)) {
      setStatus(t('lad.cannotClose'));
      return;
    }
    const to = sel.id;
    try {
      const next = closeBranchAfter(net, from, to, newId);
      setStatus('');
      openBranchId.current = null;
      onChange(next, HISTORY_KEY);
      wantFocus.current = true;
    } catch {
      setStatus(t('lad.cannotClose'));
    }
  }

  function doDelete() {
    if (sel?.t !== 'elem' || sel.id === rootId) return;
    const id = sel.id;
    apply(() => removeElem(net, id, newId), null);
  }

  function startEdit(id: string, field = 0) {
    if (readOnly) return;
    const e = elemOf(id);
    if (!e) return;
    const fld = fieldsOf(e)[field];
    if (!fld) return;
    finished.current = false;
    setEditing({ id, field, value: fieldValue(e, fld) });
  }

  function commitEdit(advance: boolean) {
    if (!editing || finished.current) return;
    finished.current = true;
    const e = elemOf(editing.id);
    const flds = e ? fieldsOf(e) : [];
    const fld = flds[editing.field];
    const value = editing.value.replace(/[\r\n]+/g, ' ');
    const next = advance && editing.field + 1 < flds.length ? editing.field + 1 : -1;
    setEditing(null);
    wantFocus.current = true;
    if (e && fld && value !== fieldValue(e, fld)) {
      apply(() => updateElem(net, editing.id, fieldPatch(e, fld, value)));
    }
    if (next >= 0) {
      const id = editing.id;
      // Il campo successivo si apre dopo che la rete aggiornata è arrivata.
      queueMicrotask(() => {
        finished.current = false;
        const cur = elemOf(id);
        const f2 = cur && fieldsOf(cur)[next];
        if (cur && f2) setEditing({ id, field: next, value: fieldValue(cur, f2) });
      });
    }
  }

  function cancelEdit() {
    finished.current = true;
    setEditing(null);
    wantFocus.current = true;
  }

  function move(dir: 'left' | 'right' | 'up' | 'down') {
    const cells = layout.cells;
    if (cells.length === 0) return;
    const cur = sel?.t === 'elem' ? cells.find((c) => c.elemId === sel.id) : undefined;
    const to = cur ? neighbour(cells, cur, dir) : cells[0];
    if (to) {
      setSel({ t: 'elem', id: to.elemId });
      wantFocus.current = true;
    }
  }

  function run(a: LadAction) {
    if (a === 'left' || a === 'right' || a === 'up' || a === 'down') return move(a);
    if (readOnly) return;
    if (a === 'contactNo') addContact(false);
    else if (a === 'contactNc') addContact(true);
    else if (a === 'coil') addCoil();
    else if (a === 'openBranch') doOpenBranch();
    else if (a === 'closeBranch') doCloseBranch();
    else if (a === 'delete') doDelete();
    else if (a === 'edit' && sel?.t === 'elem') startEdit(sel.id);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const a = ladAction(e);
    if (!a) return;
    if (a === 'edit' && sel?.t !== 'elem') return;
    e.preventDefault();
    run(a);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    const raw = e.dataTransfer.getData(LAD_DRAG_TYPE);
    if (!raw || readOnly) return;
    e.preventDefault();
    let payload: { palette?: string; box?: BoxKind };
    try {
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX || 0) - rect.left - PAD;
    const y = (e.clientY || 0) - rect.top - PAD;
    let best: (typeof layout.slots)[number] | undefined;
    let bestD = Infinity;
    for (const s of layout.slots) {
      const d = (s.col * CELL_W - x) ** 2 + (s.row * CELL_H + CELL_H / 2 - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    if (!best) return;
    const at = best.at;
    if (payload.box && payload.box in BOX_CATALOG) {
      const b = newBox(payload.box, newId());
      apply(() => insertElem(net, at, b), { t: 'elem', id: b.id });
      return;
    }
    const entry = PALETTE.find((p) => p.id === payload.palette);
    if (!entry) return;
    const el = { id: newId(), ...structuredClone(entry.preset) };
    if (entry.where === 'out') {
      const nodeId = nodeOfPoint(net, at) ?? rootId;
      apply(() => addOutput(net, nodeId, el as LadOut), { t: 'elem', id: el.id });
    } else apply(() => insertElem(net, at, el as LadElem), { t: 'elem', id: el.id });
  }

  const editCell = editing ? layout.cells.find((c) => c.elemId === editing.id) : undefined;
  const editElem = editing ? elemOf(editing.id) : undefined;
  const editField = editElem ? fieldsOf(editElem)[editing!.field] : undefined;
  const width = layout.cols * CELL_W;
  const height = layout.rows * CELL_H;
  const tools: { key: keyof typeof LAD_TOOL_KEYS; run: () => void }[] = [
    { key: 'contactNo', run: () => addContact(false) },
    { key: 'contactNc', run: () => addContact(true) },
    { key: 'coil', run: addCoil },
    { key: 'openBranch', run: doOpenBranch },
    { key: 'closeBranch', run: doCloseBranch },
  ];

  return (
    <div className="baa-lad">
      {index === 0 && (
        <div className="baa-lad-toolbar" role="toolbar" aria-label={t('lad.toolbar')}>
          {tools.map((tool) => (
            <button
              key={tool.key}
              type="button"
              disabled={readOnly}
              title={`${t(`lad.tool.${tool.key}`)} (${LAD_TOOL_KEYS[tool.key]})`}
              onClick={tool.run}
            >
              {t(`lad.tool.${tool.key}`)}
            </button>
          ))}
          <span className="baa-lad-menu-wrap">
            <button
              type="button"
              disabled={readOnly}
              aria-haspopup="menu"
              aria-expanded={menu}
              onClick={() => setMenu((m) => !m)}
            >
              {t('lad.tool.box')} ▾
            </button>
            {menu && (
              <div className="baa-lad-menu" role="menu" aria-label={t('lad.boxMenu')}>
                {[...BOX_GROUPS].map(([group, kinds]) => (
                  <div key={group} role="group" aria-label={t(`lad.group.${group}`)}>
                    <div className="baa-lad-menu-head">{t(`lad.group.${group}`)}</div>
                    {kinds.map((k) => (
                      <button
                        key={k}
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMenu(false);
                          insertNew(newBox(k, newId()));
                        }}
                      >
                        {t(`lad.box.${k}`)}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </span>
        </div>
      )}
      <div
        ref={canvas}
        className="baa-lad-canvas"
        role="group"
        aria-label={t('lad.network', { n: index + 1 })}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onClick={(e) => {
          if (
            e.target === e.currentTarget ||
            (e.target as HTMLElement).closest('svg.baa-lad-wires')
          )
            setSel(null);
        }}
        onDragOver={(e) => {
          if (!readOnly && e.dataTransfer.types.includes(LAD_DRAG_TYPE)) e.preventDefault();
        }}
        onDrop={onDrop}
      >
        <div className="baa-lad-grid" style={{ width: width + 2 * PAD, height: height + 2 * PAD }}>
          <div className="baa-lad-plane" style={{ left: PAD, top: PAD, width, height }}>
            <svg className="baa-lad-wires" width={width} height={height} aria-hidden="true">
              <line className="baa-lad-rail" x1={1} y1={0} x2={1} y2={height} />
              {layout.wires.map((w, i) => (
                <line
                  key={i}
                  x1={w.from[0] * CELL_W}
                  y1={w.from[1] * CELL_H + CELL_H / 2}
                  x2={w.to[0] * CELL_W}
                  y2={w.to[1] * CELL_H + CELL_H / 2}
                />
              ))}
            </svg>
            {layout.cells.map((cell) => {
              const el = elemOf(cell.elemId);
              if (!el) return null;
              return (
                <LadElement
                  key={cell.elemId}
                  elem={el}
                  cell={cell}
                  selected={sel?.t === 'elem' && sel.id === cell.elemId}
                  messages={diagnostics.get(cell.elemId) ?? []}
                  onSelect={() => setSel({ t: 'elem', id: cell.elemId })}
                  onEdit={() => startEdit(cell.elemId)}
                />
              );
            })}
            {layout.slots.map((s, i) => (
              <button
                key={i}
                type="button"
                className={`baa-lad-slot${
                  sel?.t === 'slot' && JSON.stringify(sel.at) === JSON.stringify(s.at)
                    ? ' baa-lad-slot--selected'
                    : ''
                }`}
                style={{ left: s.col * CELL_W - 5, top: s.row * CELL_H + CELL_H / 2 - 5 }}
                aria-label={t('lad.slot')}
                tabIndex={-1}
                onClick={() => setSel({ t: 'slot', at: s.at })}
              />
            ))}
            {editing && editCell && editField && (
              <input
                className="baa-lad-input"
                style={{
                  left: editCell.col * CELL_W,
                  top: editCell.row * CELL_H + (editing.field > 0 ? 22 : 0),
                  width: Math.max(editCell.w * CELL_W, 72),
                }}
                aria-label={editField.pin ? editField.key : t(editField.label)}
                value={editing.value}
                autoFocus
                onChange={(e) =>
                  setEditing({ ...editing, value: e.target.value.replace(/[\r\n]+/g, ' ') })
                }
                onBlur={() => commitEdit(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitEdit(false);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelEdit();
                  } else if (e.key === 'Tab' && !e.shiftKey) {
                    e.preventDefault();
                    commitEdit(true);
                  }
                }}
              />
            )}
          </div>
        </div>
      </div>
      <div className="baa-lad-status" role="status">
        {status}
      </div>
    </div>
  );
}
