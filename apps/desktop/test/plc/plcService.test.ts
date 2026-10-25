import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBlockFile, encodeWriteRequest, S7Error } from '@baaportal/s7comm';
import { connectTcp, connectTestTcp, connectWriteTcp, openTcp } from '@baaportal/s7comm/node';
import { FakeCpu, type FakeCpuOptions } from '@baaportal/s7-server';
import { listen, type ListeningCpu } from '@baaportal/s7-server/node';
import { SimCpu, simBackend } from '@baaportal/sim';
import type { PlcAccess, PlcEvent } from '@baaportal/ui';
import { PlcService, type PlcConnectFn, type PlcOwner } from '../../src/main/plc/plcService';
import { startTestPlc } from '../../src/main/plc/testPlc';
import { parsePlcAccess } from '../../src/main/plc/plcIpc';
import { readDiagnostics } from '../../src/main/plc/diagnostics';

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
    expect(owner.events).toEqual([{ kind: 'lost', reason: 'closed' }]);
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

  it('onConnect a ogni collegamento riuscito; onLinkEnd una volta per disconnect, lost e finestra distrutta', async () => {
    const connected: PlcOwner[] = [];
    service.onConnect((o) => connected.push(o));
    const ends: string[] = [];
    const a = new FakeOwner();
    await service.connect(a, access());
    expect(connected).toEqual([a]);
    service.onLinkEnd(a, () => ends.push('disconnect'));
    await service.disconnect(a);
    expect(ends).toEqual(['disconnect']);

    const b = new FakeOwner();
    await service.connect(b, access());
    service.onLinkEnd(b, () => ends.push('destroyed'));
    b.destroy();
    expect(ends).toEqual(['disconnect', 'destroyed']);

    const c = new FakeOwner();
    await service.connect(c, access());
    service.onLinkEnd(c, () => ends.push('lost'));
    await plc.close();
    await waitFor(() => ends.includes('lost'));
    expect(ends.filter((e) => e === 'lost')).toHaveLength(1);
    // senza collegamento la richiesta scatta subito
    service.onLinkEnd(c, () => ends.push('subito'));
    await waitFor(() => ends.includes('subito'));
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
      expect(owner.events).toEqual([{ kind: 'lost', reason: 'timeout' }]);
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
      expect(owner.events).toEqual([{ kind: 'lost', reason: 'errors' }]);
    });
  });
});

describe('startTestPlc e parsePlcAccess', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('non parte senza BAAPORTAL_TEST_PLC=1', async () => {
    vi.stubEnv('BAAPORTAL_TEST_PLC', '');
    await expect(startTestPlc()).rejects.toThrow(/BAAPORTAL_TEST_PLC/);
  });

  it('tisJobs() elenca i job di stato del blocco vivi nel PLC di prova', async () => {
    vi.stubEnv('BAAPORTAL_TEST_PLC', '1');
    const t = await startTestPlc();
    try {
      expect(await t.tisJobs()).toEqual([]);
      const opts = {
        host: '127.0.0.1',
        port: t.port,
        rack: 0,
        slot: 2,
        connectionType: 'pg' as const,
      };
      const w = await connectWriteTcp(opts);
      const T0 = { year: 2020, month: 5, day: 17, hour: 10, minute: 20, second: 30, ms: 0 };
      await w.downloadBlock(
        buildBlockFile(
          {
            type: 'OB',
            number: 1,
            language: 1,
            flags: 0x01,
            security: 0,
            codeTime: T0,
            interfaceTime: T0,
            ssbLength: 0,
            addLength: 0,
            localDataLength: 0,
            mc7Length: 20,
          },
          Uint8Array.from({ length: 20 }, (_, i) => 2 + i),
          { author: 'BAA', family: 'TEST', name: 'OB1', version: '1.1', checksum: 0x1234 },
        ),
      );
      await w.close();
      const c = await connectTestTcp({ ...opts, connectionType: 'pg' });
      await c.createBlockStatus(
        { type: 'OB', number: 1, initMask: 3, lines: [{ offset: 0, mask: 3 }] },
        4,
      );
      expect(await t.tisJobs()).toHaveLength(1);
      await c.close();
    } finally {
      await t.close();
    }
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

  it('il PLC di prova elenca i due SDB sintetici (0 e 1) e li dà in upload', async () => {
    vi.stubEnv('BAAPORTAL_TEST_PLC', '1');
    const t = await startTestPlc();
    const c = await connectTcp({ host: '127.0.0.1', port: t.port, timeoutMs: 3000 });
    expect((await c.listBlocks('SDB')).map((b) => b.number)).toEqual([0, 1]);
    const file = await c.upload('SDB', 1);
    expect(new TextDecoder().decode(file)).toContain('BaaPortal SDB di prova');
    await c.close();
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

describe('PlcService, LED FRCE (forzamento attivo)', () => {
  let cpu: FakeCpu;
  let plc: ListeningCpu;
  let service: PlcService;
  /** Letture SZL per id e indice, contate sul client. */
  let reads: string[];
  let failForce = false;

  async function start(o: FakeCpuOptions = {}): Promise<FakeOwner> {
    cpu = new FakeCpu(o);
    plc = await listen(cpu, { port: 0 });
    reads = [];
    service = new PlcService({
      intervalMs: 10,
      readTimeoutMs: 500,
      connect: (async (opts) => {
        const c = await connectTcp(opts);
        const orig = c.readSzl.bind(c);
        c.readSzl = async (id, index) => {
          reads.push(`${id.toString(16)}/${index}`);
          if (failForce && id === 0x0174) throw new S7Error('PROTOCOL', 'prova');
          return orig(id, index);
        };
        return c;
      }) as PlcConnectFn,
    });
    return new FakeOwner();
  }
  const access = (): PlcAccess => ({
    host: '127.0.0.1',
    port: plc.port,
    rack: 0,
    slot: 2,
    connectionType: 'PG',
  });
  const forceReads = (): number => reads.filter((r) => r === '174/6').length;
  const modeReads = (): number => reads.filter((r) => r === '424/0').length;
  afterEach(async () => {
    failForce = false;
    await service.closeAll();
    await plc.close();
  });

  it('forceActive → evento force true entro 5 giri, poi false; una lettura ogni 5 giri', async () => {
    const owner = await start();
    const r = await service.connect(owner, access());
    expect(r.ok && r.force).toBe(false);
    cpu.forceActive = true;
    await waitFor(() => owner.events.some((e) => e.kind === 'force'));
    expect(owner.events).toEqual([{ kind: 'force', active: true }]);
    cpu.forceActive = false;
    await waitFor(() => owner.events.length === 2);
    expect(owner.events[1]).toEqual({ kind: 'force', active: false });
    await service.disconnect(owner);
    const polls = modeReads() - 1; // una lettura del modo è del collegamento
    const polled = forceReads() - 1; // una lettura del LED è del collegamento
    expect(polled).toBeGreaterThanOrEqual(Math.floor(polls / 5) - 1);
    expect(polled).toBeLessThanOrEqual(Math.floor(polls / 5));
  });

  it('collegamento con FRCE acceso → force true nel risultato, nessun evento', async () => {
    const owner = await start({ forceActive: true });
    const r = await service.connect(owner, access());
    expect(r.ok && r.force).toBe(true);
    await new Promise((res) => setTimeout(res, 150));
    expect(owner.events).toEqual([]);
  });

  it('0x0174 non disponibile → nessun evento e nessuna nuova lettura', async () => {
    const owner = await start({ faults: { szlUnavailable: [0x0174] } });
    const r = await service.connect(owner, access());
    expect(r.ok && r.force).toBeUndefined();
    await waitFor(() => modeReads() > 20);
    expect(forceReads()).toBe(1);
    expect(owner.events).toEqual([]);
  });

  it('errore della lettura FRCE → la sorveglianza non perde il collegamento', async () => {
    const owner = await start();
    await service.connect(owner, access());
    failForce = true;
    await waitFor(() => forceReads() >= 4);
    expect(owner.events.filter((e) => e.kind === 'lost')).toEqual([]);
    expect(service.status(owner).connected).toBe(true);
  });

  it('readDiagnostics([force]) → value true con forceActive', async () => {
    const owner = await start({ forceActive: true });
    await service.connect(owner, access());
    const r = await readDiagnostics(service, owner, ['force']);
    expect(r).toEqual({ ok: true, data: { force: { ok: true, value: true } } });
    cpu.forceActive = false;
    const r2 = await readDiagnostics(service, owner, ['force']);
    expect(r2).toEqual({ ok: true, data: { force: { ok: true, value: false } } });
  });
});
