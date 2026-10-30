// Negazione di un'entrata in mezzo alla serie: gruppo `A( … NOT )` (parallelo di un solo ramo).
import { describe, expect, it } from 'vitest';
import {
  awlToLad,
  insertElem,
  negateElem,
  networkToAwl,
  removeElem,
  validateNetwork,
} from '../src/index.js';
import type { LadElem, LadNetwork } from '../src/index.js';

let seq = 0;
const nid = () => `n${++seq}`;
const c = (op: string): LadElem => ({ id: nid(), k: 'contact', neg: false, op });
const cmp = (): LadElem => ({ id: nid(), k: 'cmp', fn: '>I', in1: 'MW 10', in2: 'MW 12' });
const par = (...branches: LadElem[][]): LadElem => ({ id: nid(), k: 'parallel', branches });
const net = (series: LadElem[]): LadNetwork => ({
  root: { id: nid(), series, outs: [{ id: nid(), k: 'coil', op: 'Q 4.0' }] },
});
const OPTS = { tempEnd: 20, firstLabel: 1 };
const awl = (n: LadNetwork) => {
  const r = networkToAwl(n, OPTS);
  expect(r.diagnostics).toEqual([]);
  return r.source.split('\n').map((l) => l.trim().replace(/\s+/g, ' '));
};

describe('negateElem', () => {
  it('un confronto dopo un contatto: A( … NOT ) e andata e ritorno', () => {
    const cm = cmp();
    const n = negateElem(net([c('I 0.0'), cm]), cm.id, nid);
    expect(validateNetwork(n)).toEqual([]);
    expect(awl(n)).toEqual([
      'A %I0.0;',
      'A(;',
      'L %MW10;',
      'L %MW12;',
      '>I;',
      'NOT;',
      ');',
      '= %Q4.0;',
    ]);
    const src = networkToAwl(n, OPTS).source;
    const r = awlToLad(src, { ...OPTS, newId: nid });
    if (!r.ok) throw new Error('non convertita');
    expect(r.network.root.series[1]).toMatchObject({ k: 'parallel' });
    expect(networkToAwl(r.network, OPTS).source).toBe(src);
  });

  it('sulla barra il gruppo dà lo stesso AWL del NOT diretto', () => {
    const cm = cmp();
    const n = negateElem(net([cm]), cm.id, nid);
    const direct = net([cmp(), { id: nid(), k: 'not' }]);
    expect(awl(n)).toEqual(awl(direct));
  });

  it('un parallelo dopo un contatto', () => {
    const p = par([c('I 0.1')], [c('I 0.2')]);
    const n = negateElem(net([c('I 0.0'), p]), p.id, nid);
    expect(validateNetwork(n)).toEqual([]);
    const src = networkToAwl(n, OPTS).source;
    const r = awlToLad(src, { ...OPTS, newId: nid });
    if (!r.ok) throw new Error('non convertita');
    expect(networkToAwl(r.network, OPTS).source).toBe(src);
  });

  it('un contatto non si nega con un gruppo', () => {
    const k = c('I 0.1');
    expect(() => negateElem(net([c('I 0.0'), k]), k.id, nid)).toThrow(/non si nega/);
  });

  it('togliere il NOT scioglie il gruppo', () => {
    const cm = cmp();
    const n = negateElem(net([c('I 0.0'), cm]), cm.id, nid);
    const g = n.root.series[1] as Extract<LadElem, { k: 'parallel' }>;
    const back = removeElem(n, g.branches[0]![1]!.id, nid);
    expect(back.root.series.map((e) => e.k)).toEqual(['contact', 'cmp']);
  });

  it("togliere l'entrata di un gruppo toglie anche il suo NOT", () => {
    const cm = cmp();
    const n = negateElem(net([c('I 0.0'), cm]), cm.id, nid);
    const back = removeElem(n, cm.id, nid);
    expect(back.root.series.map((e) => e.k)).toEqual(['contact']);
    expect(awl(back)).toEqual(['A %I0.0;', '= %Q4.0;']);
  });

  it("insertElem rifiuta un'uscita", () => {
    const coil = { id: nid(), k: 'coil', op: 'Q 4.1' } as unknown as LadElem;
    expect(() => insertElem(net([]), { node: 'x', index: 0 }, coil)).toThrow(/non è un elemento/);
  });
});
