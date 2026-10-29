import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { LineMapRow } from '../../src/editors/awl/monitorExtension';
import type { Timers } from '../../src/online/diagController';
import { PlcMonitorController, windowFor, type PlcMonitorInput } from '../../src/online/plcMonitor';
import type { AppState } from '../../src/state/store';
import { FakeBridge } from '../fakeBridge';

class ManualTimers implements Timers {
  pending: { id: number; fn: () => void; ms: number }[] = [];
  t = 1000;
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
    return this.t;
  }
  fire() {
    this.pending.shift()?.fn();
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

/** 3 reti da 4 istruzioni ciascuna, a offset pari (2 byte l'una). */
const MAP: LineMapRow[] = Array.from({ length: 12 }, (_, i) => ({
  offset: i * 2,
  length: 2,
  network: Math.floor(i / 4),
  line: i % 4,
}));

describe('windowFor', () => {
  const big: LineMapRow[] = Array.from({ length: 40 }, (_, i) => ({
    offset: i * 2,
    length: 2,
    network: Math.floor(i / 14),
    line: i,
  }));
  it('3 reti visibili con 40 istruzioni, maxLines 24 → prime 24, saz = offset della 25ª', () => {
    const w = windowFor(big, [0, 1, 2], 24);
    expect(w.offsets).toHaveLength(24);
    expect(w.offsets[0]).toBe(0);
    expect(w.saz).toBe(48);
  });
  it('ultima istruzione del blocco → saz = lunghezza MC7', () => {
    const w = windowFor(big, [2], 100, 82);
    expect(w.offsets.at(-1)).toBe(78);
    expect(w.saz).toBe(82);
  });
  it('solo le reti visibili; nessuna rete → vuoto', () => {
    expect(windowFor(MAP, [1], 24).offsets).toEqual([8, 10, 12, 14]);
    expect(windowFor(MAP, [1], 24).saz).toBe(16);
    expect(windowFor(MAP, [], 24).offsets).toEqual([]);
  });
});

function setup(over: Partial<PlcMonitorInput> = {}) {
  const store = createStore<AppState>(
    (set) =>
      ({
        online: { status: 'on', deviceId: 'd1' },
        patchOnline: (p: Partial<AppState['online']>) =>
          set((s) => ({ online: { ...s.online, ...p } })),
      }) as unknown as AppState,
  );
  const bridge = new FakeBridge();
  const timers = new ManualTimers();
  let input: PlcMonitorInput | undefined = {
    reason: 'ok',
    type: 'OB',
    number: 1,
    signature: { checksum: 0x1234, mc7Length: 26 },
    lineMap: MAP,
    key: 'k1',
    ...over,
  };
  const ctrl = new PlcMonitorController(store, bridge, timers, () => input);
  const online = () => store.getState().online;
  return {
    store,
    bridge,
    timers,
    ctrl,
    online,
    setInput: (i: PlcMonitorInput | undefined) => {
      input = i;
      // un cambio di stato qualunque fa girare la sincronizzazione
      store.setState((s) => ({ ...s }));
    },
  };
}

describe('PlcMonitorController', () => {
  it('on → start con la firma del compilato e gli offset delle reti visibili, poi read ogni 250 ms dalla fine della precedente', async () => {
    const { bridge, timers, ctrl, online } = setup();
    ctrl.toggle('d1', 'b1');
    ctrl.setVisible('b1', [0, 1]);
    await flush();
    expect(bridge.plcStatusStartCalls).toHaveLength(1);
    const req = bridge.plcStatusStartCalls[0]!;
    expect(req.expect).toEqual({ checksum: 0x1234, mc7Length: 26 });
    expect(req.offsets).toEqual([0, 2, 4, 6, 8, 10, 12, 14]);
    expect(req.saz).toBe(16);
    expect(req.mask).toBe(0x03);
    expect(bridge.plcStatusReadCalls).toBe(1);
    expect(timers.pending.map((p) => p.ms)).toContain(250);
    expect(online().monitor?.reason).toBe('waiting');
    timers.pending = timers.pending.filter((p) => p.ms === 250);
    timers.fire();
    await flush();
    expect(bridge.plcStatusReadCalls).toBe(2);
  });

  it('read lenta (1 s) → nessuna sovrapposizione', async () => {
    const { bridge, timers, ctrl } = setup();
    let release: (v: { ok: true; state: 'stop' }) => void = () => undefined;
    bridge.plcStatusReadImpl = () =>
      new Promise((r) => {
        release = r as typeof release;
      });
    ctrl.toggle('d1', 'b1');
    ctrl.setVisible('b1', [0, 1, 2]);
    await flush();
    expect(bridge.plcStatusReadCalls).toBe(1);
    expect(timers.pending.filter((p) => p.ms === 250)).toHaveLength(0);
    release({ ok: true, state: 'stop' });
    await flush();
    expect(timers.pending.filter((p) => p.ms === 250)).toHaveLength(1);
    expect(bridge.plcStatusReadCalls).toBe(1);
  });

  it('casella ACCU2 → maschera 0x07 e nuova finestra', async () => {
    const { bridge, ctrl, online } = setup();
    ctrl.toggle('d1', 'b1');
    ctrl.setVisible('b1', [0, 1, 2]);
    await flush();
    ctrl.setRegs({ accu2: true, ar1: false });
    await flush();
    expect(bridge.plcStatusWindowCalls.at(-1)?.mask).toBe(0x07);
    ctrl.setRegs({ accu2: true, ar1: true });
    expect(online().monitorRegs).toEqual({ accu2: true, ar1: true });
  });

  it('scorrimento → una sola plcStatusWindow in 250 ms', async () => {
    const { bridge, timers, ctrl } = setup();
    ctrl.toggle('d1', 'b1');
    ctrl.setVisible('b1', [0]);
    await flush();
    const before = bridge.plcStatusWindowCalls.length;
    ctrl.setVisible('b1', [0, 1]);
    ctrl.setVisible('b1', [1]);
    ctrl.setVisible('b1', [1, 2]);
    await flush();
    expect(bridge.plcStatusWindowCalls.length - before).toBeLessThanOrEqual(1);
    expect(timers.pending.length).toBeGreaterThan(0);
    timers.t += 250;
    for (const p of [...timers.pending]) p.fn();
    await flush();
    const last = bridge.plcStatusWindowCalls.at(-1)!;
    expect(last.offsets[0]).toBe(8);
    expect(last.offsets.at(-1)).toBe(22);
  });

  it('different → barra con il messaggio, nessuna read', async () => {
    const { bridge, ctrl, online } = setup();
    bridge.plcStatusStartImpl = () => ({ ok: false, reason: 'different', error: 'diverso' });
    ctrl.toggle('d1', 'b1');
    ctrl.setVisible('b1', [0, 1, 2]);
    await flush();
    expect(online().monitor).toMatchObject({ reason: 'different', message: 'diverso' });
    expect(bridge.plcStatusReadCalls).toBe(0);
  });

  it('nessuna rete visibile → «noVisible», nessun job; quando una rete torna visibile parte', async () => {
    const { bridge, ctrl, online } = setup();
    ctrl.toggle('d1', 'b1');
    ctrl.setVisible('b1', []);
    await flush();
    expect(online().monitor?.reason).toBe('noVisible');
    expect(bridge.plcStatusStartCalls).toHaveLength(0);
    ctrl.setVisible('b1', [0]);
    await flush();
    expect(bridge.plcStatusStartCalls).toHaveLength(1);
    expect(online().monitor?.reason).toBe('waiting');
  });

  it('osservazione in corso e reti che escono dalla vista → job fermato e «noVisible»', async () => {
    const { bridge, ctrl, online } = setup();
    ctrl.toggle('d1', 'b1');
    ctrl.setVisible('b1', [0]);
    await flush();
    expect(online().monitor?.reason).toBe('waiting');
    const stops = bridge.plcStatusStopCalls;
    ctrl.setVisible('b1', []);
    await flush();
    expect(online().monitor?.reason).toBe('noVisible');
    expect(bridge.plcStatusStopCalls).toBe(stops + 1);
  });

  it('stale e edited → nessuna start', async () => {
    const stale = setup({ reason: 'stale' });
    stale.ctrl.toggle('d1', 'b1');
    stale.ctrl.setVisible('b1', [0, 1, 2]);
    await flush();
    expect(stale.bridge.plcStatusStartCalls).toHaveLength(0);
    expect(stale.online().monitor?.reason).toBe('stale');
    const ed = setup();
    ed.ctrl.toggle('d1', 'b1');
    ed.ctrl.setEdited('b1', true);
    ed.ctrl.setVisible('b1', [0, 1, 2]);
    await flush();
    expect(ed.online().monitor?.reason).toBe('edited');
    expect(ed.bridge.plcStatusStartCalls).toHaveLength(0);
  });

  it('state stop → nessuna cella; waiting → righe della finestra senza registri', async () => {
    const { bridge, timers, ctrl, online } = setup();
    bridge.plcStatusReadImpl = () => ({ ok: true, state: 'stop' });
    ctrl.toggle('d1', 'b1');
    ctrl.setVisible('b1', [0, 1, 2]);
    await flush();
    expect(online().monitor?.reason).toBe('stop');
    expect(online().monitorLines).toBeNull();
    bridge.plcStatusReadImpl = () => ({ ok: true, state: 'waiting' });
    timers.fire();
    await flush();
    expect(online().monitor?.reason).toBe('waiting');
    expect(online().monitorLines?.every((l) => l.regs === null)).toBe(true);
    expect(online().monitorLines).toHaveLength(12);
    expect(online().monitorLinesUnsure).toBe(true);
  });

  it('values → righe e motivo ok', async () => {
    const { bridge, ctrl, online } = setup();
    bridge.plcStatusReadImpl = () => ({
      ok: true,
      state: 'values',
      lines: [{ offset: 0, regs: { stw: 0x106, accu1: 5 } }],
    });
    ctrl.toggle('d1', 'b1');
    ctrl.setVisible('b1', [0, 1, 2]);
    await flush();
    expect(online().monitor?.reason).toBe('ok');
    expect(online().monitorLines).toEqual([{ offset: 0, regs: { stw: 0x106, accu1: 5 } }]);
    expect(online().monitorLinesUnsure).toBe(false);
  });

  it('editor chiuso, cambio di blocco, offline → plcStatusStop', async () => {
    const closed = setup();
    closed.ctrl.toggle('d1', 'b1');
    closed.ctrl.setVisible('b1', [0, 1, 2]);
    await flush();
    closed.setInput(undefined);
    expect(closed.bridge.plcStatusStopCalls).toBe(1);
    expect(closed.online().monitor).toBeNull();

    const off = setup();
    off.ctrl.toggle('d1', 'b1');
    off.ctrl.setVisible('b1', [0, 1, 2]);
    await flush();
    off.store.setState({ online: { status: 'off' } } as Partial<AppState>);
    expect(off.bridge.plcStatusStopCalls).toBe(1);

    const manual = setup();
    manual.ctrl.toggle('d1', 'b1');
    manual.ctrl.setVisible('b1', [0, 1, 2]);
    await flush();
    manual.ctrl.toggle('d1', 'b1'); // spegne
    expect(manual.bridge.plcStatusStopCalls).toBe(1);
    expect(manual.online().monitor).toBeNull();
    const reads = manual.bridge.plcStatusReadCalls;
    manual.timers.fire();
    await flush();
    expect(manual.bridge.plcStatusReadCalls).toBe(reads);
  });

  it('ended → osservazione spenta con il messaggio, nessuna altra read', async () => {
    const { bridge, ctrl, online } = setup();
    bridge.plcStatusReadImpl = () => ({ ok: false, ended: true, error: 'finita male' });
    ctrl.toggle('d1', 'b1');
    ctrl.setVisible('b1', [0, 1, 2]);
    await flush();
    expect(online().monitor).toMatchObject({ reason: 'ended', message: 'finita male' });
    expect(bridge.plcStatusStopCalls).toBe(1);
    expect(bridge.plcStatusReadCalls).toBe(1);
  });

  it('righe visibili oltre il limite della CPU → finestra ridotta e limit nello stato', async () => {
    const big: LineMapRow[] = Array.from({ length: 40 }, (_, i) => ({
      offset: i * 2,
      length: 2,
      network: 0,
      line: i,
    }));
    const { bridge, ctrl, online } = setup({
      lineMap: big,
      signature: { checksum: 1, mc7Length: 82 },
    });
    bridge.plcStatusReadImpl = () => ({ ok: true, state: 'values', lines: [] });
    ctrl.toggle('d1', 'b1');
    ctrl.setVisible('b1', [0]);
    await flush();
    // la prima start è già tagliata alla PDU di 240: nessuna seconda finestra da ricreare
    expect(bridge.plcStatusStartCalls[0]!.offsets).toHaveLength(24);
    expect(bridge.plcStatusStartCalls[0]!.saz).toBe(48);
    expect(bridge.plcStatusWindowCalls).toHaveLength(0);
    expect(online().monitor?.limit).toBe(24);
  });

  it('values con partial → stato ok con partial', async () => {
    const { bridge, ctrl, online } = setup();
    bridge.plcStatusReadImpl = () => ({
      ok: true,
      state: 'values',
      lines: [{ offset: 0, regs: { accu1: 1 } }],
      partial: true,
    });
    ctrl.toggle('d1', 'b1');
    ctrl.setVisible('b1', [0, 1, 2]);
    await flush();
    expect(online().monitor).toMatchObject({ reason: 'ok', partial: true });
  });

  it('cambio di finestra → i valori mostrati si azzerano subito', async () => {
    const { bridge, timers, ctrl, online } = setup();
    bridge.plcStatusReadImpl = () => ({
      ok: true,
      state: 'values',
      lines: [{ offset: 0, regs: { stw: 0x106, accu1: 5 } }],
    });
    ctrl.toggle('d1', 'b1');
    ctrl.setVisible('b1', [0]);
    await flush();
    expect(online().monitorLines?.[0]?.regs).not.toBeNull();
    timers.t += 1000;
    bridge.plcStatusReadImpl = () => new Promise(() => undefined);
    ctrl.setVisible('b1', [1]);
    await flush();
    expect(online().monitorLines?.every((l) => l.regs === null)).toBe(true);
    // segnaposto: le righe null non dicono «non elaborata»
    expect(online().monitorLinesUnsure).toBe(true);
  });

  it('different → si riprova quando cambia il confronto con la CPU', async () => {
    const { bridge, ctrl, online, store } = setup();
    bridge.plcStatusStartImpl = () => ({ ok: false, reason: 'different', error: 'diverso' });
    ctrl.toggle('d1', 'b1');
    ctrl.setVisible('b1', [0]);
    await flush();
    expect(online().monitor?.reason).toBe('different');
    expect(bridge.plcStatusStartCalls).toHaveLength(1);
    store.setState((s) => ({ ...s }));
    await flush();
    expect(bridge.plcStatusStartCalls).toHaveLength(1);
    store.getState().patchOnline({ compare: { rows: [] } as never });
    await flush();
    expect(bridge.plcStatusStartCalls).toHaveLength(2);
  });
});
