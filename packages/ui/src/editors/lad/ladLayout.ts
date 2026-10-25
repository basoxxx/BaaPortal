// Impaginazione pura delle reti KOP su una griglia di celle intere (nessun DOM).
// Il componente moltiplica le coordinate per la dimensione della cella.
//
// Convenzioni:
// - una cella occupa le colonne `col..col+w-1` e le righe `row..row+h-1`;
// - un punto di un filo o di uno slot `[col, row]` sta sul bordo sinistro della colonna `col`,
//   a metà della riga `row`: un filo orizzontale da `[a, r]` a `[b, r]` copre le colonne a..b-1,
//   uno verticale corre sul bordo tra due colonne e non attraversa nessuna cella;
// - la serie va a destra, i rami di un parallelo si impilano in basso, le uscite stanno tutte
//   nell'ultima colonna e un ramo a T scende dal suo nodo con un filo verticale;
// - la logica dei pin BOOL di un box sta a sinistra del box, sulla riga del pin.
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
};
export type LadWire = { from: [col: number, row: number]; to: [col: number, row: number] };
/** Dove si può inserire (per clic e trascinamento): bordo sinistro dell'elemento che seguirebbe. */
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

type Dim = { w: number; h: number };
type BoxPlan = {
  /** Nomi dei pin BOOL con logica: quelli del catalogo, poi eventuali altri presenti nel box. */
  pins: string[];
  /** Riga (relativa al box) di ogni pin d'ingresso: primo pin, pin BOOL con logica, pin di dati. */
  rows: Record<string, number>;
  /** Larghezza della zona di logica a sinistra del box. */
  pinW: number;
  h: number;
};
type NodeDim = { h: number; need: number };

const elemDims = new WeakMap<object, Dim>();
const listDims = new WeakMap<object, Dim>();
const boxPlans = new WeakMap<object, BoxPlan>();
const nodeDims = new WeakMap<object, NodeDim>();

function listDim(list: LadElem[]): Dim {
  let d = listDims.get(list);
  if (!d) {
    let w = 0;
    let h = 1;
    for (const e of list) {
      const x = elemDim(e);
      w += x.w;
      h = Math.max(h, x.h);
    }
    d = { w, h };
    listDims.set(list, d);
  }
  return d;
}

function boxPlan(b: LadBox): BoxPlan {
  let p = boxPlans.get(b);
  if (p) return p;
  const def = BOX_CATALOG[b.box];
  const pins = [...def.boolInputs];
  for (const name of Object.keys(b.boolPins)) if (!pins.includes(name)) pins.push(name);
  const rows: Record<string, number> = {};
  const first = def.en ? 'EN' : def.firstPin;
  if (first) rows[first] = 0;
  let r = 1;
  let pinW = 0;
  for (const name of pins) {
    rows[name] = r;
    const list = b.boolPins[name] ?? [];
    r += listDim(list).h;
    pinW = Math.max(pinW, listDim(list).w);
  }
  for (const d of def.dataInputs) rows[d.name] = r++;
  if (def.dynamicPins) for (const name of Object.keys(b.pins)) rows[name] = r++;
  const outRows = (def.en ? 1 : 0) + def.outputs.length;
  p = { pins, rows, pinW, h: Math.max(BOX_MIN_H, r, outRows) };
  boxPlans.set(b, p);
  return p;
}

function elemDim(e: LadElem): Dim {
  let d = elemDims.get(e);
  if (!d) {
    if (e.k === 'parallel') {
      let w = 0;
      let h = 0;
      for (const br of e.branches) {
        const x = listDim(br);
        w = Math.max(w, x.w);
        h += x.h;
      }
      d = { w, h: Math.max(1, h) };
    } else if (e.k === 'box') {
      const p = boxPlan(e);
      d = { w: p.pinW + BOX_W, h: p.h };
    } else d = { w: 1, h: 1 };
    elemDims.set(e, d);
  }
  return d;
}

/** Altezza del nodo in righe e colonne che gli servono a destra del suo inizio (uscite incluse). */
function nodeDim(n: LadNode): NodeDim {
  let d = nodeDims.get(n);
  if (!d) {
    const s = listDim(n.series);
    let items = 0;
    let sub = 1;
    for (const o of n.outs) {
      if (isNode(o)) {
        const x = nodeDim(o);
        items += x.h;
        sub = Math.max(sub, x.need);
      } else items += 1;
    }
    d = { h: Math.max(s.h, items, 1), need: s.w + sub };
    nodeDims.set(n, d);
  }
  return d;
}

type Out = Pick<LadLayout, 'cells' | 'wires' | 'slots'>;

const wire = (o: Out, c1: number, r1: number, c2: number, r2: number) =>
  o.wires.push({ from: [c1, r1], to: [c2, r2] });

/** Posa una lista in serie da `col` sulla riga `row`; restituisce la colonna di fine. */
function placeList(
  o: Out,
  list: LadElem[],
  col: number,
  row: number,
  at: (index: number) => InsertPoint,
): number {
  let c = col;
  list.forEach((e, i) => {
    o.slots.push({ at: at(i), col: c, row });
    placeElem(o, e, c, row);
    c += elemDim(e).w;
  });
  o.slots.push({ at: at(list.length), col: c, row });
  return c;
}

function placeElem(o: Out, e: LadElem, col: number, row: number): void {
  if (e.k === 'parallel') {
    const pw = elemDim(e).w;
    let r = row;
    let last = row;
    e.branches.forEach((br, k) => {
      last = r;
      const end = placeList(o, br, col, r, (index) => ({ branchOf: e.id, branch: k, index }));
      if (end < col + pw) wire(o, end, r, col + pw, r);
      r += listDim(br).h;
    });
    wire(o, col, row, col, last);
    wire(o, col + pw, row, col + pw, last);
    return;
  }
  if (e.k === 'box') return placeBox(o, e, col, row);
  o.cells.push({ elemId: e.id, kind: e.k, col, row, w: 1, h: 1 });
}

function placeBox(o: Out, b: LadBox, col: number, row: number): void {
  const p = boxPlan(b);
  const bx = col + p.pinW;
  const pinRows: Record<string, number> = {};
  for (const [name, r] of Object.entries(p.rows)) pinRows[name] = r;
  o.cells.push({ elemId: b.id, kind: 'box', col: bx, row, w: BOX_W, h: p.h, pinRows });
  // La serie arriva al primo pin del box.
  if (bx > col) wire(o, col, row, bx, row);
  let rail = row;
  for (const name of p.pins) {
    const list = b.boolPins[name] ?? [];
    const r = row + p.rows[name]!;
    const start = bx - listDim(list).w;
    placeList(o, list, start, r, (index) => ({ box: b.id, pin: name, index }));
    // Un pin senza logica resta scollegato: niente fili.
    if (list.length > 0) {
      if (start > col) wire(o, col, r, start, r);
      rail = r;
    }
  }
  if (rail > row) wire(o, col, row, col, rail);
}

function placeNode(o: Out, n: LadNode, start: number, row: number, lastCol: number): void {
  const end = placeList(o, n.series, start, row, (index) => ({ node: n.id, index }));
  let r = row;
  for (const out of n.outs) {
    if (isNode(out)) {
      placeNode(o, out, end, r, lastCol);
      r += nodeDim(out).h;
    } else {
      o.cells.push({ elemId: out.id, kind: 'out', col: lastCol, row: r, w: 1, h: 1 });
      if (lastCol > end) wire(o, end, r, lastCol, r);
      r += 1;
    }
  }
  // Rotaia da cui scendono le uscite e i rami a T, fino all'ultimo elemento.
  const lastStart = rowOfLastItem(n, row);
  if (lastStart > row) wire(o, end, row, end, lastStart);
}

/** Riga su cui comincia l'ultima uscita (o ramo a T) del nodo. */
function rowOfLastItem(n: LadNode, row: number): number {
  let r = row;
  let last = row;
  for (const out of n.outs) {
    last = r;
    r += isNode(out) ? nodeDim(out).h : 1;
  }
  return last;
}

export function layoutNetwork(net: LadNetwork): LadLayout {
  const o: Out = { cells: [], wires: [], slots: [] };
  const cols = nodeDim(net.root).need;
  placeNode(o, net.root, 0, 0, cols - 1);
  return { ...o, cols, rows: nodeDim(net.root).h };
}
