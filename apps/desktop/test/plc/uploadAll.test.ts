import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { S7Error, buildBlockFile, parseBlockFile } from '@baaportal/s7comm';
import { connectWriteTcp } from '@baaportal/s7comm/node';
import { listen, type ListeningCpu } from '@baaportal/s7-server/node';
import { SimCpu, simBackend } from '@baaportal/sim';
import type { PlcAccess, PlcUploadProgress } from '@baaportal/ui';
import { findCpu } from '@baaportal/catalog';
import {
  compileDevice,
  createCodeBlock,
  createGlobalDb,
  createPlcDevice,
} from '@baaportal/project';
import { compareBlocks } from '../../../../packages/ui/src/online/compare';
import { buildUploadedProject } from '../../../../packages/ui/src/online/uploadProject';
import { listOnlineBlocks } from '../../src/main/plc/onlineBlocks';
import { PlcService, type PlcOwner } from '../../src/main/plc/plcService';
import { registerPlc } from '../../src/main/plc/plcIpc';
import { UploadService, type UploadOwner } from '../../src/main/plc/uploadAll';

class FakeOwner implements UploadOwner {
  events: PlcUploadProgress[] = [];
  destroyed = false;
  private cbs = new Set<() => void>();
  isDestroyed(): boolean {
    return this.destroyed;
  }
  send(_c: string, e: PlcUploadProgress): void {
    this.events.push(e);
  }
  once(_e: 'destroyed', cb: () => void): void {
    this.cbs.add(cb);
  }
  removeListener(_e: 'destroyed', cb: () => void): void {
    this.cbs.delete(cb);
  }
  destroy(): void {
    this.destroyed = true;
    for (const cb of [...this.cbs]) cb();
  }
}

const PROPS = {
  maxCycleMs: 150,
  minCycleMs: 0,
  clockMemory: { enabled: false, byte: 0 },
  retentivity: { mBytes: 16, timers: 0, counters: 8 },
  cyclicInterruptMs: 0,
};

export function rawBlock(type: 'OB' | 'FC' | 'FB' | 'DB', number: number, mc7Length: number) {
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
    { author: 'A', family: 'F', name: 'N', version: '0.1', checksum: number },
  );
}

describe('UploadService contro il PLC di prova', () => {
  let cpu: SimCpu;
  let plc: ListeningCpu;
  const access = (): PlcAccess => ({
    host: '127.0.0.1',
    port: plc.port,
    rack: 0,
    slot: 2,
    connectionType: 'PG',
  });
  const put = async (files: Uint8Array[]) => {
    const w = await connectWriteTcp({
      host: '127.0.0.1',
      port: plc.port,
      rack: 0,
      slot: 2,
      timeoutMs: 2000,
    });
    try {
      for (const f of files) await w.downloadBlock(f);
    } finally {
      await w.close();
    }
  };

  beforeEach(async () => {
    cpu = new SimCpu({ cpuTypeId: 'cpu-315-2-pn-dp', props: PROPS });
    cpu.run();
    plc = await listen(simBackend(cpu), { port: 0 });
  });
  afterEach(async () => {
    await plc.close();
  });

  it('uploadAll contro il PLC di prova con OB1, FC1, DB1 → tre file', async () => {
    const sent = [rawBlock('OB', 1, 20), rawBlock('FC', 1, 12), rawBlock('DB', 1, 8)];
    await put(sent);
    const owner = new FakeOwner();
    const r = await new UploadService().start(owner, access());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files.map((f) => `${f.type}${f.number}`).sort()).toEqual(['DB1', 'FC1', 'OB1']);
    expect(r.failed).toEqual([]);
    expect(r.identity.orderNumber).toMatch(/6ES7/);
    for (const f of r.files) expect(parseBlockFile(f.bytes).header.number).toBe(f.number);
    const last = owner.events.at(-1);
    expect(last).toMatchObject({ done: 3, total: 3 });
  });

  it('interruzione → cancelled, nessun file', async () => {
    await put([rawBlock('OB', 1, 20), rawBlock('FC', 1, 12)]);
    const owner = new FakeOwner();
    const svc = new UploadService();
    const p = svc.start(owner, access());
    svc.cancel(owner);
    expect(await p).toEqual({ ok: false, cancelled: true });
  });

  it('cancel interrompe solo l\'esecuzione del proprio tipo', async () => {
    await put([rawBlock('OB', 1, 20)]);
    const owner = new FakeOwner();
    const svc = new UploadService();
    // Un caricamento non si ferma con l'interruzione del backup...
    const up = svc.start(owner, access());
    svc.cancel(owner, 'backup');
    expect((await up).ok).toBe(true);
    // ...e un backup non si ferma con quella del caricamento (`plc:uploadCancel`).
    const bk = svc.collect(owner, access(), { kind: 'backup' });
    svc.cancel(owner);
    expect((await bk).ok).toBe(true);
    const bk2 = svc.collect(owner, access(), { kind: 'backup' });
    svc.cancel(owner, 'backup');
    expect(await bk2).toEqual({ ok: false, cancelled: true });
  });

  it('un solo caricamento per finestra', async () => {
    const owner = new FakeOwner();
    const svc = new UploadService();
    const first = svc.start(owner, access());
    const second = await svc.start(owner, access());
    expect(second.ok).toBe(false);
    await first;
  });

  it('finestra distrutta durante il caricamento → interrotto, senza avanzamenti dopo', async () => {
    await put([rawBlock('OB', 1, 20)]);
    const owner = new FakeOwner();
    const p = new UploadService().start(owner, access());
    owner.destroy();
    expect(await p).toEqual({ ok: false, cancelled: true });
  });

  it('abortAll interrompe e aspetta la chiusura', async () => {
    const owner = new FakeOwner();
    const svc = new UploadService();
    const p = svc.start(owner, access());
    await svc.abortAll();
    expect(await p).toEqual({ ok: false, cancelled: true });
  });

  it('oltre il tetto dei blocchi → errore', async () => {
    await put([rawBlock('OB', 1, 20), rawBlock('FC', 1, 12)]);
    const r = await new UploadService({ maxBlocks: 1 }).start(new FakeOwner(), access());
    expect(r).toMatchObject({ ok: false });
    expect(r.ok === false && 'error' in r && r.error).toMatch(/Troppi blocchi/);
  });

  it('oltre il tetto dei byte → errore', async () => {
    await put([rawBlock('OB', 1, 20)]);
    const r = await new UploadService({ maxBytes: 10 }).start(new FakeOwner(), access());
    expect(r.ok === false && 'error' in r && r.error).toMatch(/Troppi dati/);
  });

  it('avanzamento al più 10 al secondo, più l’ultimo', async () => {
    await put(Array.from({ length: 12 }, (_, i) => rawBlock('FC', i + 1, 8)));
    const owner = new FakeOwner();
    const r = await new UploadService({ progressIntervalMs: 60_000 }).start(owner, access());
    expect(r.ok && r.files.length).toBe(12);
    expect(owner.events.map((e) => e.done)).toEqual([1, 12]);
  });

  it('nessuna CPU → errore leggibile', async () => {
    const r = await new UploadService({ connectTimeoutMs: 300 }).start(new FakeOwner(), {
      ...access(),
      port: 1,
    });
    expect(r.ok === false && 'error' in r && r.error).toMatch(/Nessuna risposta/);
  });

  it('canale plc:uploadAll valida l’accesso', async () => {
    const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
    registerPlc(
      (c, l) => handlers.set(c, l as never),
      async () => true,
    );
    const r = await handlers.get('plc:uploadAll')!({ sender: new FakeOwner() }, { host: '' });
    expect(r).toEqual({ ok: false, error: 'Indirizzo non valido' });
  });
});

describe('andata e ritorno contro il PLC di prova', () => {
  it('carica dal dispositivo, ricompila e confronta: tutti uguali', async () => {
    const cpu = new SimCpu({ cpuTypeId: 'cpu-315-2-pn-dp', props: PROPS });
    cpu.run();
    const plc = await listen(simBackend(cpu), { port: 0 });
    try {
      const dev = createPlcDevice({
        cpu: findCpu('cpu-315-2-pn-dp')!,
        orderNumber: '6ES7 315-2EH14-0AB0',
        firmware: 'V3.3',
        name: 'PLC_1',
        texts: { defaultTagTable: 'T' },
      });
      const ob = createCodeBlock({ kind: 'OB', number: 1, name: 'Main', language: 'AWL' });
      ob.networks[0]!.source = 'CALL FC 1\nA %I0.0\n= %Q0.0';
      dev.blocks = [ob];
      const fc = createCodeBlock({ kind: 'FC', number: 1, name: 'FC1', language: 'AWL' });
      fc.networks[0]!.source = 'A %I0.1\n= %Q0.1';
      dev.blocks.push(fc, createGlobalDb({ number: 1, name: 'DB1' }));
      const compiled = compileDevice(dev, findCpu(dev.cpu.typeId)).results;
      const w = await connectWriteTcp({
        host: '127.0.0.1',
        port: plc.port,
        rack: 0,
        slot: 2,
        timeoutMs: 2000,
      });
      try {
        for (const r of compiled) await w.downloadBlock(r.file!);
      } finally {
        await w.close();
      }

      const access: PlcAccess = {
        host: '127.0.0.1',
        port: plc.port,
        rack: 0,
        slot: 2,
        connectionType: 'PG',
      };
      const up = await new UploadService().start(new FakeOwner(), access);
      expect(up.ok).toBe(true);
      if (!up.ok) return;
      // I byte della CPU sono quelli scaricati.
      for (const f of up.files) {
        const sent = compiled
          .map((r) => r.file!)
          .find((b) => {
            const h = parseBlockFile(b).header;
            return h.type === f.type && h.number === f.number;
          })!;
        expect(Array.from(f.bytes)).toEqual(Array.from(sent));
      }

      const built = buildUploadedProject({
        files: up.files,
        identity: up.identity,
        access,
        now: new Date(),
        texts: {
          defaultTagTable: 'T',
          plc: 'PLC_1',
          namePrefix: 'Caricato da',
          missing: 'Blocchi non caricati',
        },
      });
      expect(built.skipped).toEqual([]);
      const again = compileDevice(built.device, findCpu(built.device.cpu.typeId)).results;
      const service = new PlcService({ intervalMs: 10_000 });
      const owner = new FakeOwner() as unknown as PlcOwner;
      try {
        expect((await service.connect(owner, access)).ok).toBe(true);
        const online = await listOnlineBlocks(service, owner);
        expect(online.ok).toBe(true);
        if (!online.ok) return;
        const rows = compareBlocks(
          again.map((x) => {
            const b = built.device.blocks.find((y) => y.id === x.blockId)!;
            return {
              id: b.id,
              type: b.kind === 'IDB' ? 'DB' : b.kind,
              number: b.number,
              ...(x.file ? { file: x.file } : {}),
            };
          }),
          online.blocks,
        );
        expect(rows.map((r) => `${r.type}${r.number}:${r.state}`).sort()).toEqual([
          'DB1:same',
          'FC1:same',
          'OB1:same',
        ]);
      } finally {
        await service.closeAll();
      }
    } finally {
      await plc.close();
    }
  });
});

describe('un blocco rifiutato dalla CPU', () => {
  const fakeConnect = (refuse: (type: string, n: number) => boolean) =>
    (async () => ({
      identity: async () => ({ orderNumber: '6ES7 315-2EH14-0AB0' }),
      close: async () => undefined,
      listBlocks: async (t: string) =>
        t === 'OB' ? [{ number: 1 }] : t === 'FC' ? [{ number: 1 }, { number: 2 }] : [],
      uploadWithInfo: async (t: string, n: number) => {
        if (refuse(t, n)) throw new S7Error('CPU_ERROR', 'accesso negato');
        return { bytes: rawBlock(t as 'OB' | 'FC', n, 8), declaredLength: null, warnings: [] };
      },
    })) as never;
  const access: PlcAccess = { host: '10.0.0.1', rack: 0, slot: 2, connectionType: 'PG' };

  it('gli altri si caricano e il blocco finisce in failed', async () => {
    const owner = new FakeOwner();
    const r = await new UploadService({
      connect: fakeConnect((t, n) => t === 'FC' && n === 1),
    }).start(owner, access);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files.map((f) => `${f.type}${f.number}`)).toEqual(['OB1', 'FC2']);
    expect(r.failed).toEqual([
      { type: 'FC', number: 1, error: expect.stringContaining('accesso negato') },
    ]);
    expect(owner.events.at(-1)).toMatchObject({ done: 3, total: 3 });
  });

  it('tutti rifiutati: nessun file e tutti in failed (decide il renderer)', async () => {
    const r = await new UploadService({ connect: fakeConnect(() => true) }).start(
      new FakeOwner(),
      access,
    );
    expect(r.ok && r.files.length).toBe(0);
    expect(r.ok && r.failed.length).toBe(3);
  });
});
