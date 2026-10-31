// Stato degli elementi da celle per riga scritte a mano (la verifica sul simulatore è in
// packages/project/test/kopStatus.test.ts).
import { describe, expect, it } from 'vitest';
import { awlToLad, networkStatus, networkToAwl } from '../src/index.js';
import type { LadBox, LadElem, LadNetwork, LadOut, LineOwner, LineState } from '../src/index.js';

const on = (accu1 = 0): LineState => ({ rlo: true, sta: true, accu1 });

describe('networkStatus', () => {
  const move: LadBox = {
    id: 'm',
    k: 'box',
    box: 'MOVE',
    instance: '',
    pins: { IN: 'MW 10', OUT: 'MW 12' },
    boolPins: {},
  };
  const net: LadNetwork = {
    root: {
      id: 'r',
      series: [{ id: 'a', k: 'contact', neg: false, op: 'I 0.0' }, move],
      outs: [{ id: 'q', k: 'coil', op: 'Q 4.0' }],
    },
  };
  const r = networkToAwl(net, { tempEnd: 0, firstLabel: 1 });

  it('la mappa delle righe segna le righe dei pin', () => {
    const pins = r.lines.filter((l) => l.pin).map((l) => [l.elemId, l.pin]);
    expect(pins).toEqual([
      ['m', 'IN'],
      ['m', 'OUT'],
    ]);
  });

  it('righe non chieste: sconosciuto; non elaborate: notRun (o sconosciuto con nullUnknown)', () => {
    const empty = networkStatus(net, r.lines, new Map());
    expect([...empty.values()].every((x) => x.unknown && x.out === undefined)).toBe(true);
    const none = new Map(r.lines.map((l) => [l.line, null]));
    const st = networkStatus(net, r.lines, none);
    for (const id of ['a', 'm', 'q', 'r']) expect(st.get(id)).toEqual({ notRun: true });
    const wait = networkStatus(net, r.lines, none, { nullUnknown: true });
    expect([...wait.values()].every((x) => x.unknown && !x.notRun)).toBe(true);
  });

  it('valori da ACCU1 sulle righe dei pin', () => {
    const cells = new Map(r.lines.map((l) => [l.line, on(l.pin ? 42 : 0)]));
    const st = networkStatus(net, r.lines, cells);
    expect(st.get('m')).toMatchObject({ in: true, out: true, values: { IN: 42, OUT: 42 } });
    expect(st.get('q')).toEqual({ in: true, out: true });
  });

  it('box CALL: ogni parametro ha la sua riga e il suo valore', () => {
    const call: LadBox = {
      id: 'c',
      k: 'box',
      box: 'CALL',
      instance: 'FB 1, DB 1',
      pins: { SP: 'MW 10', PV: 'MD 20', EMPTY: '' },
      boolPins: {},
    };
    const cn: LadNetwork = { root: { id: 'r', series: [call], outs: [] } };
    const rc = networkToAwl(cn, { tempEnd: 0, firstLabel: 1 });
    const text = rc.source.split('\n');
    const pinLines = rc.lines.filter((l) => l.pin);
    expect(pinLines.map((l) => [l.pin, text[l.line]!.trim().split(' ')[0]])).toEqual([
      ['SP', 'SP'],
      ['PV', 'PV'],
    ]);
    // solo le righe con una cella (copie osservate dal compilato) danno un valore
    const cells = new Map(rc.lines.map((l) => [l.line, on(l.pin === 'SP' ? 7 : 0)]));
    cells.delete(pinLines[1]!.line);
    expect(networkStatus(cn, rc.lines, cells).get('c')?.values).toEqual({ SP: 7 });
  });
});

/** Celle tutte a 1 fino alla riga `cut` compresa; dopo assenti (fuori finestra) o `null`. */
function cutAt(lines: LineOwner[], cut: number, after: 'absent' | 'null') {
  const m = new Map<number, LineState>();
  for (const l of lines) {
    if (l.line <= cut) m.set(l.line, on(5));
    else if (after === 'null') m.set(l.line, null);
  }
  return m;
}

describe('networkStatus: elemento tagliato dalla finestra', () => {
  const s: LadElem = { id: 's', k: 'contact', neg: false, op: 'I 0.0' };
  const q: LadOut = { id: 'q', k: 'coil', op: 'Q 4.0' };
  const mk = (e: LadElem, before = true): LadNetwork => ({
    root: { id: 'r', series: before ? [s, e] : [e], outs: [q] },
  });
  /** Nome, rete, indice tra le righe dell'elemento dopo cui la finestra finisce. */
  const cases: [string, LadNetwork, number][] = [
    [
      'temporizzatore S_ODT dopo SD',
      mk({
        id: 'e',
        k: 'box',
        box: 'S_ODT',
        instance: 'T 1',
        pins: { TV: 'S5T#5S' },
        boolPins: {},
      }),
      1,
    ],
    [
      'confronto da capo dopo L in2',
      mk({ id: 'e', k: 'cmp', fn: '==I', in1: 'MW 1', in2: 'MW 2' }, false),
      1,
    ],
    ['confronto dopo L in2', mk({ id: 'e', k: 'cmp', fn: '==I', in1: 'MW 1', in2: 'MW 2' }), 2],
    ['POS dopo A bit', mk({ id: 'e', k: 'posneg', dir: 'P', bit: 'I 0.1', mem: 'M 0.0' }), 1],
    [
      'box EN dentro il corpo',
      mk({
        id: 'e',
        k: 'box',
        box: 'MOVE',
        instance: '',
        pins: { IN: 'MW 10', OUT: 'MW 12' },
        boolPins: {},
      }),
      1,
    ],
  ];
  for (const [name, n, at] of cases) {
    const r = networkToAwl(n, { tempEnd: 0, firstLabel: 1 });
    const cut = r.lines.filter((l) => l.elemId === 'e')[at]!.line;
    it(`${name}: uscita sconosciuta, non lo stato di una riga intermedia`, () => {
      expect(r.lines.filter((l) => l.elemId === 'e').at(-1)!.line).toBeGreaterThan(cut);
      const st = networkStatus(n, r.lines, cutAt(r.lines, cut, 'absent'));
      expect(st.get('e')).toMatchObject({ unknown: true });
      expect(st.get('e')!.out).toBeUndefined();
      expect(st.get('q')).toMatchObject({ unknown: true });
      expect(st.get('r')).toBeUndefined();
    });
    it(`${name}: righe dopo non elaborate → notRun`, () => {
      const st = networkStatus(n, r.lines, cutAt(r.lines, cut, 'null'));
      expect(st.get('e')).toEqual({ notRun: true });
      expect(st.get('q')).toEqual({ notRun: true });
      expect(st.get('r')).toEqual({ notRun: true });
      const wait = networkStatus(n, r.lines, cutAt(r.lines, cut, 'null'), { nullUnknown: true });
      expect(wait.get('e')).toMatchObject({ unknown: true });
    });
  }

  it('contatto: STA solo dalla sua riga', () => {
    const n = mk({ id: 'e', k: 'contact', neg: false, op: 'I 0.1' });
    const r = networkToAwl(n, { tempEnd: 0, firstLabel: 1 });
    const st = networkStatus(n, r.lines, cutAt(r.lines, 0, 'absent'));
    expect(st.get('s')).toMatchObject({ sta: true, out: true });
    expect(st.get('e')).toMatchObject({ in: true, unknown: true });
    expect(st.get('e')!.sta).toBeUndefined();
  });
});

describe('networkStatus: NOT in un ramo con il bit del flusso (H21)', () => {
  it('il NOT dà 1 con il flusso davanti a 0: l’RLO del ramo contiene già il flusso', () => {
    const n: LadElem = { id: 'n', k: 'not' };
    const b: LadElem = { id: 'b', k: 'contact', neg: false, op: 'I 0.1' };
    const p: LadElem = { id: 'p', k: 'parallel', branches: [[n], [b]] };
    const net: LadNetwork = {
      root: {
        id: 'r',
        series: [{ id: 'a', k: 'contact', neg: false, op: 'I 0.0' }, p],
        outs: [{ id: 'q', k: 'coil', op: 'Q 4.0' }],
      },
    };
    const r = networkToAwl(net, { tempEnd: 0, firstLabel: 1 });
    // I 0.0 = 0: l'RLO è 0 fino al NOT, che lo porta a 1
    const high = new Set(['n', 'p', 'q']);
    const cells = new Map<number, LineState>(
      r.lines.map((l) => [l.line, { rlo: high.has(l.elemId), sta: false, accu1: 0 }]),
    );
    const st = networkStatus(net, r.lines, cells);
    expect(st.get('a')).toMatchObject({ out: false });
    expect(st.get('n')).toMatchObject({ in: false, out: true });
    expect(st.get('p')).toMatchObject({ out: true });
  });
});

describe('networkStatus: bit del flusso dentro un gruppo', () => {
  it('con flusso 0 dalla barra il parallelo nel gruppo non mostra flusso', () => {
    let n = 0;
    const src =
      'A I0.0\nA(\nA I0.1\n= L20.0\nO(\nA L20.0\nNOT\n)\nO(\nA L20.0\nA I0.2\n)\nNOT\n)\n= Q0.0';
    const r = awlToLad(src, { tempEnd: 20, firstLabel: 1, newId: () => `i${++n}` });
    if (!r.ok) throw new Error('conversione fallita');
    const net = r.network;
    const t = networkToAwl(net, { tempEnd: 20, firstLabel: 1 });
    const group = net.root.series[1];
    if (group?.k !== 'parallel') throw new Error('gruppo atteso');
    const par = group.branches[0]![1]!;
    if (par.k !== 'parallel') throw new Error('parallelo atteso');
    const branchNot = par.branches[0]![0]!;
    const cells = new Map<number, LineState | null>(
      t.lines.map((l) => [l.line, { rlo: false, sta: false, accu1: 0 }]),
    );
    // l'RLO dentro il gruppo (dove sta il NOT del ramo) è 1, ma il flusso dalla barra è 0
    cells.set(t.lines.filter((l) => l.elemId === branchNot.id).at(-1)!.line, on());
    const st = networkStatus(net, t.lines, cells);
    expect(st.get(par.id)?.out).not.toBe(true);
    expect(st.get(branchNot.id)?.out).not.toBe(true);
  });
});
