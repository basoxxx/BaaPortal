// Editor grafico di un segmento KOP: componente controllato, non modifica mai `net`.
import { useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { findElem, updateElem } from '@baaportal/ladfbd';
import type { LadElem, LadNetwork, LadOut } from '@baaportal/ladfbd';
import { CELL_H, CELL_W, LadElement } from './LadElement';
import { LadToolbar } from './LadToolbar';
import { LAD_TOOL_KEYS, ladAction } from './ladKeys';
import type { LadAction } from './ladKeys';
import { layoutNetwork } from './ladLayout';
import type { LadCell } from './ladLayout';
import type { CallParams } from './ladOps';
import { monAttr, type LadMonitor } from './ladMonitor';
import { fieldPatch, fieldValue, fieldsOf } from './ladOps';
import { useLadEdit } from './useLadEdit';
import type { LadInsertApi } from './useLadEdit';
import './lad.css';

export { LAD_DRAG_TYPE, TREE_DRAG_TYPE } from './useLadEdit';
export type { LadInsertApi } from './useLadEdit';
const PAD = 12;

type Editing = { id: string; key: string; value: string };

type Props = {
  net: LadNetwork;
  index: number;
  diagnostics: Map<string, string[]>;
  readOnly: boolean;
  onChange: (next: LadNetwork, labelKey: string) => void;
  /** Parametri del blocco chiamato da un box CALL, per sapere quali pin ha; da `instance`. */
  callParams?: CallParams;
  /** Generatore di id; di norma `crypto.randomUUID`. */
  newId?: () => string;
  /** L'editor prende il focus (`true`) o sparisce (`false`): la tavolozza inserisce nell'ultimo attivo. */
  onActive?: (api: LadInsertApi, active: boolean) => void;
  /**
   * Un oggetto dell'albero rilasciato sulla rete (`TREE_DRAG_TYPE`, testo grezzo): restituisce
   * l'istanza del box CALL da creare, o `undefined` se non è un blocco chiamabile.
   */
  callOfDrop?: (raw: string) => string | undefined;
  /** Osservazione del programma: stato degli elementi, solo da mostrare. */
  monitor?: LadMonitor;
};

const defaultId = () => globalThis.crypto.randomUUID();

/** Cella più vicina a `from` nella direzione data (coordinate del centro). */
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
  callParams,
  newId = defaultId,
  onActive,
  callOfDrop,
  monitor,
}: Props) {
  const { t } = useTranslation();
  const layout = useMemo(() => layoutNetwork(net), [net]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const finished = useRef(false);
  const ed = useLadEdit({
    net,
    readOnly,
    onChange,
    newId,
    callParams,
    onActive,
    callOfDrop,
    root: canvas,
    idAttr: 'data-lad-id',
    busy: editing !== null,
  });
  const { sel, setSel, wantFocus, apply } = ed;

  const elemOf = (id: string) => findElem(net, id) as (LadElem | LadOut) | undefined;

  const fields = (e: LadElem | LadOut) => fieldsOf(e, callParams);

  function startEdit(id: string, key?: string) {
    if (readOnly) return;
    const e = elemOf(id);
    if (!e) return;
    const flds = fields(e);
    const fld = key === undefined ? flds[0] : flds.find((f) => f.key === key);
    if (!fld) return;
    finished.current = false;
    setEditing({ id, key: fld.key, value: fieldValue(e, fld) });
  }

  function commitEdit(advance: boolean) {
    if (!editing || finished.current) return;
    finished.current = true;
    const e = elemOf(editing.id);
    const fld = e ? fields(e).find((f) => f.key === editing.key) : undefined;
    const value = editing.value.replace(/[\r\n]+/g, ' ');
    setEditing(null);
    wantFocus.current = true;
    if (!e || !fld) return;
    const changed = value !== fieldValue(e, fld);
    // Tab passa al campo successivo, calcolato sulla rete già modificata (un CALL può aver
    // guadagnato pin).
    let after: LadNetwork = net;
    if (changed) {
      let patched: LadNetwork | undefined;
      apply(() => (patched = updateElem(net, editing.id, fieldPatch(e, fld, value, callParams))));
      if (!patched) return;
      after = patched;
    }
    if (!advance) return;
    const cur = findElem(after, editing.id) as (LadElem | LadOut) | undefined;
    const flds = cur ? fields(cur) : [];
    const nxt = flds[flds.findIndex((f) => f.key === editing.key) + 1];
    if (cur && nxt) {
      finished.current = false;
      setEditing({ id: editing.id, key: nxt.key, value: fieldValue(cur, nxt) });
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
    if (a === 'edit') {
      if (!readOnly && sel?.t === 'elem') startEdit(sel.id);
    } else ed.run(a);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const a = ladAction(e);
    if (!a) return;
    if (a === 'edit' && sel?.t !== 'elem') return;
    e.preventDefault();
    run(a);
  }

  /** Il punto di inserimento più vicino al rilascio. */
  function slotAt(e: DragEvent<HTMLDivElement>) {
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
    return best;
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    const best = slotAt(e);
    if (best && ed.drop(e.dataTransfer, best.at)) e.preventDefault();
  }

  const editCell = editing ? layout.cells.find((c) => c.elemId === editing.id) : undefined;
  const editElem = editing ? elemOf(editing.id) : undefined;
  const editField = editElem ? fields(editElem).find((f) => f.key === editing!.key) : undefined;
  // Il campo di testo sta sulla riga del pin che si modifica (box) o sopra/sotto il simbolo.
  const editRow =
    editCell?.pinRows?.[editing?.key ?? ''] ?? editCell?.outRows?.[editing?.key ?? ''];
  const editTop = editCell
    ? editRow !== undefined && editField?.pin
      ? (editCell.row + editRow) * CELL_H + 12
      : editCell.row * CELL_H +
        (editElem && fields(editElem).indexOf(editField!) > 0 && editElem.k !== 'box' ? 22 : 0)
    : 0;
  const width = layout.cols * CELL_W;
  const height = layout.rows * CELL_H;
  const toolTitle = (k: keyof typeof LAD_TOOL_KEYS) =>
    k === 'contactNo' || k === 'contactNc' || k === 'coil'
      ? t(`lad.palette.${k}`)
      : t(`lad.tool.${k}`);
  const tool = (key: keyof typeof LAD_TOOL_KEYS, run: () => void) => ({
    key,
    label: t(`lad.tool.${key}`),
    title: `${toolTitle(key)} (${LAD_TOOL_KEYS[key]})`,
    run,
  });
  const tools = [
    tool('contactNo', () => ed.addContact(false)),
    tool('contactNc', () => ed.addContact(true)),
    tool('coil', ed.addCoil),
    tool('tBranch', ed.addTBranch),
    tool('openBranch', ed.doOpenBranch),
    tool('closeBranch', ed.doCloseBranch),
  ];

  return (
    <div className="baa-lad" onFocus={() => onActive?.(ed.api, true)}>
      <LadToolbar
        tools={tools}
        readOnly={readOnly}
        onBox={(k) => ed.insertBox(k)}
        done={() => {
          wantFocus.current = true;
          canvas.current?.focus();
        }}
      />
      <div
        ref={canvas}
        className="baa-lad-canvas"
        role="group"
        aria-label={t('lad.network', { n: index + 1 })}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest('button, input')) setSel(null);
        }}
        onDragOver={(e) => {
          if (ed.accepts(e.dataTransfer.types)) e.preventDefault();
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
                  data-mon={w.flow && monAttr(monitor, w.flow.id, w.flow.side)}
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
                  onEdit={(pin) => startEdit(cell.elemId, pin)}
                  monitor={monitor}
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
                  top: editTop,
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
        {ed.status}
      </div>
    </div>
  );
}
