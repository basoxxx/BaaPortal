import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S7Error, buildBlockFile, parseBlockFile } from '@baaportal/s7comm';
import { connectWriteTcp } from '@baaportal/s7comm/node';
import { listen, type ListeningCpu } from '@baaportal/s7-server/node';
import { SimCpu, simBackend } from '@baaportal/sim';
import type { PlcAccess, PlcEvent } from '@baaportal/ui';
import { registerPlc } from '../../src/main/plc/plcIpc';
import { listOnlineBlocks } from '../../src/main/plc/onlineBlocks';
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

const PROPS = {
  maxCycleMs: 150,
  minCycleMs: 0,
  clockMemory: { enabled: false, byte: 0 },
  retentivity: { mBytes: 16, timers: 0, counters: 8 },
  cyclicInterruptMs: 0,
};

function block(
  type: 'OB' | 'FC' | 'FB' | 'DB',
  number: number,
  mc7Length: number,
  checksum: number,
) {
  return buildBlockFile(
    {
      type,
      number,
      language: 1,
      flags: 0,
      security: 0,
      codeTime: undefined,
      interfaceTime: undefined,
      codeTimeRaw: new Uint8Array(6),
      interfaceTimeRaw: new Uint8Array(6),
      ssbLength: 0,
      addLength: 0,
      localDataLength: 0,
      mc7Length,
    },
    new Uint8Array(mc7Length),
    { author: 'A', family: 'F', name: 'N', version: '0.1', checksum },
  );
}

describe('listOnlineBlocks contro il PLC di prova', () => {
  let cpu: SimCpu;
  let plc: ListeningCpu;
  let service: PlcService;
  const owner = new FakeOwner();
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
    service = new PlcService({ intervalMs: 10 });
  });
  afterEach(async () => {
    await service.closeAll();
    await plc.close();
  });

  it('senza collegamento: errore, non eccezione', async () => {
    expect(await listOnlineBlocks(service, owner)).toEqual({
      ok: false,
      error: 'Nessun collegamento online',
    });
  });

  it('elenca OB, FB, FC e DB con lunghezze e checksum', async () => {
    const w = await connectWriteTcp({
      host: '127.0.0.1',
      port: plc.port,
      rack: 0,
      slot: 2,
      timeoutMs: 2000,
    });
    const files = [block('FC', 7, 12, 0x1234), block('OB', 1, 20, 0x00aa)];
    try {
      for (const f of files) await w.downloadBlock(f);
    } finally {
      await w.close();
    }
    expect((await service.connect(owner, access())).ok).toBe(true);
    const r = await listOnlineBlocks(service, owner);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fc = r.blocks.find((b) => b.type === 'FC' && b.number === 7);
    const ob = r.blocks.find((b) => b.type === 'OB' && b.number === 1);
    expect(fc).toMatchObject({ mc7Length: 12, checksum: 0x1234 });
    expect(ob).toMatchObject({ mc7Length: 20, checksum: 0x00aa });
    expect(fc?.loadLength).toBe(files[0]!.length);
    expect(parseBlockFile(files[0]!).header.mc7Length).toBe(12);
    expect(r.blocks.every((b) => ['OB', 'FB', 'FC', 'DB'].includes(b.type))).toBe(true);
  });

  it('non corrono mai due richieste insieme sulla connessione, sorveglianza compresa', async () => {
    let running = 0;
    let peak = 0;
    const slow = async <T>(v: T): Promise<T> => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 30));
      running--;
      return v;
    };
    const fake = {
      closed: false,
      close: async () => undefined,
      identity: async () => ({ orderNumber: 'X', moduleName: 'CPU' }),
      mode: () => slow('RUN' as const),
      protection: async () => ({}),
      listBlocks: (t: string) => slow(t === 'OB' ? [{ number: 1, flags: 0, language: 1 }] : []),
      blockInfo: () => slow({ loadLength: 100, mc7Length: 10, checksum: 5 }),
    };
    const s = new PlcService({
      intervalMs: 5,
      connect: (async () => fake) as unknown as PlcConnectFn,
    });
    try {
      await s.connect(owner, access());
      const rs = await Promise.all([listOnlineBlocks(s, owner), listOnlineBlocks(s, owner)]);
      expect(rs.map((r) => r.ok)).toEqual([true, true]);
      expect(peak).toBe(1);
    } finally {
      await s.closeAll();
    }
  });
});

type Info = { loadLength?: number; mc7Length?: number; checksum?: number };

/** Collegamento finto: `blocks` OB numerati da 1, `info` decide la risposta di ogni blocchi. */
function fakeLink(
  blocks: number,
  info: (n: number) => Info | Error = () => ({ loadLength: 100, mc7Length: 10, checksum: 5 }),
  delayMs = 0,
) {
  let modeCalls = 0;
  const wait = () => new Promise((r) => setTimeout(r, delayMs));
  const fake = {
    closed: false,
    close: async () => undefined,
    identity: async () => ({ orderNumber: 'X', moduleName: 'CPU' }),
    mode: async () => {
      modeCalls++;
      await wait();
      return 'RUN' as const;
    },
    protection: async () => ({}),
    listBlocks: async (t: string) =>
      t === 'OB'
        ? Array.from({ length: blocks }, (_, i) => ({ number: i + 1, flags: 0, language: 1 }))
        : [],
    blockInfo: async (_t: string, n: number) => {
      await wait();
      const r = info(n);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { fake, modeCalls: () => modeCalls };
}

const ACC: PlcAccess = { host: '192.0.2.10', rack: 0, slot: 2, connectionType: 'PG' };
const via = (fake: unknown, intervalMs = 5) =>
  new PlcService({ intervalMs, connect: (async () => fake) as unknown as PlcConnectFn });

describe('listOnlineBlocks: lotti, errori per blocco, collegamento perso', () => {
  it('un errore della CPU su un blocco lo segna illeggibile, gli altri restano', async () => {
    const { fake } = fakeLink(3, (n) =>
      n === 2
        ? new S7Error('CPU_ERROR', 'blocco non trovato')
        : n === 3
          ? { loadLength: 1 } // senza checksum né lunghezza MC7
          : { loadLength: 100, mc7Length: 10, checksum: 5 },
    );
    const s = via(fake);
    const owner = new FakeOwner();
    await s.connect(owner, ACC);
    const r = await listOnlineBlocks(s, owner);
    await s.closeAll();
    expect(r.ok && r.blocks.map((b) => [b.number, !!b.unreadable])).toEqual([
      [1, false],
      [2, true],
      [3, true],
    ]);
  });

  it('collegamento chiuso a metà: tutto fallisce e la finestra riceve lost', async () => {
    const { fake } = fakeLink(25, (n) =>
      n === 12 ? new S7Error('CLOSED', 'chiuso') : { mc7Length: 1, checksum: 1 },
    );
    const s = via(fake, 1000);
    const owner = new FakeOwner();
    await s.connect(owner, ACC);
    const r = await listOnlineBlocks(s, owner);
    expect(r).toEqual({ ok: false, error: 'chiuso' });
    expect(owner.events).toEqual([{ kind: 'lost', reason: 'closed' }]);
    expect(s.status(owner).connected).toBe(false);
  });

  it('senza risposta (TIMEOUT): lost con motivo timeout', async () => {
    const { fake } = fakeLink(2, () => new S7Error('TIMEOUT', 'nessuna risposta'));
    const s = via(fake, 1000);
    const owner = new FakeOwner();
    await s.connect(owner, ACC);
    expect((await listOnlineBlocks(s, owner)).ok).toBe(false);
    expect(owner.events).toEqual([{ kind: 'lost', reason: 'timeout' }]);
    await s.closeAll();
  });

  it('oltre 2000 blocchi: errore chiaro, nessuna informazione richiesta', async () => {
    const { fake } = fakeLink(2001);
    const info = vi.spyOn(fake, 'blockInfo');
    const s = via(fake, 1000);
    const owner = new FakeOwner();
    await s.connect(owner, ACC);
    const r = await listOnlineBlocks(s, owner);
    await s.closeAll();
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toMatch(/Troppi blocchi.*2000/);
    expect(info).not.toHaveBeenCalled();
    expect(owner.events).toEqual([]);
  });

  it('la sorveglianza gira durante un elenco lungo', async () => {
    const { fake, modeCalls } = fakeLink(60, undefined, 4);
    const s = via(fake, 5);
    const owner = new FakeOwner();
    await s.connect(owner, ACC);
    const before = modeCalls();
    const r = await listOnlineBlocks(s, owner);
    await s.closeAll();
    expect(r.ok && r.blocks).toHaveLength(60);
    expect(modeCalls() - before).toBeGreaterThan(1);
  });

  it('oltre la scadenza i lotti successivi non partono', async () => {
    const { fake } = fakeLink(60, undefined, 5);
    const s = via(fake, 1000);
    const owner = new FakeOwner();
    await s.connect(owner, ACC);
    const r = await listOnlineBlocks(s, owner, 60);
    await s.closeAll();
    expect(!r.ok && r.error).toMatch(/troppo lunga/);
    expect(owner.events).toEqual([]);
  });
});

describe('registerPlc: canale plc:blocks', () => {
  type H = (e: unknown, ...a: unknown[]) => Promise<unknown>;
  it('senza collegamento: errore; con collegamento: elenco', async () => {
    const handlers = new Map<string, H>();
    const { fake } = fakeLink(2);
    const service = via(fake, 1000);
    registerPlc(
      (ch, l) => handlers.set(ch, l as H),
      async () => false,
      service,
    );
    const owner = new FakeOwner();
    const e = { sender: owner };
    expect(await handlers.get('plc:blocks')!(e)).toEqual({
      ok: false,
      error: 'Nessun collegamento online',
    });
    await service.connect(owner, ACC);
    const r = (await handlers.get('plc:blocks')!(e)) as { ok: boolean; blocks: unknown[] };
    expect(r.ok).toBe(true);
    expect(r.blocks).toHaveLength(2);
    await service.closeAll();
  });
});
