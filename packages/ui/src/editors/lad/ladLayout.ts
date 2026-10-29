// Impaginazione pura delle reti KOP su una griglia di celle intere (nessun DOM).
// Il componente moltiplica le coordinate per la dimensione della cella.
//
// Convenzioni:
// - una cella occupa le colonne `col..col+w-1` e le righe `row..row+h-1`;
// - un punto di un filo o di uno slot `[col, row]` sta sul bordo sinistro della colonna `col`,
//   a metà della riga `row`: un filo orizzontale da `[a, r]` a `[b, r]` copre le colonne a..b-1,
//   uno verticale corre sul bordo tra due colonne e non attraversa nessuna cella;
// - la colonna 0 è la barra di alimentazione di sinistra;
// - la serie va a destra, i rami di un parallelo si impilano in basso, le uscite stanno tutte
//   nell'ultima colonna e un ramo a T scende dal suo nodo con un filo verticale;
// - i pin BOOL di un box (oltre al primo pin, che sta sulla riga della serie) hanno la loro
//   logica che parte dalla barra di sinistra (colonna 0) su righe riservate in fondo al nodo
//   ("zona dei pin"), mai sotto altre celle; un filo la porta fino al bordo sinistro del box e
//   sale lungo quel bordo fino alla riga del pin. Il box si sposta a destra se la logica è più
//   larga della serie che lo precede, e i fili della serie si allungano per raggiungerlo;
// - le coordinate degli slot sono intere tranne gli estremi dei rami di un parallelo (e i pochi
//   punti che altrimenti coinciderebbero), spostati di poco perché ogni slot abbia un punto suo.
import { BOX_CATALOG, isNode } from '@baaportal/ladfbd';
import type { InsertPoint, LadBox, LadElem, LadNetwork, LadNode } from '@baaportal/ladfbd';

export type LadCell = {
  elemId: string;
  kind: 'contact' | 'not' | 'cmp' | 'edge' | 'posneg' | 'midline' | 'box' | 'out' | 'empty';
  col: number;
  row: number;
  w: number;
  h: number;
  /** Solo per i box: riga (relativa alla cella) di ogni pin d'ingresso, EN o primo pin compresi. */
  pinRows?: Record<string, number>;
  /** Solo per i box: riga (relativa alla cella) di ogni pin d'uscita; ENO/Q sta sulla riga 0. */
  outRows?: Record<string, number>;
};
/** `flow`: l'elemento (o nodo) e il lato il cui flusso il filo porta, per l'osservazione. */
export type LadWire = {
  from: [col: number, row: number];
  to: [col: number, row: number];
  flow?: { id: string; side: 'in' | 'out' };
};
/** Dove si può inserire (per clic e trascinamento); `col` può essere frazionario. */
export type LadInsertSlot = { at: InsertPoint; col: number; row: number };
export type LadLayout = {
  cells: LadCell[];
  wires: LadWire[];
  slots: LadInsertSlot[];
  cols: number;
  rows: number;
};

const BOX_W = 2;
const BOX_MIN_H = 2;
const EDGE_SLOT = 0.25;
const NUDGE = 1 / 64;

type BoxPlan = {
  /** Pin BOOL con logica propria: quelli del catalogo, più eventuali altri presenti nel box. */
  pins: string[];
  inRows: Record<string, number>;
  outRows: Record<string, number>;
  h: number;
};
type NodeInfo = {
  /** Righe della serie più quelle della zona dei pin. */
  ownH: number;
  seriesH: number;
  pool: number;
  /** Il nodo o un suo ramo a T usa la zona dei pin. */
  hasPool: boolean;
  /** Riga (relativa al nodo) di ogni uscita o ramo a T. */
  itemRows: number[];
  h: number;
};

const elemHs = new WeakMap<object, number>();
const listHs = new WeakMap<object, number>();
const pools = new WeakMap<object, number>();
const boxPlans = new WeakMap<object, BoxPlan>();
const nodeInfos = new WeakMap<object, NodeInfo>();

const cached = <T>(m: WeakMap<object, T>, k: object, f: () => T): T => {
  let v = m.get(k);
  if (v === undefined) {
    v = f();
    m.set(k, v);
  }
  return v;
};

function listH(list: LadElem[]): number {
  return cached(listHs, list, () => list.reduce((h, e) => Math.max(h, elemH(e)), 1));
}

function elemH(e: LadElem): number {
  return cached(elemHs, e, () => {
    if (e.k === 'parallel')
      return Math.max(
        1,
        e.branches.reduce((h, b) => h + listH(b), 0),
      );
    if (e.k === 'box') return boxPlan(e).h;
    return 1;
  });
}

function boxPlan(b: LadBox): BoxPlan {
  return cached(boxPlans, b, () => {
    const def = BOX_CATALOG[b.box];
    const first = def.en ? 'EN' : def.firstPin;
    const pins = [...def.boolInputs];
    for (const name of Object.keys(b.boolPins))
      if (name !== first && name !== 'EN' && !pins.includes(name)) pins.push(name);
    const inRows: Record<string, number> = {};
    if (first) inRows[first] = 0;
    let r = 1;
    for (const name of pins) inRows[name] = r++;
    for (const d of def.dataInputs) inRows[d.name] = r++;
    if (def.dynamicPins) for (const name of Object.keys(b.pins)) inRows[name] = r++;
    // Il flusso (ENO o Q) esce sempre dalla riga 0 del box; gli altri pin seguono.
    const flow = def.en ? 'ENO' : (def.outputs.find((o) => o.name === 'Q')?.name ?? '');
    const outRows: Record<string, number> = {};
    let o = 0;
    if (flow) outRows[flow] = o++;
    for (const out of def.outputs) if (out.name !== flow) outRows[out.name] = o++;
    return { pins, inRows, outRows, h: Math.max(BOX_MIN_H, r, o) };
  });
}

/** Righe della zona dei pin che servono a una lista (logica dei pin BOOL dei box che contiene). */
function poolOfList(list: LadElem[]): number {
  return cached(pools, list, () => list.reduce((n, e) => n + poolOfElem(e), 0));
}

function poolOfElem(e: LadElem): number {
  if (e.k === 'parallel') return e.branches.reduce((n, b) => n + poolOfList(b), 0);
  if (e.k !== 'box') return 0;
  let n = 0;
  for (const name of boxPlan(e).pins) {
    const l = e.boolPins[name];
    if (l && l.length > 0) n += listH(l) + poolOfList(l);
  }
  return n;
}

function nodeInfo(n: LadNode): NodeInfo {
  return cached(nodeInfos, n, () => {
    const seriesH = listH(n.series);
    const pool = poolOfList(n.series);
    const ownH = seriesH + pool;
    let hasPool = pool > 0;
    for (const o of n.outs) if (isNode(o) && nodeInfo(o).hasPool) hasPool = true;
    // Un ramo a T che usa la zona dei pin parte sotto quella del nodo, che occupa tutta la
    // larghezza a sinistra: così nessuna cella le finisce sopra.
    const itemRows: number[] = [];
    let r = 0;
    for (const o of n.outs) {
      if (isNode(o) && nodeInfo(o).hasPool) r = Math.max(r, ownH);
      itemRows.push(r);
      r += isNode(o) ? nodeInfo(o).h : 1;
    }
    return { ownH, seriesH, pool, hasPool, itemRows, h: Math.max(ownH, r, 1) };
  });
}

type Ctx = {
  cells: LadCell[];
  wires: LadWire[];
  slots: LadLayout['slots'];
  /** Uscite da collocare nell'ultima colonna, nota solo alla fine. */
  outs: { cell: LadCell; end: number; node: string }[];
  maxEnd: number;
  /** Prossima riga libera della zona dei pin del nodo che si sta posando. */
  poolNext: number;
};

type Flow = LadWire['flow'];
const wire = (c: Ctx, c1: number, r1: number, c2: number, r2: number, flow: Flow) =>
  c.wires.push({ from: [c1, r1], to: [c2, r2], ...(flow ? { flow } : {}) });
/** Il flusso alla fine di una lista: l'uscita del suo ultimo elemento, altrimenti `empty`. */
const flowAfter = (list: LadElem[], empty: Flow): Flow => {
  const last = list.at(-1);
  return last ? { id: last.id, side: 'out' } : empty;
};

/**
 * Posa una lista in serie da `col` sulla riga `row`; restituisce la colonna di fine.
 * `edge`: spostamento degli slot estremi (rami di un parallelo), 0 altrove.
 */
function placeList(
  c: Ctx,
  list: LadElem[],
  col: number,
  row: number,
  at: (index: number) => InsertPoint,
  edge: number,
  depth: number,
): number {
  let x = col;
  list.forEach((e, i) => {
    c.slots.push({ at: at(i), col: i === 0 ? x + edge : x, row });
    x = placeElem(c, e, x, row, depth);
  });
  if (list.length === 0) c.slots.push({ at: at(0), col: x + edge, row });
  else c.slots.push({ at: at(list.length), col: x - edge, row });
  return x;
}

function placeElem(c: Ctx, e: LadElem, col: number, row: number, depth: number): number {
  if (e.k === 'parallel') {
    let r = row;
    let last = row;
    let end = col;
    const ends: number[] = [];
    const edge = EDGE_SLOT / 2 ** depth;
    e.branches.forEach((br, k) => {
      last = r;
      const x = placeList(
        c,
        br,
        col,
        r,
        (index) => ({ branchOf: e.id, branch: k, index }),
        edge,
        depth + 1,
      );
      ends.push(x);
      end = Math.max(end, x);
      r += listH(br);
    });
    r = row;
    e.branches.forEach((br, k) => {
      if (ends[k]! < end) wire(c, ends[k]!, r, end, r, flowAfter(br, { id: e.id, side: 'in' }));
      r += listH(br);
    });
    wire(c, col, row, col, last, { id: e.id, side: 'in' });
    wire(c, end, row, end, last, { id: e.id, side: 'out' });
    return end;
  }
  if (e.k === 'box') return placeBox(c, e, col, row);
  c.cells.push({ elemId: e.id, kind: e.k, col, row, w: 1, h: 1 });
  return col + 1;
}

function placeBox(c: Ctx, b: LadBox, col: number, row: number): number {
  const p = boxPlan(b);
  // La logica dei pin parte dalla colonna 0 su righe della zona dei pin.
  const placed: { name: string; r: number; end: number }[] = [];
  let bx = col;
  for (const name of p.pins) {
    const list = b.boolPins[name] ?? [];
    if (list.length === 0) continue;
    const r = c.poolNext;
    c.poolNext += listH(list);
    const end = placeList(c, list, 0, r, (index) => ({ box: b.id, pin: name, index }), 0, 0);
    placed.push({ name, r, end });
    bx = Math.max(bx, end);
  }
  if (bx > col) wire(c, col, row, bx, row, { id: b.id, side: 'in' });
  for (const { name, r, end } of placed) {
    const flow = flowAfter(b.boolPins[name]!, undefined);
    if (end < bx) wire(c, end, r, bx, r, flow);
    wire(c, bx, row + p.inRows[name]!, bx, r, flow);
  }
  // Pin senza logica: resta scollegato, ma si può rilasciare un elemento sul suo bordo.
  for (const name of p.pins) {
    if ((b.boolPins[name] ?? []).length === 0) {
      const at: InsertPoint = { box: b.id, pin: name, index: 0 };
      c.slots.push({ at, col: bx - 0.5, row: row + p.inRows[name]! });
    }
  }
  c.cells.push({
    elemId: b.id,
    kind: 'box',
    col: bx,
    row,
    w: BOX_W,
    h: p.h,
    pinRows: p.inRows,
    outRows: p.outRows,
  });
  return bx + BOX_W;
}

function placeNode(c: Ctx, n: LadNode, start: number, row: number): void {
  const info = nodeInfo(n);
  const saved = c.poolNext;
  c.poolNext = row + info.seriesH;
  const end = placeList(c, n.series, start, row, (index) => ({ node: n.id, index }), 0, 0);
  c.poolNext = saved;
  c.maxEnd = Math.max(c.maxEnd, end);
  n.outs.forEach((out, i) => {
    const r = row + info.itemRows[i]!;
    if (isNode(out)) placeNode(c, out, end, r);
    else {
      const cell: LadCell = { elemId: out.id, kind: 'out', col: end, row: r, w: 1, h: 1 };
      c.cells.push(cell);
      c.outs.push({ cell, end, node: n.id });
    }
  });
  // Rotaia da cui scendono le uscite e i rami a T, fino all'ultimo elemento.
  const last = row + (info.itemRows[info.itemRows.length - 1] ?? 0);
  if (last > row) wire(c, end, row, end, last, { id: n.id, side: 'out' });
}

/** Se due slot coincidono, il successivo si sposta di poco: ogni slot ha un punto suo. */
function separate(slots: LadLayout['slots']): void {
  const seen = new Set<string>();
  for (const s of slots) {
    while (seen.has(`${s.col},${s.row}`)) s.col += NUDGE;
    seen.add(`${s.col},${s.row}`);
  }
}

export function layoutNetwork(net: LadNetwork): LadLayout {
  const c: Ctx = { cells: [], wires: [], slots: [], outs: [], maxEnd: 0, poolNext: 0 };
  placeNode(c, net.root, 0, 0);
  const cols = c.maxEnd + 1;
  for (const { cell, end, node } of c.outs) {
    cell.col = cols - 1;
    if (cols - 1 > end) wire(c, end, cell.row, cols - 1, cell.row, { id: node, side: 'out' });
  }
  separate(c.slots);
  return { cells: c.cells, wires: c.wires, slots: c.slots, cols, rows: nodeInfo(net.root).h };
}
