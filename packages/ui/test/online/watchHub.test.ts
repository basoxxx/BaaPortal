import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { AppState } from '../../src/state/store';
import type { Timers } from '../../src/online/diagController';
import type { PlcWatchTarget } from '../../src/online/plcTypes';
import { WatchOnlineHub } from '../../src/online/watchHub';
import { initI18n } from '../../src/i18n';
import { FakeBridge } from '../fakeBridge';

const timers: Timers = {
  set: (fn) => setTimeout(fn, 1),
  clear: (h) => clearTimeout(h as never),
  now: () => 0,
};
const flush = () => new Promise<void>((r) => setTimeout(r, 30));
const M = (byte: number): PlcWatchTarget => ({ area: 'M', size: 'B', byte });

async function setup() {
  await initI18n('it');
  const messages: unknown[] = [];
  const store = createStore<AppState>(
    () =>
      ({
        online: { status: 'on', deviceId: 'id1' },
        pushMessage: (m: unknown) => messages.push(m),
      }) as unknown as AppState,
  );
  const bridge = new FakeBridge();
  // Il valore letto è il numero del byte, così si vede quale operando è andato a chi.
  bridge.plcReadWatchImpl = (items) => ({
    ok: true,
    values: items.map((i) => ({ bytes: Uint8Array.of((i as { byte: number }).byte) })),
  });
  return { hub: new WatchOnlineHub(store, bridge, timers), bridge, store, messages };
}

describe('WatchOnlineHub: un solo giro per tutte le tabelle', () => {
  it('unisce le richieste, legge una volta gli operandi uguali e dà a ogni tabella i suoi valori', async () => {
    const { hub, bridge } = await setup();
    const a = hub.client();
    const b = hub.client();
    a.setPlan(['a1', 'a2'], [M(1), M(2)]);
    b.setPlan(['b1', 'b2'], [M(2), M(3)]);
    a.start();
    b.start();
    await flush();
    expect(bridge.plcReadWatchCalls.at(-1)).toEqual([M(1), M(2), M(3)]);
    expect(a.getState().values).toEqual({
      a1: { bytes: Uint8Array.of(1) },
      a2: { bytes: Uint8Array.of(2) },
    });
    expect(b.getState().values).toEqual({
      b1: { bytes: Uint8Array.of(2) },
      b2: { bytes: Uint8Array.of(3) },
    });
  });

  it('fermata una tabella la richiesta si riduce; fermate tutte non si legge più', async () => {
    const { hub, bridge } = await setup();
    const a = hub.client();
    const b = hub.client();
    a.setPlan(['a1'], [M(1)]);
    b.setPlan(['b1'], [M(2)]);
    a.start();
    b.start();
    await flush();
    a.stop();
    expect(a.getState()).toEqual({ running: false, values: null });
    expect(b.getState().running).toBe(true);
    const n = bridge.plcReadWatchCalls.length;
    b.stop();
    await flush();
    expect(bridge.plcReadWatchCalls).toHaveLength(n);
  });

  it('il limite di 200 righe vale per l’insieme: le righe in più hanno un errore e c’è un avviso', async () => {
    const { hub, bridge, messages } = await setup();
    const a = hub.client();
    const b = hub.client();
    const ids = (p: string, n: number, from: number) =>
      Array.from({ length: n }, (_, i) => [`${p}${i}`, M(from + i)] as const);
    const ra = ids('a', 150, 0);
    const rb = ids('b', 100, 100); // 50 in comune con a, 50 nuovi: 200 in tutto
    const rc = ids('c', 10, 1000); // oltre il limite
    a.setPlan(
      ra.map((r) => r[0]),
      ra.map((r) => r[1]),
    );
    b.setPlan(
      [...rb, ...rc].map((r) => r[0]),
      [...rb, ...rc].map((r) => r[1]),
    );
    a.start();
    b.start();
    await flush();
    expect(bridge.plcReadWatchCalls.at(-1)).toHaveLength(200);
    const vb = b.getState().values!;
    expect(vb['b0']).toEqual({ bytes: Uint8Array.of(100) });
    expect(vb['c0']).toMatchObject({ error: expect.stringContaining('200') });
    expect(Object.keys(vb).filter((k) => 'error' in vb[k]!)).toHaveLength(10);
    expect(messages).toHaveLength(1);
  });

  it('collegamento perso: tutte le tabelle si fermano', async () => {
    const { hub, store } = await setup();
    const a = hub.client();
    a.setPlan(['a1'], [M(1)]);
    a.start();
    await flush();
    store.setState({ online: { status: 'off' } } as never);
    expect(a.getState()).toEqual({ running: false, values: null });
  });
});
