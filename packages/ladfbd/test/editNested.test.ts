import { describe, expect, it } from 'vitest';
import {
  BOX_KINDS,
  PALETTE,
  addOutput,
  closeBranchAfter,
  emptyNetwork,
  findElem,
  insertElem,
  ladElemSchema,
  ladNetworkSchema,
  ladOutSchema,
  openBranch,
  removeElem,
  walk,
} from '../src/index.js';
import type { LadElem, LadNetwork, LadNode } from '../src/index.js';

const counter = (): (() => string) => {
  let n = 0;
  return () => `i${++n}`;
};
const contact = (id: string): LadElem => ({ id, k: 'contact', neg: false, op: '' });
const box = (id: string, boolPins: Record<string, LadElem[]> = {}): LadElem => ({
  id,
  k: 'box',
  box: 'S_ODT',
  instance: 'T 1',
  pins: {},
  boolPins,
});
const par = (e: LadElem | undefined) => {
  if (!e || e.k !== 'parallel') throw new Error('atteso parallelo');
  return e;
};
const ids = (l: LadElem[]) => l.map((e) => e.id);

function withSeries(series: LadElem[], newId = counter()): LadNetwork {
  const net = emptyNetwork(newId);
  net.root.series = series;
  return net;
}

describe('parallelo annidato', () => {
  it('un parallelo dentro un ramo si scioglie quando resta un solo ramo interno', () => {
    const newId = counter();
    const inner = openBranch(withSeries([contact('a')], newId), 'a', newId);
    const p1 = par(inner.root.series[0]);
    const nested = insertElem(
      inner,
      { branchOf: p1.id, branch: 1, index: 0 },
      { id: 'pp', k: 'parallel', branches: [[contact('q1')], [contact('q2')]] },
    );
    const gone = removeElem(nested, 'q2', newId);
    // il parallelo interno si scioglie nel ramo che lo contiene
    expect(ids(par(gone.root.series[0]).branches[1]!)).toEqual(['q1', p1.branches[1]![0]!.id]);
    expect(findElem(gone, 'pp')).toBeUndefined();
  });
});

describe('closeBranchAfter in contesti annidati', () => {
  it('con il parallelo dentro un ramo', () => {
    const newId = counter();
    const inner: LadElem = {
      id: 'pi',
      k: 'parallel',
      branches: [[contact('i1')], [contact('i2')]],
    };
    let net = withSeries([contact('a')], newId);
    net = openBranch(net, 'a', newId);
    const outer = par(net.root.series[0]);
    net = insertElem(net, { branchOf: outer.id, branch: 0, index: 1 }, inner);
    net = insertElem(net, { branchOf: outer.id, branch: 0, index: 2 }, contact('i3'));
    const closed = closeBranchAfter(net, 'i2', 'i3', newId);
    const b0 = par(closed.root.series[0]).branches[0]!;
    expect(ids(b0)).toEqual(['a', 'pi']);
    expect(ids(par(b0[1]).branches[0]!)).toEqual(['i1', 'i3']);
  });

  it('con il parallelo dentro un pin di un box', () => {
    const newId = counter();
    let net = withSeries([box('b1')], newId);
    net = insertElem(net, { box: 'b1', pin: 'R', index: 0 }, contact('r1'));
    net = insertElem(net, { box: 'b1', pin: 'R', index: 1 }, contact('r2'));
    net = openBranch(net, 'r1', newId);
    const b = findElem(net, 'b1');
    if (!b || !('boolPins' in b)) throw new Error('atteso box');
    const p = par(b.boolPins.R![0]);
    const closed = closeBranchAfter(net, p.branches[1]![0]!.id, 'r2', newId);
    const cb = findElem(closed, 'b1');
    if (!cb || !('boolPins' in cb)) throw new Error('atteso box');
    expect(cb.boolPins.R).toHaveLength(1);
    expect(ids(par(cb.boolPins.R![0]).branches[0]!)).toEqual(['r1', 'r2']);
  });
});

describe('boolPins', () => {
  it('inserisce in un pin vuoto, apre e rimuove', () => {
    const newId = counter();
    let net = withSeries([box('b1')], newId);
    net = insertElem(net, { box: 'b1', pin: 'R', index: 0 }, contact('r1'));
    expect(ids((findElem(net, 'b1') as Extract<LadElem, { k: 'box' }>).boolPins.R!)).toEqual([
      'r1',
    ]);
    net = openBranch(net, 'r1', newId);
    expect(walkIds(net)).toContain('r1');
    const p = par((findElem(net, 'b1') as Extract<LadElem, { k: 'box' }>).boolPins.R![0]);
    net = removeElem(net, p.branches[1]![0]!.id, newId);
    expect(ids((findElem(net, 'b1') as Extract<LadElem, { k: 'box' }>).boolPins.R!)).toEqual([
      'r1',
    ]);
    net = removeElem(net, 'r1', newId);
    expect((findElem(net, 'b1') as Extract<LadElem, { k: 'box' }>).boolPins.R).toEqual([]);
  });
});

const walkIds = (net: LadNetwork) => [...walk(net)].map((i) => i.id);

describe('insertElem: indici', () => {
  it('rifiuta un indice fuori intervallo', () => {
    const net = withSeries([contact('a')]);
    expect(() => insertElem(net, { node: net.root.id, index: 2 }, contact('z'))).toThrow();
    expect(() => insertElem(net, { node: net.root.id, index: -1 }, contact('z'))).toThrow();
    expect(() => insertElem(net, { box: 'nope', pin: 'R', index: 0 }, contact('z'))).toThrow();
  });
});

describe('nodi a T', () => {
  const tNode = (id: string, outs: LadNode['outs']): LadNode => ({ id, series: [], outs });

  it('addOutput su un nodo a T annidato', () => {
    const net0 = emptyNetwork(counter());
    const net = addOutput(net0, net0.root.id, tNode('t1', [{ id: 'o1', k: 'coil', op: '' }]));
    const net2 = addOutput(net, 't1', { id: 'o2', k: 'set', op: '' });
    const t1 = net2.root.outs[1] as LadNode;
    expect(t1.outs.map((o) => o.id)).toEqual(['o1', 'o2']);
  });

  it('pruneEmpty risale su due livelli e lascia una bobina via newId alla radice', () => {
    const newId = counter();
    const net0 = emptyNetwork(newId);
    const coilId = net0.root.outs[0]!.id;
    let net = addOutput(
      net0,
      net0.root.id,
      tNode('t1', [tNode('t2', [{ id: 'o1', k: 'coil', op: '' }])]),
    );
    net = removeElem(net, coilId, newId); // resta solo t1 > t2 > o1
    expect(net.root.outs.map((o) => o.id)).toEqual(['t1']);
    net = removeElem(net, 'o1', newId);
    // t2 vuoto -> tolto; t1 vuoto -> tolto; radice vuota -> bobina nuova
    expect(net.root.outs).toHaveLength(1);
    expect(net.root.outs[0]).toMatchObject({ k: 'coil', op: '' });
    expect(walkIds(net)).not.toContain('t1');
    expect(walkIds(net)).not.toContain('t2');
  });
});

describe('unicità degli id', () => {
  it('resta valida dopo una sequenza di operazioni', () => {
    const newId = counter();
    let net = withSeries([contact('a'), contact('b'), contact('c')], newId);
    net = openBranch(net, 'a', newId);
    net = openBranch(net, 'b', newId);
    net = insertElem(net, { node: net.root.id, index: 0 }, box('bx'));
    net = addOutput(net, net.root.id, { id: newId(), k: 'coil', op: '' });
    net = closeBranchAfter(net, par(net.root.series[1]).branches[1]![0]!.id, 'c', newId);
    net = removeElem(net, 'a', newId);
    const all = walkIds(net);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('palette', () => {
  it('ogni preset è valido per lo schema e le etichette usano lad.palette.', () => {
    const newId = counter();
    for (const e of PALETTE) {
      expect(e.label).toBe(`lad.palette.${e.id}`);
      const obj = { id: newId(), ...e.preset };
      const r = (e.where === 'elem' ? ladElemSchema : ladOutSchema).safeParse(obj);
      expect(r.success, e.id).toBe(true);
    }
    expect(PALETTE.some((e) => e.group === 'counters')).toBe(true);
    expect(BOX_KINDS.length).toBeGreaterThan(0);
  });

  it('una rete con il preset passa ladNetworkSchema', () => {
    expect(ladNetworkSchema.safeParse(emptyNetwork(counter())).success).toBe(true);
  });
});
