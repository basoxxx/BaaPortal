import { describe, expect, it } from 'vitest';
import { insertElem } from '@baaportal/ladfbd';
import type { LadElem, LadNetwork, LadNode, LadOut } from '@baaportal/ladfbd';
import { layoutNetwork } from '../../src/editors/lad/ladLayout';
import type { LadCell, LadLayout } from '../../src/editors/lad/ladLayout';

let n = 0;
const id = () => `i${++n}`;
const contact = (): LadElem => ({ id: id(), k: 'contact', neg: false, op: '' });
const coil = (): LadOut => ({ id: id(), k: 'coil', op: '' });
const node = (series: LadElem[], outs: (LadOut | LadNode)[]): LadNode => ({
  id: id(),
  series,
  outs,
});
const net = (root: LadNode): LadNetwork => ({ root });
const cell = (l: LadLayout, elemId: string): LadCell => {
  const c = l.cells.find((x) => x.elemId === elemId);
  if (!c) throw new Error(`cella ${elemId} assente`);
  return c;
};
const hasWire = (l: LadLayout, from: [number, number], to: [number, number]) =>
  l.wires.some(
    (w) => w.from[0] === from[0] && w.from[1] === from[1] && w.to[0] === to[0] && w.to[1] === to[1],
  );

function expectNoOverlap(l: LadLayout): void {
  const seen = new Map<string, string>();
  for (const c of l.cells)
    for (let x = c.col; x < c.col + c.w; x++)
      for (let y = c.row; y < c.row + c.h; y++) {
        const key = `${x},${y}`;
        expect(seen.get(key), `${c.elemId} contro ${seen.get(key)} in ${key}`).toBeUndefined();
        seen.set(key, c.elemId);
      }
}

/** Un filo può correre lungo i bordi delle celle ma mai dentro: né in orizzontale né in verticale. */
function expectNoWireThroughCells(l: LadLayout): void {
  for (const w of l.wires) {
    const [x1, y1] = w.from;
    const [x2, y2] = w.to;
    for (const c of l.cells) {
      const hit =
        y1 === y2
          ? c.row <= y1 && y1 < c.row + c.h && Math.max(x1, c.col) < Math.min(x2, c.col + c.w)
          : x1 > c.col &&
            x1 < c.col + c.w &&
            c.row <= Math.max(y1, y2) &&
            c.row + c.h - 1 >= Math.min(y1, y2);
      expect(hit, `filo ${x1},${y1}-${x2},${y2} dentro ${c.elemId}`).toBe(false);
    }
  }
}

/** Ogni cella ha il bordo di ingresso (e, se non è un'uscita, quello di uscita) collegato. */
function expectConnected(l: LadLayout): void {
  const onWire = (x: number, y: number) =>
    l.wires.some((w) => {
      const [x1, y1] = w.from;
      const [x2, y2] = w.to;
      return (
        (y1 === y2 && y === y1 && x >= x1 && x <= x2) ||
        (x1 === x2 && x === x1 && y >= y1 && y <= y2)
      );
    });
  const abuts = (x: number, y: number, side: 'left' | 'right') =>
    l.cells.some(
      (c) => c.row <= y && y < c.row + c.h && (side === 'left' ? c.col + c.w === x : c.col === x),
    );
  for (const c of l.cells) {
    const inOk = c.col === 0 || onWire(c.col, c.row) || abuts(c.col, c.row, 'left');
    expect(inOk, `ingresso di ${c.elemId} scollegato`).toBe(true);
    if (c.kind !== 'out') {
      const outOk = onWire(c.col + c.w, c.row) || abuts(c.col + c.w, c.row, 'right');
      expect(outOk, `uscita di ${c.elemId} scollegata`).toBe(true);
    }
  }
}

function box(kind: 'S_ODT' | 'MOVE', pins: Record<string, LadElem[]> = {}): LadElem {
  return { id: id(), k: 'box', box: kind, instance: '', pins: {}, boolPins: pins };
}

describe('layoutNetwork', () => {
  it("serie di 2 contatti e bobina: bobina nell'ultima colonna", () => {
    const a = contact();
    const b = contact();
    const o = coil();
    const l = layoutNetwork(net(node([a, b], [o])));
    expect(cell(l, a.id)).toMatchObject({ kind: 'contact', col: 0, row: 0, w: 1, h: 1 });
    expect(cell(l, b.id)).toMatchObject({ col: 1, row: 0 });
    expect(l.cols).toBe(3);
    expect(cell(l, o.id)).toMatchObject({ kind: 'out', col: l.cols - 1, row: 0 });
    expect(l.rows).toBe(1);
  });

  it('rete vuota: solo la bobina e uno slot in serie', () => {
    const root = node([], [coil()]);
    const l = layoutNetwork(net(root));
    expect(l.cols).toBe(1);
    expect(l.cells).toHaveLength(1);
    expect(l.slots).toEqual([{ at: { node: root.id, index: 0 }, col: 0, row: 0 }]);
  });

  it('parallelo di rami lunghi 1 e 2: righe 0 e 1 e filo di chiusura alla stessa colonna', () => {
    const a = contact();
    const b1 = contact();
    const b2 = contact();
    const par: LadElem = { id: id(), k: 'parallel', branches: [[b1], [a, b2]] };
    const after = contact();
    const o = coil();
    const l = layoutNetwork(net(node([par, after], [o])));
    expect(cell(l, b1.id)).toMatchObject({ col: 0, row: 0 });
    expect(cell(l, a.id)).toMatchObject({ col: 0, row: 1 });
    expect(cell(l, b2.id)).toMatchObject({ col: 1, row: 1 });
    // il ramo corto si allunga fino alla colonna di chiusura (2)
    expect(hasWire(l, [1, 0], [2, 0])).toBe(true);
    // rotaie verticali di apertura e di chiusura
    expect(hasWire(l, [0, 0], [0, 1])).toBe(true);
    expect(hasWire(l, [2, 0], [2, 1])).toBe(true);
    expect(cell(l, after.id)).toMatchObject({ col: 2, row: 0 });
    expect(l.rows).toBe(2);
    expect(cell(l, o.id).col).toBe(l.cols - 1);
  });

  it('gruppo A( … NOT ): una cornice racchiude solo il confronto e il NOT, i paralleli no', () => {
    const k = contact();
    const cmp: LadElem = { id: id(), k: 'cmp', fn: '>I', in1: 'MW 10', in2: 'MW 12' };
    const g: LadElem = { id: id(), k: 'parallel', branches: [[cmp, { id: id(), k: 'not' }]] };
    const l = layoutNetwork(net(node([k, g], [coil()])));
    expect(l.groups).toEqual([{ elemId: g.id, col: 1, row: 0, w: 2, h: 1 }]);
    const p: LadElem = { id: id(), k: 'parallel', branches: [[contact()], [contact()]] };
    expect(layoutNetwork(net(node([p], [coil()]))).groups).toEqual([]);
  });

  it("ramo a T: l'uscita del secondo ramo sta sotto, sempre nell'ultima colonna", () => {
    const a = contact();
    const c = contact();
    const o1 = coil();
    const o2 = coil();
    const sub = node([c], [o2]);
    const l = layoutNetwork(net(node([a], [o1, sub])));
    expect(cell(l, o1.id)).toMatchObject({ row: 0, col: l.cols - 1 });
    expect(cell(l, c.id)).toMatchObject({ row: 1, col: 1 });
    expect(cell(l, o2.id)).toMatchObject({ row: 1, col: l.cols - 1 });
    expect(l.cols).toBe(3);
    // filo verticale che scende dal nodo
    expect(hasWire(l, [1, 0], [1, 1])).toBe(true);
    expect(l.rows).toBe(2);
  });

  it('più uscite dirette in colonna con filo verticale e orizzontali', () => {
    const a = contact();
    const o1 = coil();
    const o2 = coil();
    const l = layoutNetwork(net(node([a], [o1, o2])));
    expect(cell(l, o2.id)).toMatchObject({ row: 1, col: 1 });
    expect(hasWire(l, [1, 0], [1, 1])).toBe(true);
  });

  it('box: dimensioni dai pin e logica dei pin BOOL dalla barra di sinistra', () => {
    const r = contact();
    const r2 = contact();
    const bx = box('S_ODT', { R: [r, r2] });
    const o = coil();
    const l = layoutNetwork(net(node([bx], [o])));
    // pin: S, R, TV in ingresso; BI, BCD, Q in uscita -> h = 3
    expect(cell(l, bx.id)).toMatchObject({ kind: 'box', col: 2, row: 0, w: 2, h: 3 });
    expect(cell(l, bx.id).pinRows).toMatchObject({ S: 0, R: 1, TV: 2 });
    // il flusso esce da Q sulla riga 0
    expect(cell(l, bx.id).outRows).toMatchObject({ Q: 0, BI: 1, BCD: 2 });
    // la logica parte dalla colonna 0, sotto la serie, in una riga riservata
    expect(cell(l, r.id)).toMatchObject({ col: 0, row: 3 });
    expect(cell(l, r2.id)).toMatchObject({ col: 1, row: 3 });
    // il filo principale arriva al pin S; un filo sale lungo il bordo del box fino al pin R
    expect(hasWire(l, [0, 0], [2, 0])).toBe(true);
    expect(hasWire(l, [2, 1], [2, 3])).toBe(true);
    expect(cell(l, o.id)).toMatchObject({ col: l.cols - 1, row: 0 });
    expect(l.cols).toBe(5);
    expect(l.rows).toBe(4);
    expect(l.slots.some((s) => 'box' in s.at && s.at.pin === 'R' && s.at.index === 2)).toBe(true);
  });

  it('box dopo un parallelo alto: la logica del pin R parte dalla colonna 0 senza sovrapposizioni', () => {
    const par: LadElem = {
      id: id(),
      k: 'parallel',
      branches: [[contact()], [contact()], [contact()]],
    };
    const r1 = contact();
    const r3 = contact();
    const bx = box('S_ODT', { R: [r1, contact(), r3] });
    const l = layoutNetwork(net(node([par, bx], [coil()])));
    // la logica sta sotto le tre righe del parallelo e del box del timer
    expect(cell(l, r1.id)).toMatchObject({ col: 0, row: 3 });
    expect(cell(l, r3.id)).toMatchObject({ col: 2, row: 3 });
    // il box si sposta a destra della parte più larga e la serie si allunga
    expect(cell(l, bx.id)).toMatchObject({ col: 3, row: 0 });
    expect(hasWire(l, [1, 0], [3, 0])).toBe(true);
    expect(hasWire(l, [3, 1], [3, 3])).toBe(true);
    expectNoOverlap(l);
    expectNoWireThroughCells(l);
    expectConnected(l);
  });

  it('ramo a T con la propria zona dei pin parte sotto quella del nodo', () => {
    const bx = box('S_ODT', { R: [contact()] });
    const inner = box('S_ODT', { R: [contact()] });
    const plain = contact();
    const l = layoutNetwork(
      net(node([bx], [coil(), node([plain], [coil()]), node([inner], [coil()])])),
    );
    // il ramo semplice sta sotto la prima uscita, quello con la zona dei pin sotto l'intera zona
    expect(cell(l, plain.id).row).toBe(1);
    expect(cell(l, inner.id).row).toBeGreaterThanOrEqual(4);
    expectNoOverlap(l);
    expectNoWireThroughCells(l);
    expectConnected(l);
  });

  it('ignora le chiavi boolPins uguali a EN o al primo pin', () => {
    const bx = box('S_ODT', { S: [contact()], R: [] });
    const mv = box('MOVE', { EN: [contact()] });
    const l = layoutNetwork(net(node([bx, mv], [coil()])));
    expect(l.cells.filter((x) => x.kind === 'contact')).toHaveLength(0);
    expect(cell(l, mv.id).pinRows).toEqual({ EN: 0, IN: 1 });
    expect(cell(l, mv.id).outRows).toEqual({ ENO: 0, OUT: 1 });
  });

  it('box con EN/ENO: altezza almeno 2', () => {
    const bx = box('MOVE');
    const l = layoutNetwork(net(node([bx], [coil()])));
    expect(cell(l, bx.id)).toMatchObject({ w: 2, h: 2 });
  });

  it('pin senza logica non riceve fili', () => {
    const bx = box('S_ODT');
    const l = layoutNetwork(net(node([bx], [coil()])));
    expect(l.wires.some((w) => w.from[1] === 1 || w.to[1] === 1)).toBe(false);
    expect(l.slots.some((s) => 'box' in s.at && s.at.pin === 'R' && s.at.index === 0)).toBe(true);
  });

  describe('rete con tutti i tipi', () => {
    const rich = (): LadNetwork => {
      const inner = box('S_ODT', {
        R: [
          contact(),
          { id: id(), k: 'parallel', branches: [[contact()], [contact(), contact()]] },
        ],
      });
      const par: LadElem = {
        id: id(),
        k: 'parallel',
        branches: [
          [contact(), { id: id(), k: 'not' }],
          [
            { id: id(), k: 'cmp', fn: '==I', in1: '', in2: '' },
            { id: id(), k: 'parallel', branches: [[contact()], [contact()], [inner]] },
          ],
          [{ id: id(), k: 'edge', dir: 'P', mem: '' }],
        ],
      };
      return net(
        node(
          [
            par,
            { id: id(), k: 'posneg', dir: 'P', bit: '', mem: '' },
            { id: id(), k: 'midline', op: '' },
            box('MOVE'),
          ],
          [
            coil(),
            node([contact()], [coil(), node([contact(), contact()], [coil(), coil()])]),
            coil(),
            node([par2()], [coil()]),
          ],
        ),
      );
    };
    const par2 = (): LadElem => ({
      id: id(),
      k: 'parallel',
      branches: [[contact()], [contact(), contact(), contact()]],
    });

    it("nessuna cella si sovrappone a un'altra e tutto sta nella griglia", () => {
      const l = layoutNetwork(rich());
      expectNoOverlap(l);
      for (const c of l.cells) {
        expect(c.col).toBeGreaterThanOrEqual(0);
        expect(c.row).toBeGreaterThanOrEqual(0);
        expect(c.col + c.w).toBeLessThanOrEqual(l.cols);
        expect(c.row + c.h).toBeLessThanOrEqual(l.rows);
      }
      for (const w of l.wires) {
        for (const [x, y] of [w.from, w.to]) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(l.cols);
          expect(y).toBeGreaterThanOrEqual(0);
          expect(y).toBeLessThan(l.rows);
        }
      }
    });

    it('nessun filo attraversa una cella e ogni cella è collegata', () => {
      const l = layoutNetwork(rich());
      expectNoWireThroughCells(l);
      expectConnected(l);
    });

    it('gli slot hanno tutti un punto diverso', () => {
      const l = layoutNetwork(rich());
      const keys = l.slots.map((s) => `${s.col},${s.row}`);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it("le uscite stanno tutte nell'ultima colonna", () => {
      const l = layoutNetwork(rich());
      const outs = l.cells.filter((c) => c.kind === 'out');
      expect(outs).toHaveLength(6);
      for (const o of outs) expect(o.col).toBe(l.cols - 1);
    });

    it("ogni punto d'inserimento è accettato da insertElem e ha una posizione nella griglia", () => {
      const base = rich();
      const l = layoutNetwork(base);
      expect(l.slots.length).toBeGreaterThan(10);
      for (const s of l.slots) {
        expect(() => insertElem(base, s.at, contact())).not.toThrow();
        expect(s.col).toBeGreaterThanOrEqual(0);
        expect(s.col).toBeLessThan(l.cols);
        expect(s.row).toBeGreaterThanOrEqual(0);
        expect(s.row).toBeLessThan(l.rows);
      }
    });

    it('è deterministico', () => {
      const base = rich();
      expect(layoutNetwork(base)).toEqual(layoutNetwork(base));
    });
  });
});
