import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildBlockFile, parseBlockFile } from '@baaportal/s7comm';
import { connectWriteTcp } from '@baaportal/s7comm/node';
import { listen, type ListeningCpu } from '@baaportal/s7-server/node';
import { SimCpu, simBackend } from '@baaportal/sim';
import type { PlcAccess } from '@baaportal/ui';
import { listOnlineBlocks } from '../../src/main/plc/onlineBlocks';
import { PlcService, type PlcConnectFn, type PlcOwner } from '../../src/main/plc/plcService';

class FakeOwner implements PlcOwner {
  isDestroyed(): boolean {
    return false;
  }
  send(): void {}
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
