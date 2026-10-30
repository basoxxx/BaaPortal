import { describe, expect, it } from 'vitest';
import { BOX_CATALOG, BOX_KINDS, ladNetworkSchema } from '../src/index.js';
import type { LadNetwork } from '../src/index.js';

const full: LadNetwork = {
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
        pins: { TV: 'S5T#5S' },
        boolPins: { R: [{ id: 'e11', k: 'contact', neg: false, op: 'I 0.3' }] },
      },
    ],
    outs: [
      { id: 'o1', k: 'coil', op: 'Q 4.0' },
      { id: 'o2', k: 'tcoil', fn: 'SD', timer: 'T 2', value: 'S5T#1S' },
      { id: 'o3', k: 'ccoil', fn: 'SC', counter: 'C 1', value: 'C#5' },
      { id: 'o4', k: 'jmp', label: 'FINE' },
      { id: 'o5', k: 'ret' },
      { id: 'o6', k: 'callCoil', block: 'FC 11' },
      { id: 'o7', k: 'opn', db: 'DB 10' },
      {
        id: 'n1',
        series: [{ id: 'e12', k: 'contact', neg: false, op: 'I 1.0' }],
        outs: [{ id: 'o8', k: 'set', op: 'Q 4.1' }],
      },
    ],
  },
};

describe('ladNetworkSchema', () => {
  it('accetta una rete con tutti i tipi di elemento e di uscita', () => {
    expect(ladNetworkSchema.parse(full)).toEqual(full);
  });

  it('rifiuta un k sconosciuto', () => {
    const bad = structuredClone(full) as unknown as { root: { series: { k: string }[] } };
    bad.root.series[0]!.k = 'boh';
    expect(ladNetworkSchema.safeParse(bad).success).toBe(false);
  });

  it('rifiuta un parallelo con meno di 2 rami', () => {
    const bad = structuredClone(full) as unknown as {
      root: { series: { branches?: unknown[] }[] };
    };
    bad.root.series[6]!.branches = [];
    expect(ladNetworkSchema.safeParse(bad).success).toBe(false);
  });

  it('conserva le chiavi in più', () => {
    const extra = structuredClone(full) as unknown as {
      futuro?: number;
      root: { series: Record<string, unknown>[] };
    };
    extra.futuro = 1;
    extra.root.series[0]!.nuovo = 'x';
    const parsed = ladNetworkSchema.parse(extra) as unknown as typeof extra;
    expect(parsed.futuro).toBe(1);
    expect(parsed.root.series[0]!.nuovo).toBe('x');
  });
});

describe('BOX_CATALOG', () => {
  it('copre ogni BoxKind', () => {
    for (const k of BOX_KINDS) expect(BOX_CATALOG[k].kind).toBe(k);
  });

  it('S_ODT segue §3.2', () => {
    expect(BOX_CATALOG.S_ODT).toMatchObject({
      en: false,
      firstPin: 'S',
      boolInputs: ['R'],
      dataInputs: [{ name: 'TV', type: 'S5TIME' }],
      outputs: [
        { name: 'BI', type: 'WORD' },
        { name: 'BCD', type: 'WORD' },
        { name: 'Q', type: 'BOOL' },
      ],
      awl: 'SD',
    });
  });

  it('canFail segue la colonna errore', () => {
    expect(BOX_CATALOG.ADD_I.canFail).toBe(true);
    expect(BOX_CATALOG.MOVE.canFail).toBe(false);
    expect(BOX_CATALOG.NEG_R.canFail).toBe(false);
    expect(BOX_CATALOG.I_BCD.canFail).toBe(true);
    expect(BOX_CATALOG.SHL_W.canFail).toBe(false);
  });
});
