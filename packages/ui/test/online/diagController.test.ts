import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { AppState } from '../../src/state/store';
import { DiagController, type Timers } from '../../src/online/diagController';
import type { DiagPart, PlcDiagResult } from '../../src/online/plcTypes';
import { FakeBridge } from '../fakeBridge';

/** Temporizzatore a mano: i timer si eseguono solo quando il test lo chiede. */
class ManualTimers implements Timers {
  pending: { id: number; fn: () => void; ms: number }[] = [];
  private n = 0;
  clock = 0;
  set(fn: () => void, ms: number) {
    const id = ++this.n;
    this.pending.push({ id, fn, ms });
    return id;
  }
  clear(h: unknown) {
    this.pending = this.pending.filter((p) => p.id !== h);
  }
  now() {
    return this.clock;
  }
  fire() {
    const p = this.pending.shift();
    p?.fn();
  }
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function setup() {
  const store = createStore<AppState>(
    () => ({ online: { status: 'on', deviceId: 'id1' } }) as unknown as AppState,
  );
  const bridge = new FakeBridge();
  const timers = new ManualTimers();
  const ctrl = new DiagController(store, bridge, timers);
  return { store, bridge, timers, ctrl };
}

const ok = (data: PlcDiagResult & { ok: true }['data'] = {}): PlcDiagResult => ({ ok: true, data });

describe('DiagController', () => {
  it('con l editor aperto chiede ogni 1 s; chiuso, nessuna richiesta', async () => {
    const { bridge, timers, ctrl } = setup();
    ctrl.start();
    await flush();
    expect(bridge.plcDiagnosticsCalls).toHaveLength(1);
    expect(timers.pending.map((p) => p.ms)).toEqual([1000]);
    timers.fire();
    await flush();
    expect(bridge.plcDiagnosticsCalls).toHaveLength(2);
    ctrl.stop();
    expect(timers.pending).toEqual([]);
    await flush();
    expect(bridge.plcDiagnosticsCalls).toHaveLength(2);
  });

  it('richiesta lenta: nessuna sovrapposizione, la successiva parte 1 s dopo la fine', async () => {
    const { bridge, timers, ctrl } = setup();
    let release: () => void = () => undefined;
    bridge.plcDiagnosticsImpl = () =>
      new Promise((res) => {
        release = () => res(ok());
      });
    ctrl.start();
    await flush();
    ctrl.setPage('cycle'); // durante la richiesta: nessuna seconda richiesta
    ctrl.readNow();
    await flush();
    expect(timers.pending).toEqual([]);
    expect(bridge.plcDiagnosticsCalls).toHaveLength(1);
    release();
    await flush();
    // il cambio di pagina chiesto durante la lettura si serve subito, poi di nuovo uno alla volta
    expect(bridge.plcDiagnosticsCalls).toHaveLength(2);
    expect(timers.pending).toEqual([]);
    release();
    await flush();
    expect(timers.pending.map((p) => p.ms)).toEqual([1000]);
  });

  it('cambio pagina: cambiano le parti chieste; identity una volta sola', async () => {
    const { bridge, timers, ctrl } = setup();
    bridge.plcDiagnosticsImpl = (parts: DiagPart[]) =>
      ok(parts.includes('identity') ? { identity: { ok: true, value: { orderNumber: 'X' } } } : {});
    ctrl.start();
    await flush();
    ctrl.setPage('buffer');
    await flush();
    ctrl.setPage('general');
    await flush();
    const calls = bridge.plcDiagnosticsCalls;
    expect(calls[0]).toEqual([
      'mode',
      'leds',
      'identity',
      'protection',
      'lastModeChange',
      'memory',
      'force',
    ]);
    expect(calls[1]).toEqual(['mode', 'leds', 'buffer']);
    expect(calls[2]).toEqual(['mode', 'leds', 'protection', 'lastModeChange', 'memory', 'force']);
    expect(timers.pending).toHaveLength(1);
  });

  it('collegamento perso: ferma, riporta l errore e non riparte da sola', async () => {
    const { store, bridge, timers, ctrl } = setup();
    bridge.plcDiagnosticsImpl = () => ({ ok: false, error: 'Collegamento perso' });
    ctrl.start();
    await flush();
    expect(ctrl.getState().running).toBe(false);
    expect(ctrl.getState().error).toBe('Collegamento perso');
    expect(timers.pending).toEqual([]);
    expect(bridge.plcDiagnosticsCalls).toHaveLength(1);
    // di nuovo online: riparte solo quando l editor (la vista) la riavvia
    bridge.plcDiagnosticsImpl = () => ok();
    store.setState({ online: { status: 'on', deviceId: 'id1' } });
    await flush();
    expect(bridge.plcDiagnosticsCalls).toHaveLength(1);
    ctrl.start();
    await flush();
    expect(bridge.plcDiagnosticsCalls).toHaveLength(2);
    expect(ctrl.getState().error).toBeUndefined();
  });

  it('andare offline ferma l interrogazione', async () => {
    const { store, bridge, timers, ctrl } = setup();
    ctrl.start();
    await flush();
    store.setState({ online: { status: 'off' } });
    expect(ctrl.getState().running).toBe(false);
    expect(timers.pending).toEqual([]);
    expect(bridge.plcDiagnosticsCalls).toHaveLength(1);
  });

  it('Blocca visualizzazione: il buffer non si chiede e non cambia', async () => {
    const { bridge, timers, ctrl } = setup();
    let n = 0;
    bridge.plcDiagnosticsImpl = (parts) =>
      ok({
        ...(parts.includes('buffer')
          ? { buffer: { ok: true, value: [{ eventId: ++n } as never] } }
          : {}),
        mode: { ok: true, value: n > 1 ? 'STOP' : 'RUN' },
      });
    ctrl.setPage('buffer');
    ctrl.start();
    await flush();
    ctrl.setFrozen(true);
    timers.fire();
    await flush();
    expect(bridge.plcDiagnosticsCalls[1]).toEqual(['mode', 'leds']);
    expect(ctrl.getState().data.buffer).toEqual({ ok: true, value: [{ eventId: 1 }] });
  });

  it('riavvio con una richiesta di prima ancora in corso: nessuna sovrapposizione', async () => {
    const { bridge, ctrl } = setup();
    const releases: (() => void)[] = [];
    let active = 0;
    let maxActive = 0;
    bridge.plcDiagnosticsImpl = () =>
      new Promise((res) => {
        active++;
        maxActive = Math.max(maxActive, active);
        releases.push(() => {
          active--;
          res(ok());
        });
      });
    ctrl.start();
    await flush();
    ctrl.stop();
    ctrl.start(); // la richiesta di prima è ancora in corso
    await flush();
    expect(bridge.plcDiagnosticsCalls).toHaveLength(1);
    releases[0]!(); // risposta della sessione chiusa: scartata, poi parte la nuova
    await flush();
    expect(bridge.plcDiagnosticsCalls).toHaveLength(2);
    releases[1]!();
    await flush();
    expect(maxActive).toBe(1);
    expect(ctrl.getState().running).toBe(true);
  });

  it('finestra nascosta: in pausa; alla visibilitychange riprende', async () => {
    const { bridge, timers, ctrl } = setup();
    const setHidden = (h: boolean) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    try {
      ctrl.start();
      await flush();
      expect(bridge.plcDiagnosticsCalls).toHaveLength(1);
      setHidden(true);
      timers.fire(); // il timer già armato scatta ma non chiede nulla
      await flush();
      expect(bridge.plcDiagnosticsCalls).toHaveLength(1);
      expect(timers.pending).toEqual([]);
      setHidden(false);
      await flush();
      expect(bridge.plcDiagnosticsCalls).toHaveLength(2);
      expect(timers.pending).toHaveLength(1);
    } finally {
      setHidden(false);
    }
  });
});
