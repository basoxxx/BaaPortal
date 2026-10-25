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
import type { CallParams } from './ladOps';
import {
  branchToClose,
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
/** Trascinamento di oggetti dall'albero del progetto (`beginDrag`), accettato per creare un CALL. */
export const TREE_DRAG_TYPE = 'application/x-baaportal';
const HISTORY_KEY = 'history.editLad';
const PAD = 12;

type Selection = { t: 'elem'; id: string } | { t: 'slot'; at: InsertPoint } | null;
type Editing = { id: string; key: string; value: string };

/** Inserimento nella selezione dell'editor: lo usa la tavolozza delle istruzioni. */
export type LadInsertApi = {
  insertPalette: (paletteId: string) => void;
  insertBox: (kind: BoxKind) => void;
};

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
  callParams,
  newId = defaultId,
  onActive,
  callOfDrop,
}: Props) {
  const { t } = useTranslation();
  const layout = useMemo(() => layoutNetwork(net), [net]);
  const [sel, setSel] = useState<Selection>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [status, setStatus] = useState('');
  const [menu, setMenu] = useState(false);
  const canvas = useRef<HTMLDivElement>(null);
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
  function apply(make: () => LadNetwork, next?: Selection, failKey = 'lad.cannotDo') {
    let result: LadNetwork;
    try {
      result = make();
    } catch (err) {
      // Le operazioni di modifica segnalano le posizioni impossibili con un Error «Rete KOP: …».
      if (!(err instanceof Error) || !err.message.startsWith('Rete KOP')) console.error(err);
      setStatus(t(failKey));
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

  /** Voce della tavolozza (`PALETTE`) nella selezione: un'uscita va a fine linea del nodo, il resto in serie. */
  function insertPalette(paletteId: string) {
    const entry = PALETTE.find((p) => p.id === paletteId);
    if (!entry || readOnly) return;
    const el = { id: newId(), ...structuredClone(entry.preset) };
    if (entry.where === 'out') {
      const { nodeId } = target();
      apply(() => addOutput(net, nodeId, el as LadOut), { t: 'elem', id: el.id });
    } else insertNew(el as LadElem);
  }

  const insertApi = useRef<LadInsertApi>({ insertPalette, insertBox: () => {} });
  insertApi.current = {
    insertPalette,
    insertBox: (kind) => {
      if (!readOnly) insertNew(newBox(kind, newId()));
    },
  };
  const stableApi = useRef<LadInsertApi>({
    insertPalette: (id) => insertApi.current.insertPalette(id),
    insertBox: (k) => insertApi.current.insertBox(k),
  });
  const onActiveRef = useRef(onActive);
  onActiveRef.current = onActive;
  useEffect(() => {
    const api = stableApi.current;
    return () => onActiveRef.current?.(api, false);
  }, []);

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
  function addTBranch() {
    const { nodeId } = target();
    const contact: LadElem = { id: newId(), k: 'contact', neg: false, op: '' };
    const coil: LadOut = { id: newId(), k: 'coil', op: '' };
    const node = { id: newId(), series: [contact], outs: [coil] };
    apply(() => addOutput(net, nodeId, node), { t: 'elem', id: contact.id });
  }

  function doOpenBranch() {
    if (sel?.t !== 'elem' || placeOf(net, sel.id)?.t !== 'elem') return;
    const id = sel.id;
    let last = '';
    const gen = () => (last = newId());
    if (apply(() => openBranch(net, id, gen))) setSel({ t: 'elem', id: last });
  }

  /** F9: chiude l'ultimo ramo aperto prima dell'elemento selezionato, ricavato dal modello. */
  function doCloseBranch() {
    const from = sel?.t === 'elem' ? branchToClose(net, sel.id) : undefined;
    if (sel?.t !== 'elem' || !from) {
      setStatus(t('lad.cannotClose'));
      return;
    }
    const to = sel.id;
    apply(() => closeBranchAfter(net, from, to, newId), undefined, 'lad.cannotClose');
  }

  function doDelete() {
    if (sel?.t !== 'elem' || sel.id === rootId) return;
    const id = sel.id;
    apply(() => removeElem(net, id, newId), null);
  }

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
    if (readOnly) return;
    if (a === 'contactNo') addContact(false);
    else if (a === 'contactNc') addContact(true);
    else if (a === 'coil') addCoil();
    else if (a === 'tBranch') addTBranch();
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

  /** Un blocco dall'albero diventa un box CALL con i pin del blocco chiamato. */
  function dropCall(e: DragEvent<HTMLDivElement>, raw: string) {
    const instance = callOfDrop?.(raw);
    const best = slotAt(e);
    if (instance === undefined || !best) return;
    e.preventDefault();
    const at = best.at;
    const box = newBox('CALL', newId());
    const fld = fieldsOf(box).find((f) => f.key === 'instance');
    const patch = fld ? fieldPatch(box, fld, instance, callParams) : { instance };
    apply(() => updateElem(insertElem(net, at, box), box.id, patch), {
      t: 'elem',
      id: box.id,
    });
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    if (readOnly) return;
    const raw = e.dataTransfer.getData(LAD_DRAG_TYPE);
    if (!raw) {
      const tree = e.dataTransfer.getData(TREE_DRAG_TYPE);
      if (tree) dropCall(e, tree);
      return;
    }
    e.preventDefault();
    let payload: { palette?: string; box?: BoxKind };
    try {
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      return;
    }
    const best = slotAt(e);
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
  const tools: { key: keyof typeof LAD_TOOL_KEYS; run: () => void }[] = [
    { key: 'contactNo', run: () => addContact(false) },
    { key: 'contactNc', run: () => addContact(true) },
    { key: 'coil', run: addCoil },
    { key: 'tBranch', run: addTBranch },
    { key: 'openBranch', run: doOpenBranch },
    { key: 'closeBranch', run: doCloseBranch },
  ];

  return (
    <div className="baa-lad" onFocus={() => onActive?.(stableApi.current, true)}>
      {
        <div className="baa-lad-toolbar" role="toolbar" aria-label={t('lad.toolbar')}>
          {tools.map((tool) => (
            <button
              key={tool.key}
              type="button"
              disabled={readOnly}
              title={`${toolTitle(tool.key)} (${LAD_TOOL_KEYS[tool.key]})`}
              onClick={() => {
                tool.run();
                wantFocus.current = true;
                canvas.current?.focus();
              }}
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
      }
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
          const types = e.dataTransfer.types;
          if (readOnly) return;
          if (types.includes(LAD_DRAG_TYPE) || (callOfDrop && types.includes(TREE_DRAG_TYPE)))
            e.preventDefault();
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
                  onEdit={(pin) => startEdit(cell.elemId, pin)}
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
        {status}
      </div>
    </div>
  );
}
