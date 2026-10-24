import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeWriteRequest, S7Error } from '@baaportal/s7comm';
import { openTcp } from '@baaportal/s7comm/node';
import { listen, type ListeningCpu } from '@baaportal/s7-server/node';
import { SimCpu, simBackend } from '@baaportal/sim';
import type { PlcAccess, PlcEvent } from '@baaportal/ui';
import { PlcService, type PlcConnectFn, type PlcOwner } from '../../src/main/plc/plcService';
import { startTestPlc } from '../../src/main/plc/testPlc';
import { parsePlcAccess } from '../../src/main/plc/plcIpc';

class FakeOwner implements PlcOwner {
  events: PlcEvent[] = [];
  sentAfterDestroy = 0;
  private destroyed = false;
  private listeners = new Set<() => void>();
  isDestroyed(): boolean {
    return this.destroyed;
  }
  send(_channel: string, e: PlcEvent): void {
    if (this.destroyed) this.sentAfterDestroy++;
    this.events.push(e);
  }
  once(_event: 'destroyed', cb: () => void): void {
    this.listeners.add(cb);
  }
  removeListener(_event: 'destroyed', cb: () => void): void {
    this.listeners.delete(cb);
  }
  destroy(): void {
    this.destroyed = true;
    for (const cb of [...this.listeners]) cb();
  }
}

const PROPS = {
  maxCycleMs: 150,
  minCycleMs: 0,
  clockMemory: { enabled: false, byte: 0 },
  retentivity: { mBytes: 16, timers: 0, counters: 8 },
  cyclicInterruptMs: 0,
};

const waitFor = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condizione non raggiunta');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('PlcService contro il PLC di prova (CPU simulata su 127.0.0.1)', () => {
  let cpu: SimCpu;
  let plc: ListeningCpu;
  let service: PlcService;
  const access = (): PlcAccess => ({
    host: '127.0.0.1',
    port: plc.port,
    rack: 0,
    slot: 2,
    connectionType: 'PG',
  });

  beforeEach(async () => {
    cpu = new SimCpu({ cpuTypeId: 'cpu-315-2-pn-dp', props: PROPS });
    cpu.run();
    plc = await listen(simBackend(cpu), { port: 0 });
    service = new PlcService({ intervalMs: 30, readTimeoutMs: 500 });
  });
  afterEach(async () => {
    await service.closeAll();
    await plc.close();
  });

  it('collega al PLC di prova, legge identità e stato RUN/STOP', async () => {
    const owner = new FakeOwner();
    const r = await service.connect(owner, access());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.identity.orderNumber).not.toBe('');
    expect(r.mode).toBe('RUN');
    expect(service.status(owner)).toEqual({ connected: true, access: access() });
    await service.disconnect(owner);
    expect(service.status(owner)).toEqual({ connected: false });
    cpu.stop('prova');
    const again = await service.connect(owner, access());
    expect(again.ok && again.mode).toBe('STOP');
  });

  it('un secondo connect chiude il primo', async () => {
    const clients: { closed: boolean }[] = [];
    const wrapped = new PlcService({
      intervalMs: 30,
      connect: (async (o) => {
        const { connectTcp } = await import('@baaportal/s7comm/node');
        const c = await connectTcp(o);
        clients.push(c);
        return c;
      }) as PlcConnectFn,
    });
    const owner = new FakeOwner();
    expect((await wrapped.connect(owner, access())).ok).toBe(true);
    expect((await wrapped.connect(owner, access())).ok).toBe(true);
    expect(clients).toHaveLength(2);
    expect(clients[0]!.closed).toBe(true);
    expect(clients[1]!.closed).toBe(false);
    await wrapped.closeAll();
  });

  it('la sorveglianza manda mode quando la CPU passa in STOP', async () => {
    const owner = new FakeOwner();
    await service.connect(owner, access());
    cpu.stop('prova');
    await waitFor(() => owner.events.length > 0);
    expect(owner.events).toEqual([{ kind: 'mode', mode: 'STOP' }]);
    await new Promise((r) => setTimeout(r, 100));
    expect(owner.events).toHaveLength(1); // nessun evento senza cambio
  });

  it('socket chiuso dal server → lost', async () => {
    const owner = new FakeOwner();
    await service.connect(owner, access());
    await plc.close();
    await waitFor(() => owner.events.length > 0);
    expect(owner.events).toEqual([{ kind: 'lost', reason: 'Collegamento interrotto' }]);
    expect(service.status(owner)).toEqual({ connected: false });
  });

  it('finestra distrutta → collegamento chiuso, nessun evento', async () => {
    const owner = new FakeOwner();
    await service.connect(owner, access());
    owner.destroy();
    expect(service.status(owner)).toEqual({ connected: false });
    await plc.close();
    await new Promise((r) => setTimeout(r, 150));
    expect(owner.events).toEqual([]);
    expect(owner.sentAfterDestroy).toBe(0);
  });

  it('rack/slot sbagliati → messaggio sul rifiuto del collegamento', async () => {
    const r = await service.connect(new FakeOwner(), { ...access(), rack: 3 });
    expect(r).toEqual({
      ok: false,
      error: 'La CPU ha rifiutato il collegamento (rack/slot o TSAP)',
    });
  });

  it('il collegamento è in sola lettura (il filtro rifiuta le scritture)', async () => {
    const seen: unknown[] = [];
    const spy = new PlcService({
      intervalMs: 30,
      connect: (async (o) => {
        seen.push(o.mode);
        const { connectTcp } = await import('@baaportal/s7comm/node');
        return connectTcp(o);
      }) as PlcConnectFn,
    });
    expect((await spy.connect(new FakeOwner(), access())).ok).toBe(true);
    expect(seen).toEqual(['read-only']);
    await spy.closeAll();
    // Stesso modo, prova diretta: il filtro rifiuta la scrittura prima dell'invio.
    const conn = await openTcp({ host: '127.0.0.1', port: plc.port, mode: 'read-only' });
    const { param, data } = encodeWriteRequest([
      { area: 'M', db: 0, start: 0, size: 'BYTE', count: 1, data: Uint8Array.of(0xff) },
    ]);
    await expect(conn.request(param, data, 1)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(conn.refusedCount).toBe(1);
    await conn.close();
  });
});

describe('PlcService, casi di rete', () => {
  const ACCESS: PlcAccess = { host: '192.0.2.10', rack: 0, slot: 2, connectionType: 'PG' };

  it.each(['CONNECT_TIMEOUT', 'CONNECT_REFUSED'] as const)(
    'host irraggiungibile (%s) → messaggio leggibile',
    async (code) => {
      const service = new PlcService({
        connect: (async () => {
          throw new S7Error(code, 'prova');
        }) as PlcConnectFn,
      });
      const r = await service.connect(new FakeOwner(), ACCESS);
      expect(r).toEqual({ ok: false, error: 'Nessuna risposta da 192.0.2.10:102' });
    },
  );

  describe('corse di connect', () => {
    const setup = async () => {
      let resolve!: (c: unknown) => void;
      const close = vi.fn(async () => undefined);
      const fake = {
        closed: false,
        close,
        identity: async () => ({ orderNumber: 'X' }),
        mode: async () => 'RUN' as const,
        protection: async () => ({}),
      };
      const service = new PlcService({
        connect: (() => new Promise((r) => (resolve = r))) as unknown as PlcConnectFn,
      });
      const owner = new FakeOwner();
      const pending = service.connect(owner, ACCESS);
      await new Promise((r) => setTimeout(r, 0)); // il connect è partito ed è in attesa
      return { service, owner, pending, close, finish: () => resolve(fake) };
    };
    const expectCancelled = async (t: Awaited<ReturnType<typeof setup>>) => {
      t.finish();
      expect(await t.pending).toEqual({ ok: false, error: 'Collegamento annullato' });
      expect(t.close).toHaveBeenCalled();
      expect(t.service.status(t.owner).connected).toBe(false);
    };

    it('disconnect durante il connect lo annulla', async () => {
      const t = await setup();
      await t.service.disconnect(t.owner);
      await expectCancelled(t);
    });
    it('finestra distrutta durante il connect lo annulla', async () => {
      const t = await setup();
      t.owner.destroy();
      await expectCancelled(t);
    });
    it('closeAll durante il connect lo annulla', async () => {
      const t = await setup();
      await t.service.closeAll();
      await expectCancelled(t);
    });
  });

  describe('CPU che non risponde', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('→ lost entro 5 s, senza chiudere il socket da sola', async () => {
      const close = vi.fn(async () => undefined);
      let calls = 0;
      const fake = {
        closed: false,
        close,
        identity: async () => ({ orderNumber: '6ES7 TEST' }),
        protection: async () => ({}),
        // Dopo il collegamento la CPU tace: la lettura non si risolve mai.
        mode: () =>
          calls++ === 0 ? Promise.resolve('RUN' as const) : new Promise<never>(() => {}),
      };
      const service = new PlcService({ connect: (async () => fake) as unknown as PlcConnectFn });
      const owner = new FakeOwner();
      const r = await service.connect(owner, {
        host: '127.0.0.1',
        rack: 0,
        slot: 2,
        connectionType: 'PG',
      });
      expect(r.ok).toBe(true);
      await vi.advanceTimersByTimeAsync(4900);
      expect(owner.events).toEqual([{ kind: 'lost', reason: 'Collegamento interrotto' }]);
      expect(close).toHaveBeenCalled();
      expect(service.status(owner)).toEqual({ connected: false });
      await vi.advanceTimersByTimeAsync(5000);
      expect(owner.events).toHaveLength(1);
    });

    it('una sola lettura alla volta: il giro successivo salta', async () => {
      let calls = 0;
      const fake = {
        closed: false,
        close: async () => undefined,
        identity: async () => ({ orderNumber: 'X' }),
        protection: async () => ({}),
        mode: () =>
          calls++ === 0 ? Promise.resolve('RUN' as const) : new Promise<never>(() => {}),
      };
      const service = new PlcService({ connect: (async () => fake) as unknown as PlcConnectFn });
      await service.connect(new FakeOwner(), {
        host: '127.0.0.1',
        rack: 0,
        slot: 2,
        connectionType: 'PG',
      });
      await vi.advanceTimersByTimeAsync(1900);
      expect(calls).toBe(2); // una per il collegamento, una per la sorveglianza
      await service.closeAll();
    });

    it('due errori di fila → lost', async () => {
      let calls = 0;
      const fake = {
        closed: false,
        close: async () => undefined,
        identity: async () => ({ orderNumber: 'X' }),
        protection: async () => ({}),
        mode: async () => {
          if (calls++ === 0) return 'RUN' as const;
          throw new S7Error('CPU_ERROR', 'errore');
        },
      };
      const service = new PlcService({ connect: (async () => fake) as unknown as PlcConnectFn });
      const owner = new FakeOwner();
      await service.connect(owner, { host: '127.0.0.1', rack: 0, slot: 2, connectionType: 'PG' });
      await vi.advanceTimersByTimeAsync(1100);
      expect(owner.events).toEqual([]); // un errore solo non basta
      await vi.advanceTimersByTimeAsync(1000);
      expect(owner.events).toEqual([{ kind: 'lost', reason: 'Collegamento interrotto' }]);
    });
  });
});

describe('startTestPlc e parsePlcAccess', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('non parte senza BAAPORTAL_TEST_PLC=1', async () => {
    vi.stubEnv('BAAPORTAL_TEST_PLC', '');
    await expect(startTestPlc()).rejects.toThrow(/BAAPORTAL_TEST_PLC/);
  });

  it('con la variabile parte su 127.0.0.1 e il servizio ci si collega', async () => {
    vi.stubEnv('BAAPORTAL_TEST_PLC', '1');
    const t = await startTestPlc();
    const service = new PlcService();
    const r = await service.connect(new FakeOwner(), {
      host: '127.0.0.1',
      port: t.port,
      rack: 0,
      slot: 2,
      connectionType: 'OP',
    });
    expect(r.ok && r.mode).toBe('RUN');
    await service.closeAll();
    await t.close();
  });

  it('parsePlcAccess rifiuta dati fuori intervallo', () => {
    const ok = { host: '127.0.0.1', rack: 0, slot: 2, connectionType: 'PG' };
    expect(parsePlcAccess(ok)).toEqual(ok);
    expect(parsePlcAccess({ ...ok, rack: 9 })).toBe('Rack non valido');
    expect(parsePlcAccess({ ...ok, connectionType: 'X' })).toBe('Tipo di collegamento non valido');
    expect(parsePlcAccess(null)).toBe('Dati di accesso non validi');
  });
});
