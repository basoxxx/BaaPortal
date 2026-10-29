// Stato degli elementi da celle per riga scritte a mano (la verifica sul simulatore è in
// packages/project/test/kopStatus.test.ts).
import { describe, expect, it } from 'vitest';
import { networkStatus, networkToAwl } from '../src/index.js';
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
