// Stato degli elementi da celle per riga scritte a mano (la verifica sul simulatore è in
// packages/project/test/kopStatus.test.ts).
import { describe, expect, it } from 'vitest';
import { networkStatus, networkToAwl } from '../src/index.js';
import type { LadBox, LadNetwork, LineState } from '../src/index.js';

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

  it('righe non chieste o non elaborate: nessuno stato', () => {
    expect(networkStatus(net, r.lines, new Map()).size).toBe(0);
    const none = new Map(r.lines.map((l) => [l.line, null]));
    expect(networkStatus(net, r.lines, none).size).toBe(0);
  });

  it('valori da ACCU1 sulle righe dei pin', () => {
    const cells = new Map(r.lines.map((l) => [l.line, on(l.pin ? 42 : 0)]));
    const st = networkStatus(net, r.lines, cells);
    expect(st.get('m')).toMatchObject({ in: true, out: true, values: { IN: 42, OUT: 42 } });
    expect(st.get('q')).toEqual({ in: true, out: true });
  });
});
