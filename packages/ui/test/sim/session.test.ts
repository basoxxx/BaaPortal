import { describe, expect, it, vi } from 'vitest';
import { SimHost } from '../../src/sim/host';
import { SimSession, type SimWorkerLike } from '../../src/sim/session';
import type { SimNotice, SimWireMessage, SimWireRequest } from '../../src/sim/protocol';
import { PROPS, ob1 } from './simFixtures';

/** Worker finto: fa girare `SimHost` in memoria con l'orologio e i timer veri. */
function fakeWorker() {
  const w: SimWorkerLike & { terminated: boolean; sent: SimWireRequest[] } = {
    terminated: false,
    sent: [],
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage(m: SimWireRequest) {
      w.sent.push(m);
      void host.handle(m.req).then(
        (value) => reply({ type: 'response', id: m.id, ok: true, value }),
        (e: unknown) =>
          reply({
            type: 'response',
            id: m.id,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          }),
      );
    },
    terminate() {
      w.terminated = true;
    },
  };
  const reply = (data: SimWireMessage) => {
    if (!w.terminated) queueMicrotask(() => w.onmessage?.({ data }));
  };
  const host = new SimHost({
    post: (notice: SimNotice) => reply({ type: 'notice', notice }),
    now: () => performance.now(),
    schedule: (fn, ms) => {
      const h = setTimeout(fn, ms);
      return () => clearTimeout(h);
    },
  });
  return w;
}

describe('SimSession', () => {
  it('richieste e risposte numerate, notifiche, errori', async () => {
    const w = fakeWorker();
    const s = await SimSession.start({
      cpuTypeId: 'cpu-315-2-pn-dp',
      props: PROPS,
      createWorker: () => w,
    });
    const notices: SimNotice[] = [];
    const off = s.onNotice((n) => notices.push(n));
    await s.request({ op: 'download', files: [ob1(['\tNOP 0;'])] });
    await s.request({ op: 'mode', to: 'RUN' });
    await vi.waitFor(() =>
      expect(notices.some((n) => n.kind === 'status' && n.mode === 'RUN')).toBe(true),
    );
    const ids = w.sent.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    await expect(s.request({ op: 'download', files: [Uint8Array.of(1)] })).rejects.toThrow(
      /file 1/,
    );
    off();
    s.dispose();
  });

  it('dispose termina il worker e rifiuta le richieste pendenti e future', async () => {
    const w = fakeWorker();
    const s = await SimSession.start({
      cpuTypeId: 'cpu-315-2-pn-dp',
      props: PROPS,
      createWorker: () => w,
    });
    const pending = s.request({ op: 'mres' });
    s.dispose();
    expect(w.terminated).toBe(true);
    await expect(pending).rejects.toThrow();
    await expect(s.request({ op: 'mres' })).rejects.toThrow();
    s.dispose(); // idempotente
  });

  it('un errore del worker fa fallire le richieste pendenti', async () => {
    const w = fakeWorker();
    const s = await SimSession.start({
      cpuTypeId: 'cpu-315-2-pn-dp',
      props: PROPS,
      createWorker: () => w,
    });
    w.postMessage = () => undefined; // il worker non risponde più
    const p = s.request({ op: 'mres' });
    w.onerror?.({ message: 'boom' });
    await expect(p).rejects.toThrow(/boom/);
    s.dispose();
  });

  it('onerror: la sessione è fallita, le richieste successive sono rifiutate, il worker terminato', async () => {
    const w = fakeWorker();
    const s = await SimSession.start({
      cpuTypeId: 'cpu-315-2-pn-dp',
      props: PROPS,
      createWorker: () => w,
    });
    w.onerror?.({ message: 'boom' });
    expect(w.terminated).toBe(true);
    await expect(s.request({ op: 'mres' })).rejects.toThrow();
  });

  it('messageerror: richieste pendenti e future rifiutate', async () => {
    const w = fakeWorker();
    const s = await SimSession.start({
      cpuTypeId: 'cpu-315-2-pn-dp',
      props: PROPS,
      createWorker: () => w,
    });
    w.postMessage = () => undefined;
    const p = s.request({ op: 'mres' });
    w.onmessageerror?.({});
    await expect(p).rejects.toThrow(/illeggibile/);
    expect(w.terminated).toBe(true);
    await expect(s.request({ op: 'mres' })).rejects.toThrow();
  });

  it("notifica di errore fatale dell'ospite: sessione fallita", async () => {
    const w = fakeWorker();
    const s = await SimSession.start({
      cpuTypeId: 'cpu-315-2-pn-dp',
      props: PROPS,
      createWorker: () => w,
    });
    w.postMessage = () => undefined;
    const p = s.request({ op: 'mres' });
    w.onmessage?.({ data: { type: 'notice', notice: { kind: 'error', message: 'guasto' } } });
    await expect(p).rejects.toThrow(/guasto/);
    expect(w.terminated).toBe(true);
  });
});
