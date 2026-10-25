import { describe, expect, it } from 'vitest';
import { S7Error } from '@baaportal/s7comm';
import type { PlcAccess, PlcEvent } from '@baaportal/ui';
import { registerPlc } from '../../src/main/plc/plcIpc';
import { PlcService, type PlcConnectFn, type PlcOwner } from '../../src/main/plc/plcService';

class FakeOwner implements PlcOwner {
  events: PlcEvent[] = [];
  isDestroyed(): boolean {
    return false;
  }
  send(_channel: string, e: PlcEvent): void {
    this.events.push(e);
  }
  once(): void {}
  removeListener(): void {}
}

const ACCESS: PlcAccess = { host: '127.0.0.1', rack: 0, slot: 2, connectionType: 'PG' };

/** Collegamento finto con SOLE letture: nessun metodo di scrittura. */
function fakeClient(opts: {
  upload?: (t: string, n: number) => Promise<unknown>;
  delayMs?: number;
}) {
  const calls: string[] = [];
  let running = 0;
  let peak = 0;
  const slow = async <T>(v: T): Promise<T> => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, opts.delayMs ?? 0));
    running--;
    return v;
  };
  const fake = {
    closed: false,
    close: async () => undefined,
    identity: async () => ({ orderNumber: 'X', moduleName: 'CPU' }),
    mode: () => slow('RUN' as const),
    protection: async () => ({}),
    listBlocks: async () => [],
    blockInfo: async () => ({}),
    uploadWithInfo: async (t: string, n: number) => {
      calls.push(`${t}${n}`);
      running++;
      peak = Math.max(peak, running);
      try {
        await new Promise((r) => setTimeout(r, opts.delayMs ?? 0));
        return await (opts.upload?.(t, n) ?? { bytes: Uint8Array.from([1, 2, 3]), warnings: [] });
      } finally {
        running--;
      }
    },
  };
  return { fake, calls, peak: () => peak };
}

type Listener = (e: { sender: PlcOwner }, ...args: unknown[]) => unknown;

function setup(fake: unknown, intervalMs = 1000) {
  const service = new PlcService({
    intervalMs,
    connect: (async () => fake) as unknown as PlcConnectFn,
  });
  const handlers = new Map<string, Listener>();
  registerPlc(
    ((ch: string, l: Listener) => handlers.set(ch, l)) as never,
    (async () => false) as never,
    service,
  );
  const owner = new FakeOwner();
  const call = (type: unknown, number: unknown) =>
    handlers.get('plc:uploadBlock')!({ sender: owner }, type, number) as Promise<{
      ok: boolean;
      bytes?: Uint8Array;
      error?: string;
    }>;
  return { service, owner, call };
}

describe('plc:uploadBlock', () => {
  it.each([
    ['SFC', 1],
    ['SDB', 1],
    ['XX', 1],
    [7, 1],
    ['FC', -1],
    ['FC', 65536],
    ['FC', 1.5],
    ['FC', '1'],
    ['FC', NaN],
  ])('ingresso non valido %j %j → errore, il client non si tocca', async (type, number) => {
    const { fake, calls } = fakeClient({});
    const { service, owner, call } = setup(fake);
    try {
      await service.connect(owner, ACCESS);
      const r = await call(type, number);
      expect(r.ok).toBe(false);
      expect(calls).toEqual([]);
    } finally {
      await service.closeAll();
    }
  });

  it('senza collegamento → errore', async () => {
    const { fake, calls } = fakeClient({});
    const { call } = setup(fake);
    const r = await call('FC', 1);
    expect(r).toEqual({ ok: false, error: 'Nessun collegamento online' });
    expect(calls).toEqual([]);
  });

  it('percorso felice: i byte del client finto', async () => {
    const { fake, calls } = fakeClient({});
    const { service, owner, call } = setup(fake);
    try {
      await service.connect(owner, ACCESS);
      const r = await call('DB', 10);
      expect(r.ok).toBe(true);
      expect([...r.bytes!]).toEqual([1, 2, 3]);
      expect(calls).toEqual(['DB10']);
    } finally {
      await service.closeAll();
    }
  });

  it('S7Error CLOSED → errore e collegamento perso', async () => {
    const { fake } = fakeClient({
      upload: async () => {
        throw new S7Error('CLOSED', 'chiuso');
      },
    });
    const { service, owner, call } = setup(fake);
    try {
      await service.connect(owner, ACCESS);
      const r = await call('FC', 1);
      expect(r.ok).toBe(false);
      expect(owner.events).toContainEqual({ kind: 'lost', reason: 'closed' });
    } finally {
      await service.closeAll();
    }
  });

  it('non si intreccia con la sorveglianza', async () => {
    const f = fakeClient({ delayMs: 20 });
    const { service, owner, call } = setup(f.fake, 5);
    try {
      await service.connect(owner, ACCESS);
      const rs = await Promise.all([call('FC', 1), call('FC', 2)]);
      expect(rs.map((r) => r.ok)).toEqual([true, true]);
      expect(f.peak()).toBe(1);
    } finally {
      await service.closeAll();
    }
  });

  it('il client finto espone solo letture', () => {
    const { fake } = fakeClient({});
    const names = Object.keys(fake);
    expect(names.filter((n) => /download|delete|write|control|start|stop/i.test(n))).toEqual([]);
  });
});
