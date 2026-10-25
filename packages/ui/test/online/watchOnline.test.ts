import { afterEach, describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { AppState } from '../../src/state/store';
import type { Timers } from '../../src/online/diagController';
import { WatchOnlineController } from '../../src/online/watchOnline';
import type { PlcReadWatchResult, PlcWatchTarget } from '../../src/online/plcTypes';
import { FakeBridge } from '../fakeBridge';

class ManualTimers implements Timers {
  pending: { id: number; fn: () => void; ms: number }[] = [];
  private n = 0;
  set(fn: () => void, ms: number) {
    const id = ++this.n;
    this.pending.push({ id, fn, ms });
    return id;
  }
  clear(h: unknown) {
    this.pending = this.pending.filter((p) => p.id !== h);
  }
  now() {
    return 0;
  }
  fire() {
    this.pending.shift()?.fn();
  }
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const M = (byte: number): PlcWatchTarget => ({ area: 'M', size: 'B', byte });

function setup() {
  const store = createStore<AppState>(
    () => ({ online: { status: 'on', deviceId: 'id1' } }) as unknown as AppState,
  );
  const bridge = new FakeBridge();
  const timers = new ManualTimers();
  const ctrl = new WatchOnlineController(store, bridge, timers);
  ctrl.setPlan(['a', 'b'], [M(0), M(1)]);
  return { store, bridge, timers, ctrl };
}

const setHidden = (h: boolean) =>
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
afterEach(() => setHidden(false));

describe('WatchOnlineController: osservazione', () => {
  it('ogni 500 ms dalla fine della richiesta, mai sovrapposte; fermata: nessuna richiesta', async () => {
    const { bridge, timers, ctrl } = setup();
    let release: () => void = () => undefined;
    bridge.plcReadWatchImpl = () =>
      new Promise<PlcReadWatchResult>((res) => {
        release = () =>
          res({ ok: true, values: [{ bytes: Uint8Array.of(1) }, { bytes: Uint8Array.of(2) }] });
      });
    ctrl.start();
    await flush();
    expect(bridge.plcReadWatchCalls).toHaveLength(1);
    expect(bridge.plcReadWatchCalls[0]).toEqual([M(0), M(1)]);
    expect(timers.pending).toEqual([]); // nessun timer finché la richiesta è in corso
    release();
    await flush();
    expect(timers.pending.map((p) => p.ms)).toEqual([500]);
    expect(ctrl.getState().values).toEqual({
      a: { bytes: Uint8Array.of(1) },
      b: { bytes: Uint8Array.of(2) },
    });
    bridge.plcReadWatchImpl = () => ({
      ok: true,
      values: [{ bytes: Uint8Array.of(3) }, { bytes: Uint8Array.of(4) }],
    });
    timers.fire();
    await flush();
    expect(bridge.plcReadWatchCalls).toHaveLength(2);
    ctrl.stop();
    expect(timers.pending).toEqual([]);
    expect(ctrl.getState()).toEqual({ running: false, values: null });
    await flush();
    expect(bridge.plcReadWatchCalls).toHaveLength(2);
  });

  it('collegamento perso: osservazione ferma, valori svuotati, nessuna ripartenza', async () => {
    const { store, bridge, timers, ctrl } = setup();
    ctrl.start();
    await flush();
    expect(ctrl.getState().values).not.toBeNull();
    store.setState({ online: { status: 'off' } } as never);
    expect(ctrl.getState()).toEqual({ running: false, values: null });
    expect(timers.pending).toEqual([]);
    await flush();
    expect(bridge.plcReadWatchCalls).toHaveLength(1);
  });

  it('collegamento perso durante il giro: la risposta si scarta e si ferma', async () => {
    const { store, bridge, timers, ctrl } = setup();
    bridge.plcReadWatchImpl = async () => {
      store.setState({ online: { status: 'off' } } as never);
      return { ok: false, error: 'Nessun collegamento online' };
    };
    ctrl.start();
    await flush();
    expect(ctrl.getState()).toEqual({ running: false, values: null });
    expect(timers.pending).toEqual([]);
  });

  it('un giro fallito intero dà l’errore a tutte le righe e l’osservazione continua', async () => {
    const { bridge, timers, ctrl } = setup();
    bridge.plcReadWatchImpl = () => ({ ok: false, error: 'Lettura troppo lunga' });
    ctrl.start();
    await flush();
    expect(ctrl.getState().running).toBe(true);
    expect(ctrl.getState().values).toEqual({
      a: { error: 'Lettura troppo lunga' },
      b: { error: 'Lettura troppo lunga' },
    });
    expect(timers.pending.map((p) => p.ms)).toEqual([500]);
  });

  it('finestra nascosta: in pausa; di nuovo visibile riparte', async () => {
    const { bridge, timers, ctrl } = setup();
    ctrl.start();
    await flush();
    setHidden(true);
    timers.fire();
    await flush();
    expect(bridge.plcReadWatchCalls).toHaveLength(1);
    expect(timers.pending).toEqual([]);
    setHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(bridge.plcReadWatchCalls).toHaveLength(2);
    ctrl.stop();
  });

  it('una riga con operando cambiato perde il valore; senza righe nessuna richiesta', async () => {
    const { bridge, timers, ctrl } = setup();
    ctrl.start();
    await flush();
    ctrl.setPlan(['a', 'b'], [M(0), M(5)]);
    expect(Object.keys(ctrl.getState().values!)).toEqual(['a']);
    ctrl.setPlan([], []);
    expect(ctrl.getState().values).toBeNull();
    timers.fire();
    await flush();
    expect(bridge.plcReadWatchCalls).toHaveLength(1);
    ctrl.stop();
  });

  it('riavvio durante una lettura in corso: finita quella, ne parte una nuova', async () => {
    const { bridge, ctrl } = setup();
    let release: () => void = () => undefined;
    bridge.plcReadWatchImpl = () =>
      new Promise<PlcReadWatchResult>((res) => {
        release = () => res({ ok: true, values: [] });
      });
    ctrl.start();
    await flush();
    ctrl.stop();
    ctrl.start();
    await flush();
    expect(bridge.plcReadWatchCalls).toHaveLength(1); // nessuna sovrapposizione
    bridge.plcReadWatchImpl = () => ({
      ok: true,
      values: [{ bytes: Uint8Array.of(1) }, { bytes: Uint8Array.of(2) }],
    });
    release();
    await flush();
    expect(bridge.plcReadWatchCalls).toHaveLength(2);
    expect(ctrl.getState().running).toBe(true);
    expect(ctrl.getState().values).not.toBeNull();
    ctrl.stop();
  });

  it('start senza collegamento non parte', async () => {
    const { store, bridge, ctrl } = setup();
    store.setState({ online: { status: 'off' } } as never);
    ctrl.start();
    await flush();
    expect(ctrl.getState().running).toBe(false);
    expect(bridge.plcReadWatchCalls).toHaveLength(0);
  });
});

describe('WatchOnlineController: comando', () => {
  const writes = [
    { rowId: 'a', target: M(0), data: Uint8Array.of(1) },
    { rowId: 'b', target: M(1), data: Uint8Array.of(2) },
  ];

  it('annullato: nessun messaggio e nessuna ripetizione', async () => {
    const { bridge, ctrl } = setup();
    bridge.plcWriteVarsResults.push({ ok: false, cancelled: true });
    expect(await ctrl.command(writes)).toEqual({ kind: 'cancelled' });
    expect(bridge.plcWriteVarsCalls).toHaveLength(1);
  });

  it('esito parziale: errore sulla sola riga fallita', async () => {
    const { bridge, ctrl } = setup();
    bridge.plcWriteVarsResults.push({
      ok: true,
      results: [{ ok: true }, { ok: false, error: 'oggetto non disponibile' }],
    });
    expect(await ctrl.command(writes)).toEqual({
      kind: 'done',
      written: 1,
      errors: { b: { key: 'HOST', params: { message: 'oggetto non disponibile' } } },
    });
    expect(bridge.plcWriteVarsCalls[0]).toEqual([
      { target: M(0), data: Uint8Array.of(1) },
      { target: M(1), data: Uint8Array.of(2) },
    ]);
  });

  it('errore del giro e doppio comando', async () => {
    const { bridge, ctrl } = setup();
    bridge.plcWriteVarsResults.push({ ok: false, error: 'Operazione già in corso' });
    expect(await ctrl.command(writes)).toEqual({
      kind: 'error',
      message: 'Operazione già in corso',
    });
    let release: () => void = () => undefined;
    const slow = bridge.plcWriteVars.bind(bridge);
    bridge.plcWriteVars = (items) => new Promise((res) => (release = () => res(slow(items))));
    const first = ctrl.command(writes);
    expect(await ctrl.command(writes)).toMatchObject({ kind: 'error' });
    release();
    expect(await first).toMatchObject({ kind: 'done' });
  });
});
