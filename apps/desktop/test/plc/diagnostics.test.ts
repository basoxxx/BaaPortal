import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { S7Error } from '@baaportal/s7comm';
import { listen, type ListeningCpu } from '@baaportal/s7-server/node';
import { SimCpu, simBackend } from '@baaportal/sim';
import type { PlcAccess, PlcEvent } from '@baaportal/ui';
import { parseDiagParts, readDiagnostics } from '../../src/main/plc/diagnostics';
import { PlcService, type PlcConnectFn, type PlcOwner } from '../../src/main/plc/plcService';

class FakeOwner implements PlcOwner {
  events: PlcEvent[] = [];
  private listeners = new Set<() => void>();
  isDestroyed(): boolean {
    return false;
  }
  send(_channel: string, e: PlcEvent): void {
    this.events.push(e);
  }
  once(_e: 'destroyed', cb: () => void): void {
    this.listeners.add(cb);
  }
  removeListener(_e: 'destroyed', cb: () => void): void {
    this.listeners.delete(cb);
  }
}

const PROPS = {
  maxCycleMs: 150,
  minCycleMs: 0,
  clockMemory: { enabled: false, byte: 0 },
  retentivity: { mBytes: 16, timers: 0, counters: 8 },
  cyclicInterruptMs: 0,
};

const ALL = [
  'identity',
  'mode',
  'leds',
  'protection',
  'lastModeChange',
  'cycle',
  'memory',
  'buffer',
  'clock',
] as const;

describe('readDiagnostics contro il PLC di prova', () => {
  let cpu: SimCpu;
  let plc: ListeningCpu;
  let service: PlcService;
  let owner: FakeOwner;
  const access = (): PlcAccess => ({
    host: '127.0.0.1',
    port: plc.port,
    rack: 0,
    slot: 2,
    connectionType: 'PG',
  });
  const start = async (faults: { szlUnavailable?: number[] } = {}): Promise<void> => {
    cpu = new SimCpu({ cpuTypeId: 'cpu-315-2-pn-dp', props: PROPS });
    cpu.run();
    const backend = simBackend(cpu);
    backend.config.faults = faults;
    plc = await listen(backend, { port: 0 });
    service = new PlcService({ intervalMs: 50, readTimeoutMs: 500 });
    owner = new FakeOwner();
    expect((await service.connect(owner, access())).ok).toBe(true);
  };
  beforeEach(() => start());
  afterEach(async () => {
    await service.closeAll();
    await plc.close();
  });

  it('tutte le parti ok, buffer con la voce più recente in testa', async () => {
    cpu.stop();
    cpu.run();
    const r = await readDiagnostics(service, owner, [...ALL]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const p of ALL) expect(r.data[p], p).toMatchObject({ ok: true });
    const buf = r.data.buffer!;
    if (!buf.ok) throw new Error('buffer');
    expect(buf.value.length).toBeGreaterThan(1);
    expect(buf.value[0]!.eventId).toBe(0x4302); // l'ultimo cambio di modo: STOP → RUN
    const ms = (e: {
      time?: {
        year: number;
        month: number;
        day: number;
        hour: number;
        minute: number;
        second: number;
      };
    }) =>
      e.time
        ? Date.UTC(
            e.time.year,
            e.time.month - 1,
            e.time.day,
            e.time.hour,
            e.time.minute,
            e.time.second,
          )
        : 0;
    for (let i = 1; i < buf.value.length; i++) {
      expect(ms(buf.value[i - 1]!)).toBeGreaterThanOrEqual(ms(buf.value[i]!));
    }
    expect(r.data.mode).toEqual({ ok: true, value: 'RUN' });
  });

  it('una parte sola: solo quella nel risultato', async () => {
    const r = await readDiagnostics(service, owner, ['mode']);
    expect(r).toEqual({ ok: true, data: { mode: { ok: true, value: 'RUN' } } });
  });

  it('parti non valide o ripetute dal renderer → errore senza nessuna lettura', async () => {
    let reads = 0;
    const spy = {
      read: async () => {
        reads++;
        return { ok: false as const, error: 'x' };
      },
    };
    for (const bad of [['mode', 'mode'], ['nonEsiste'], 'mode', [1], [...ALL, 'mode'], null]) {
      const r = await readDiagnostics(spy, owner, bad);
      expect(r.ok).toBe(false);
    }
    expect(reads).toBe(0);
    expect(parseDiagParts(['mode', 'leds'])).toEqual(['mode', 'leds']);
    expect(typeof parseDiagParts(['mode', 'mode'])).toBe('string');
  });

  it('senza collegamento online → errore', async () => {
    await service.disconnect(owner);
    expect(await readDiagnostics(service, owner, ['mode'])).toEqual({
      ok: false,
      error: 'Nessun collegamento online',
    });
  });
});

describe('readDiagnostics: SZL non disponibili', () => {
  it('faults.szlUnavailable [0x0013, 0x0124] → memory e lastModeChange non disponibili, le altre ok, collegamento vivo', async () => {
    const cpu = new SimCpu({ cpuTypeId: 'cpu-315-2-pn-dp', props: PROPS });
    cpu.run();
    const backend = simBackend(cpu);
    backend.config.faults = { szlUnavailable: [0x0013, 0x0124] };
    const plc = await listen(backend, { port: 0 });
    const service = new PlcService({ intervalMs: 50, readTimeoutMs: 500 });
    const owner = new FakeOwner();
    await service.connect(owner, {
      host: '127.0.0.1',
      port: plc.port,
      rack: 0,
      slot: 2,
      connectionType: 'PG',
    });
    try {
      const r = await readDiagnostics(service, owner, [...ALL]);
      if (!r.ok) throw new Error(r.error);
      expect(r.data.memory).toEqual({ ok: false, unavailable: true });
      expect(r.data.lastModeChange).toEqual({ ok: false, unavailable: true });
      for (const p of ALL.filter((x) => x !== 'memory' && x !== 'lastModeChange')) {
        expect(r.data[p], p).toMatchObject({ ok: true });
      }
      expect(service.status(owner).connected).toBe(true);
      expect(owner.events).toEqual([]);
    } finally {
      await service.closeAll();
      await plc.close();
    }
  });
});

describe('readDiagnostics con collegamento finto', () => {
  const SZL = (id: number) => ({ id, index: 0, recordLength: 0, records: [], declaredCount: 0 });
  function fakeService(readSzl: (id: number, index: number) => Promise<unknown>) {
    const client = {
      identity: async () => ({ orderNumber: '6ES7 315-2EH14-0AB0' }),
      mode: async () => 'RUN',
      protection: async () => ({}),
      close: async () => undefined,
      closed: false,
      listBlocks: async () => [],
      blockInfo: async () => ({}),
      uploadWithInfo: async () => ({}),
      readSzl,
      readClock: async () => ({}),
    };
    const connect = (async () => client) as unknown as PlcConnectFn;
    return new PlcService({ connect, intervalMs: 100_000 });
  }
  const access: PlcAccess = { host: '192.0.2.1', rack: 0, slot: 2, connectionType: 'PG' };

  it('una SZL con un altro errore di CPU → error solo per quella parte', async () => {
    const service = fakeService(async (id) => {
      if (id === 0x0013) {
        throw new S7Error('CPU_ERROR', 'rifiutato', { errorClass: 0xd2, errorCode: 0x41 });
      }
      return SZL(id);
    });
    const owner = new FakeOwner();
    await service.connect(owner, access);
    const r = await readDiagnostics(service, owner, ['memory', 'buffer']);
    if (!r.ok) throw new Error(r.error);
    expect(r.data.memory).toMatchObject({ ok: false, error: expect.stringContaining('rifiutato') });
    expect(r.data.buffer).toEqual({ ok: true, value: [] });
    expect(service.status(owner).connected).toBe(true);
    await service.closeAll();
  });

  it('CPU che chiude durante la lettura → { ok:false }, evento lost, nessuna eccezione', async () => {
    const service = fakeService(async (id) => {
      if (id === 0x0019) throw new S7Error('CLOSED', 'chiuso');
      return SZL(id);
    });
    const owner = new FakeOwner();
    await service.connect(owner, access);
    const r = await readDiagnostics(service, owner, ['mode', 'leds', 'buffer']);
    expect(r.ok).toBe(false);
    expect(owner.events).toEqual([{ kind: 'lost', reason: 'closed' }]);
    expect(service.status(owner).connected).toBe(false);
  });

  it('TIMEOUT durante la lettura → { ok:false }, lost per timeout, collegamento chiuso', async () => {
    const service = fakeService(async (id) => {
      if (id === 0x0019) throw new S7Error('TIMEOUT', 'nessuna risposta');
      return SZL(id);
    });
    const owner = new FakeOwner();
    await service.connect(owner, access);
    const r = await readDiagnostics(service, owner, ['mode', 'leds']);
    expect(r.ok).toBe(false);
    expect(owner.events).toEqual([{ kind: 'lost', reason: 'timeout' }]);
    expect(service.status(owner).connected).toBe(false);
  });

  it('oltre la scadenza: parti già lette restano, le altre «Lettura troppo lunga», collegamento vivo', async () => {
    const service = fakeService(async (id) => {
      await new Promise((r) => setTimeout(r, 40));
      return SZL(id);
    });
    const owner = new FakeOwner();
    await service.connect(owner, access);
    const r = await readDiagnostics(service, owner, ['mode', 'leds', 'buffer', 'memory'], 50);
    if (!r.ok) throw new Error(r.error);
    expect(r.data.mode).toMatchObject({ ok: true });
    expect(r.data.leds).toMatchObject({ ok: true });
    expect(r.data.buffer).toEqual({ ok: false, error: 'Lettura troppo lunga' });
    expect(r.data.memory).toEqual({ ok: false, error: 'Lettura troppo lunga' });
    expect(service.status(owner).connected).toBe(true);
    expect(owner.events).toEqual([]);
    await service.closeAll();
  });
});
