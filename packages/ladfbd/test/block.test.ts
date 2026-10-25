// Traduzione di un blocco intero: etichette automatiche numerate nel blocco (H11) e AWL che
// passa il controllo del pacchetto awl.
import { describe, expect, it } from 'vitest';
import { checkBlockCode, parseNetwork } from '@baaportal/awl';
import { blockToAwl } from '../src/index.js';
import type { LadBox, LadElem, LadNetwork, LadNode, LadOut } from '../src/index.js';
import { el, emptyIface, m, makeCtx } from '../../awl/test/ctx.js';

let seq = 0;
const nid = (p: string) => `${p}${++seq}`;
const c = (op: string): LadElem => ({ id: nid('c'), k: 'contact', neg: false, op });
const coil = (op: string): LadOut => ({ id: nid('o'), k: 'coil', op });
const move = (from: string, to: string): LadBox => ({
  id: nid('b'),
  k: 'box',
  box: 'MOVE',
  instance: '',
  pins: { IN: from, OUT: to },
  boolPins: {},
});
const net = (series: LadElem[], outs: (LadOut | LadNode)[] = []): LadNetwork => ({
  root: { id: nid('N'), series, outs },
});

const sources = (r: ReturnType<typeof blockToAwl>) => r.networks.map((n) => n?.source ?? '');

describe('blockToAwl', () => {
  it('due segmenti con un box ciascuno: _001 e _002', () => {
    const r = blockToAwl(
      [net([c('I 0.0'), move('MW 10', 'MW 12')]), net([c('I 0.1'), move('MW 14', 'MW 16')])],
      0,
    );
    const [a, b] = sources(r);
    expect(a).toContain('JNB _001');
    expect(a).not.toContain('_002');
    expect(b).toContain('JNB _002');
    expect(b).not.toContain('_001');
    expect(r.networks.map((n) => n?.nextLabel)).toEqual([2, 3]);
  });

  it('un segmento null in mezzo non consuma etichette e resta null', () => {
    const r = blockToAwl(
      [net([c('I 0.0'), move('MW 10', 'MW 12')]), null, net([c('I 0.1'), move('MW 14', 'MW 16')])],
      0,
    );
    expect(r.networks[1]).toBeNull();
    expect(r.networks[2]?.source).toContain('JNB _002');
  });

  it('un segmento con errori non consuma etichette', () => {
    const r = blockToAwl(
      [net([c(''), move('MW 10', 'MW 12')]), net([c('I 0.1'), move('MW 14', 'MW 16')])],
      0,
    );
    expect(r.networks[0]?.diagnostics).not.toEqual([]);
    expect(r.networks[1]?.source).toContain('JNB _001');
  });

  it('ogni sorgente si analizza e il blocco passa il controllo AWL', () => {
    const call: LadBox = {
      id: nid('b'),
      k: 'box',
      box: 'CALL',
      instance: 'FC 1',
      pins: { A: 'MW 20', R: 'MW 22' },
      boolPins: {},
    };
    const r = blockToAwl(
      [
        net([c('I 0.0'), move('MW 10', 'MW 12')], [coil('Q 4.0')]),
        net([c('I 0.1'), move('MW 14', 'MW 16')]),
        net([c('I 0.2'), call], [coil('Q 4.1')]),
        net(
          [c('I 0.3')],
          [coil('Q 4.2'), { id: nid('N'), series: [c('I 0.4')], outs: [coil('Q 4.3')] }],
        ),
      ],
      2,
      { callParams: (inst) => (inst === 'FC 1' ? ['A', 'R'] : undefined) },
    );
    const src = sources(r);
    for (const s of src) expect(parseNetwork(s, 'international').errors).toEqual([]);
    // FC con 2 byte di TEMP: i bit automatici partono da L 2.0
    expect(src[3]).toContain('L2.0');
    const ctx = makeCtx(
      'FC',
      emptyIface({ temp: [m('W', el('Word'))], returnType: { kind: 'void' } }),
    );
    expect(checkBlockCode(src, ctx, 'international')).toEqual([]);
  });
});
