import { describe, expect, it } from 'vitest';
import { mapOperands } from '../src/index.js';
import type { LadElem, LadNetwork, LadNode, LadOut } from '../src/index.js';

const net: LadNetwork = {
  label: 'Rete 1',
  root: {
    id: 'n0',
    series: [
      { id: 'e1', k: 'contact', neg: true, op: 'I 0.0' },
      { id: 'e2', k: 'not' },
      { id: 'e3', k: 'cmp', fn: '>=R', in1: 'MD 0', in2: 'MD 4' },
      { id: 'e4', k: 'edge', dir: 'P', mem: 'M 0.0' },
      { id: 'e5', k: 'posneg', dir: 'N', bit: 'I 0.1', mem: 'M 0.1' },
      { id: 'e6', k: 'midline', op: 'M 0.2' },
      {
        id: 'e7',
        k: 'parallel',
        branches: [[{ id: 'e8', k: 'contact', neg: false, op: 'I 0.2' }], [{ id: 'e9', k: 'not' }]],
      },
      {
        id: 'e10',
        k: 'box',
        box: 'S_ODT',
        instance: 'T 1',
        pins: { TV: 'S5T#5S', Q: '' },
        boolPins: { R: [{ id: 'e11', k: 'contact', neg: false, op: 'I 0.3' }] },
      },
      {
        id: 'e12',
        k: 'box',
        box: 'CALL',
        instance: 'FB 1, DB 2',
        pins: { start: 'M 5.0' },
        boolPins: {},
      },
    ],
    outs: [
      { id: 'o1', k: 'coil', op: 'Q 4.0' },
      { id: 'o1b', k: 'set', op: 'Q 4.1' },
      { id: 'o1c', k: 'reset', op: 'Q 4.2' },
      { id: 'o2', k: 'tcoil', fn: 'SD', timer: 'T 2', value: 'S5T#1S' },
      { id: 'o3', k: 'ccoil', fn: 'SC', counter: 'C 1', value: 'C#5' },
      { id: 'o4', k: 'jmp', label: 'FINE' },
      { id: 'o4b', k: 'jmpn', label: 'FINE' },
      { id: 'o5', k: 'ret' },
      { id: 'o5b', k: 'save' },
      { id: 'o5c', k: 'mcrOpen' },
      { id: 'o5d', k: 'mcrClose' },
      { id: 'o5e', k: 'mcra' },
      { id: 'o5f', k: 'mcrd' },
      { id: 'o6', k: 'callCoil', block: 'FC 11' },
      { id: 'o7', k: 'opn', db: 'DB 10' },
      { id: 'n1', series: [{ id: 'e13', k: 'contact', neg: false, op: 'I 1.0' }], outs: [] },
    ],
  },
};

// Chiavi che non sono operandi: tutto il resto di tipo stringa deve passare dal mapper.
const NOT_OPERANDS = new Set(['id', 'k', 'box', 'fn', 'dir', 'label']);

function leaves(x: unknown, key = '', out: [string, string][] = []): [string, string][] {
  if (typeof x === 'string') {
    if (!NOT_OPERANDS.has(key)) out.push([key, x]);
  } else if (Array.isArray(x)) x.forEach((v) => leaves(v, key, out));
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) leaves(v, k, out);
  return out;
}

const kinds = (n: LadNetwork): Set<string> => {
  const s = new Set<string>();
  const elems = (l: LadElem[]) =>
    l.forEach((e) => {
      s.add(e.k);
      if (e.k === 'parallel') e.branches.forEach(elems);
      if (e.k === 'box') Object.values(e.boolPins).forEach(elems);
    });
  const node = (x: LadNode) => {
    elems(x.series);
    x.outs.forEach((o: LadOut | LadNode) => ('series' in o ? node(o) : s.add(o.k)));
  };
  node(n.root);
  return s;
};

describe('mapOperands', () => {
  it('il fixture contiene ogni tipo di elemento e di uscita del modello', () => {
    expect([...kinds(net)].sort()).toEqual(
      [
        'contact',
        'not',
        'cmp',
        'edge',
        'posneg',
        'midline',
        'parallel',
        'box',
        'coil',
        'set',
        'reset',
        'tcoil',
        'ccoil',
        'jmp',
        'jmpn',
        'ret',
        'save',
        'mcrOpen',
        'mcrClose',
        'mcra',
        'mcrd',
        'callCoil',
        'opn',
      ].sort(),
    );
  });

  it('passa ogni operando dal mapper (tutte le stringhe non strutturali) e nient altro', () => {
    const r = mapOperands(net, (v) => (v === '' ? v : `<${v}>`));
    const before = leaves(net);
    const after = leaves(r);
    expect(after).toHaveLength(before.length);
    before.forEach(([key, v], i) => {
      expect(after[i]![0]).toBe(key);
      expect(after[i]![1], `${key}=${v}`).toBe(v === '' ? v : `<${v}>`);
    });
    expect(r.label).toBe('Rete 1');
  });

  it('le etichette dei salti restano; i ruoli distinguono operando, blocco chiamato e DB', () => {
    const seen: string[] = [];
    const r = mapOperands(net, (v, role) => (seen.push(`${role}:${v}`), v));
    expect(seen).toContain('call:FB 1, DB 2');
    expect(seen).toContain('call:FC 11');
    expect(seen).toContain('db:DB 10');
    expect(seen).toContain('op:T 1');
    expect(seen.some((s) => s.includes('FINE'))).toBe(false);
    expect(r).toEqual(net);
  });

  it('non muta l ingresso e conserva gli id; rinomina le chiavi dei pin con pinName', () => {
    const copy = structuredClone(net);
    const r = mapOperands(
      net,
      (v) => v + '!',
      (b, k) => (b.box === 'CALL' ? k.toUpperCase() : k),
    );
    expect(net).toEqual(copy);
    expect(r.root.id).toBe('n0');
    const call = r.root.series.find((e) => e.id === 'e12');
    expect(call?.k === 'box' && Object.keys(call.pins)).toEqual(['START']);
    const timer = r.root.series.find((e) => e.id === 'e10');
    expect(timer?.k === 'box' && Object.keys(timer.pins)).toEqual(['TV', 'Q']);
  });
});
