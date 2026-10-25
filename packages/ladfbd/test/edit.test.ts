import { describe, expect, it } from 'vitest';
import {
  addOutput,
  closeBranchAfter,
  emptyNetwork,
  findElem,
  insertElem,
  openBranch,
  removeElem,
  updateElem,
  walk,
} from '../src/index.js';
import type { LadElem, LadNetwork, LadNode } from '../src/index.js';

function counter(): () => string {
  let n = 0;
  return () => `i${++n}`;
}
const contact = (id: string, op = ''): LadElem => ({ id, k: 'contact', neg: false, op });

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

function twoContacts(newId = counter()): LadNetwork {
  let net = emptyNetwork(newId);
  net = insertElem(net, { node: net.root.id, index: 0 }, contact('c1', 'I 0.0'));
  return insertElem(net, { node: net.root.id, index: 1 }, contact('c2', 'I 0.1'));
}

describe('emptyNetwork', () => {
  it('ha serie vuota e una bobina senza operando', () => {
    const net = emptyNetwork(counter());
    expect(net.root.series).toEqual([]);
    expect(net.root.outs).toEqual([{ id: 'i2', k: 'coil', op: '' }]);
  });
});

describe('openBranch / removeElem', () => {
  it('avvolge il primo contatto in un parallelo e lo scioglie rimuovendo il ramo', () => {
    const newId = counter();
    const net = twoContacts(newId);
    const open = openBranch(net, 'c1', newId);
    const par = open.root.series[0]!;
    expect(par.k).toBe('parallel');
    if (par.k !== 'parallel') return;
    expect(par.branches).toHaveLength(2);
    expect(par.branches[0]).toEqual([contact('c1', 'I 0.0')]);
    const nuovo = par.branches[1]![0]!;
    expect(nuovo).toMatchObject({ k: 'contact', neg: false, op: '' });
    expect(open.root.series[1]!.id).toBe('c2');

    const back = removeElem(open, nuovo.id);
    expect(back.root.series.map((e) => e.id)).toEqual(['c1', 'c2']);
  });

  it('su un elemento già in un parallelo aggiunge un ramo', () => {
    const newId = counter();
    const open = openBranch(twoContacts(newId), 'c1', newId);
    const again = openBranch(open, 'c1', newId);
    const par = again.root.series[0]!;
    expect(par.k === 'parallel' && par.branches).toHaveLength(3);
    expect(again.root.series).toHaveLength(2);
  });

  it('eliminare un ramo con altri elementi lascia gli altri', () => {
    const newId = counter();
    const open = openBranch(twoContacts(newId), 'c1', newId);
    const par = open.root.series[0]!;
    if (par.k !== 'parallel') throw new Error('atteso parallelo');
    const added = insertElem(open, { branchOf: par.id, branch: 1, index: 1 }, contact('c9'));
    const removed = removeElem(added, par.branches[1]![0]!.id);
    const p2 = removed.root.series[0]!;
    expect(p2.k === 'parallel' && p2.branches).toHaveLength(2);
  });

  it('rimuovere un elemento semplice e rifiutare la radice o un id ignoto', () => {
    const net = twoContacts();
    expect(removeElem(net, 'c1').root.series.map((e) => e.id)).toEqual(['c2']);
    expect(() => removeElem(net, net.root.id)).toThrow();
    expect(() => removeElem(net, 'nope')).toThrow();
  });
});

describe('closeBranchAfter', () => {
  it('porta nel percorso principale gli elementi fino al bersaglio', () => {
    const newId = counter();
    let net = twoContacts(newId);
    net = insertElem(net, { node: net.root.id, index: 2 }, contact('c3'));
    net = openBranch(net, 'c1', newId);
    const par = net.root.series[0]!;
    if (par.k !== 'parallel') throw new Error('atteso parallelo');
    const closed = closeBranchAfter(net, par.branches[1]![0]!.id, 'c3', newId);
    expect(closed.root.series).toHaveLength(1);
    const p = closed.root.series[0]!;
    if (p.k !== 'parallel') throw new Error('atteso parallelo');
    expect(p.branches[0]!.map((e) => e.id)).toEqual(['c1', 'c2', 'c3']);
    expect(p.branches[1]).toHaveLength(1);
  });

  it('con tre rami raggruppa gli altri in un parallelo annidato', () => {
    const newId = counter();
    let net = twoContacts(newId);
    net = openBranch(net, 'c1', newId);
    net = openBranch(net, 'c1', newId);
    const par = net.root.series[0]!;
    if (par.k !== 'parallel') throw new Error('atteso parallelo');
    const last = par.branches[2]![0]!.id;
    const closed = closeBranchAfter(net, last, 'c2', newId);
    const p = closed.root.series[0]!;
    if (p.k !== 'parallel') throw new Error('atteso parallelo');
    expect(p.branches).toHaveLength(2);
    expect(p.branches[0]![0]!.k).toBe('parallel');
    expect(p.branches[0]!.at(-1)!.id).toBe('c2');
    expect(closed.root.series).toHaveLength(1);
  });

  it('rifiuta un bersaglio che non segue il parallelo', () => {
    const newId = counter();
    const net = openBranch(twoContacts(newId), 'c1', newId);
    const par = net.root.series[0]!;
    if (par.k !== 'parallel') throw new Error('atteso parallelo');
    expect(() => closeBranchAfter(net, par.branches[1]![0]!.id, 'zzz', newId)).toThrow();
  });
});

describe('addOutput', () => {
  it('con un nodo crea un ramo a T; togliere l’ultima uscita toglie il nodo', () => {
    const net = twoContacts();
    const t: LadNode = {
      id: 't1',
      series: [contact('c5')],
      outs: [{ id: 'o5', k: 'coil', op: 'Q 4.0' }],
    };
    const withT = addOutput(net, net.root.id, t);
    expect(withT.root.outs).toHaveLength(2);
    expect(withT.root.outs[1]).toEqual(t);
    const none = removeElem(withT, 'o5');
    expect(none.root.outs).toHaveLength(1);
  });

  it('l’ultima uscita della radice diventa una bobina vuota', () => {
    const net = twoContacts();
    const coilId = net.root.outs[0]!.id;
    const r = removeElem(net, coilId);
    expect(r.root.outs).toHaveLength(1);
    expect(r.root.outs[0]).toMatchObject({ k: 'coil', op: '' });
  });
});

describe('updateElem / findElem / walk', () => {
  it('aggiorna NA ↔ NC e operandi, ignorando id', () => {
    const net = twoContacts();
    const u = updateElem(net, 'c1', { neg: true, op: 'M 1.0', id: 'x' });
    expect(findElem(u, 'c1')).toMatchObject({ neg: true, op: 'M 1.0' });
    expect(findElem(u, 'x')).toBeUndefined();
    expect(() => updateElem(net, 'nope', {})).toThrow();
  });

  it('walk visita anche i rami e i pin dei box', () => {
    const newId = counter();
    let net = openBranch(twoContacts(newId), 'c1', newId);
    const box: LadElem = {
      id: 'b1',
      k: 'box',
      box: 'S_ODT',
      instance: 'T 1',
      pins: { TV: 'S5T#5S' },
      boolPins: { R: [contact('r1')] },
    };
    net = insertElem(net, { node: net.root.id, index: 2 }, box);
    const ids = [...walk(net)].map((i) => i.id);
    expect(ids).toContain('r1');
    expect(ids).toContain('b1');
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('purezza', () => {
  it('nessuna funzione modifica l’argomento', () => {
    const newId = counter();
    const net = deepFreeze(twoContacts(newId));
    const op = openBranch(net, 'c1', newId);
    deepFreeze(op);
    const par = op.root.series[0]!;
    if (par.k !== 'parallel') throw new Error('atteso parallelo');
    const nid = par.branches[1]![0]!.id;
    expect(() => insertElem(net, { node: net.root.id, index: 0 }, contact('z'))).not.toThrow();
    expect(() => closeBranchAfter(op, nid, 'c2', newId)).not.toThrow();
    expect(() => addOutput(net, net.root.id, { id: 'o9', k: 'coil', op: '' })).not.toThrow();
    expect(() => removeElem(op, nid)).not.toThrow();
    expect(() => updateElem(net, 'c1', { neg: true })).not.toThrow();
    expect(net.root.series).toHaveLength(2);
  });
});
