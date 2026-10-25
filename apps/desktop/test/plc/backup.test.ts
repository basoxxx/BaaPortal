import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S7Error, buildBlockFile } from '@baaportal/s7comm';
import { connectTcp, connectWriteTcp } from '@baaportal/s7comm/node';
import { syntheticSdb } from '@baaportal/s7-server';
import { listen, type ListeningCpu } from '@baaportal/s7-server/node';
import { SimCpu, simBackend } from '@baaportal/sim';
import { decodeBackup } from '@baaportal/project';
import type { PlcAccess } from '@baaportal/ui';
import { BackupService, suggestedBackupName, type BackupOwner } from '../../src/main/plc/backup';
import { listOnlineBlocks } from '../../src/main/plc/onlineBlocks';
import { PlcService } from '../../src/main/plc/plcService';
import {
  UploadService,
  type UploadConnectFn,
  type UploadOwner,
} from '../../src/main/plc/uploadAll';

class Owner implements BackupOwner {
  events: unknown[] = [];
  destroyed = false;
  private cbs = new Set<() => void>();
  isDestroyed(): boolean {
    return this.destroyed;
  }
  send(_c: string, e: unknown): void {
    this.events.push(e);
  }
  once(_e: 'destroyed', cb: () => void): void {
    this.cbs.add(cb);
  }
  removeListener(_e: 'destroyed', cb: () => void): void {
    this.cbs.delete(cb);
  }
}

const PROPS = {
  maxCycleMs: 150,
  minCycleMs: 0,
  clockMemory: { enabled: false, byte: 0 },
  retentivity: { mBytes: 16, timers: 0, counters: 8 },
  cyclicInterruptMs: 0,
};

function block(type: 'OB' | 'DB', number: number, mc7Length: number) {
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

describe('backup online contro il PLC di prova', () => {
  let plc: ListeningCpu;
  let dir: string;
  let service: PlcService;
  const owner = new Owner();
  const access = (): PlcAccess => ({
    host: '127.0.0.1',
    port: plc.port,
    rack: 0,
    slot: 2,
    connectionType: 'PG',
  });
  const target = () => join(dir, 'prova.baapbak');

  beforeEach(async () => {
    const cpu = new SimCpu({ cpuTypeId: 'cpu-315-2-pn-dp', props: PROPS });
    cpu.run();
    plc = await listen(
      simBackend(cpu, { systemBlocks: [syntheticSdb(0, 64), syntheticSdb(1, 64)] }),
      { port: 0 },
    );
    const w = await connectWriteTcp({
      host: '127.0.0.1',
      port: plc.port,
      rack: 0,
      slot: 2,
      timeoutMs: 2000,
    });
    try {
      await w.downloadBlock(block('OB', 1, 20));
      await w.downloadBlock(block('DB', 1, 8));
    } finally {
      await w.close();
    }
    dir = await mkdtemp(join(tmpdir(), 'baabak-'));
    service = new PlcService();
    expect((await service.connect(owner, access())).ok).toBe(true);
  });
  afterEach(async () => {
    await service.closeAll();
    await plc.close();
    await rm(dir, { recursive: true, force: true });
  });

  const make = (
    over: { uploads?: UploadService; pick?: () => Promise<string | null> } = {},
  ): BackupService =>
    new BackupService({
      service,
      uploads: over.uploads ?? new UploadService(),
      pick: over.pick ?? (async () => target()),
      appVersion: () => '9.9.9',
    });

  /** Collegamento finto che avvolge quello vero, per cambiare una sola risposta. */
  const wrapping =
    (
      patch: (c: Awaited<ReturnType<UploadConnectFn>>) => object,
      seen?: string[],
    ): UploadConnectFn =>
    async (o) => {
      seen?.push(String(o.mode));
      const c = (await connectTcp(o as never)) as unknown as Awaited<ReturnType<UploadConnectFn>>;
      const base = {
        identity: () => c.identity(),
        close: () => c.close(),
        listBlocks: (t: never) => c.listBlocks(t),
        uploadWithInfo: (t: never, n: number) => c.uploadWithInfo(t, n),
      };
      return { ...base, ...patch(c) } as Awaited<ReturnType<UploadConnectFn>>;
    };

  it('OB1, DB1, SDB 0 e SDB 1 → 4 blocchi, byte identici all’upload, manifest con la CPU', async () => {
    const r = await make().backup(owner);
    expect(r).toMatchObject({ ok: true, path: target(), count: 4, failed: [] });
    const { manifest, files } = decodeBackup(new Uint8Array(await readFile(target())), (b) =>
      createHash('sha256').update(b).digest('hex'),
    );
    expect(manifest.blocks.map((b) => `${b.type}${b.number}`).sort()).toEqual([
      'DB1',
      'OB1',
      'SDB0',
      'SDB1',
    ]);
    expect(manifest.cpu).toMatchObject({
      orderNumber: expect.stringMatching(/6ES7/),
      host: '127.0.0.1',
      port: plc.port,
      rack: 0,
      slot: 2,
    });
    expect(manifest).toMatchObject({ app: '9.9.9', mode: 'RUN', failed: [] });
    const c = await connectTcp({ host: '127.0.0.1', port: plc.port, timeoutMs: 2000 });
    try {
      for (const b of manifest.blocks) {
        const direct = (await c.uploadWithInfo(b.type, b.number)).bytes;
        expect(files[b.file]).toEqual(direct);
      }
    } finally {
      await c.close();
    }
    expect(await readdir(dir)).toEqual(['prova.baapbak']);
  });

  it('il collegamento del backup è read-only', async () => {
    const seen: string[] = [];
    const uploads = new UploadService({ connect: wrapping(() => ({}), seen) });
    expect((await make({ uploads }).backup(owner)).ok).toBe(true);
    expect(seen).toEqual(['read-only']);
  });

  it('Annulla nel salvataggio → nessun collegamento', async () => {
    const seen: string[] = [];
    const uploads = new UploadService({ connect: wrapping(() => ({}), seen) });
    const r = await make({ uploads, pick: async () => null }).backup(owner);
    expect(r).toEqual({ ok: false, cancelled: true });
    expect(seen).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });

  it('interruzione a metà → nessun file né temporaneo', async () => {
    const holder: { svc?: BackupService } = {};
    const uploads = new UploadService({
      connect: wrapping((c) => ({
        uploadWithInfo: async (t: never, n: number) => {
          holder.svc?.cancel(owner);
          return c.uploadWithInfo(t, n);
        },
      })),
    });
    const svc = make({ uploads });
    holder.svc = svc;
    expect(await svc.backup(owner)).toEqual({ ok: false, cancelled: true });
    expect(await readdir(dir)).toEqual([]);
  });

  it('CPU raggiunta diversa da quella online → annullato', async () => {
    const uploads = new UploadService({
      connect: wrapping((c) => ({
        identity: async () => ({ ...(await c.identity()), orderNumber: '6ES7 000-0AA00-0AA0' }),
      })),
    });
    const r = await make({ uploads }).backup(owner);
    expect(r.ok === false && 'error' in r && r.error).toMatch(/diversa/);
    expect(await readdir(dir)).toEqual([]);
  });

  it('blocco rifiutato dalla CPU → in failed, gli altri salvati', async () => {
    const uploads = new UploadService({
      connect: wrapping((c) => ({
        uploadWithInfo: async (t: never, n: number) => {
          if ((t as string) === 'DB') throw new S7Error('CPU_ERROR', 'protetto');
          return c.uploadWithInfo(t, n);
        },
      })),
    });
    const r = await make({ uploads }).backup(owner);
    expect(r).toMatchObject({ ok: true, count: 3 });
    if (!r.ok || 'cancelled' in r) return;
    expect(r.failed).toEqual([
      { type: 'DB', number: 1, error: expect.stringContaining('protetto') },
    ]);
    const { manifest } = decodeBackup(new Uint8Array(await readFile(target())), (b) =>
      createHash('sha256').update(b).digest('hex'),
    );
    expect(manifest.failed).toHaveLength(1);
    expect(manifest.blocks).toHaveLength(3);
  });

  it('tutti i blocchi rifiutati → errore, nessun file', async () => {
    const uploads = new UploadService({
      connect: wrapping(() => ({
        uploadWithInfo: async () => {
          throw new S7Error('CPU_ERROR', 'protetto');
        },
      })),
    });
    const r = await make({ uploads }).backup(owner);
    expect(r.ok === false && 'error' in r && r.error).toMatch(/^Nessun blocco copiato: .*protetto/);
    expect(await readdir(dir)).toEqual([]);
  });

  it('Interrompi mentre la finestra di salvataggio è aperta → nessun collegamento', async () => {
    const seen: string[] = [];
    const uploads = new UploadService({ connect: wrapping(() => ({}), seen) });
    let release!: () => void;
    const holder: { svc?: BackupService } = {};
    const svc = make({
      uploads,
      pick: () => new Promise((res) => (release = () => res(target()))),
    });
    holder.svc = svc;
    const p = svc.backup(owner);
    await new Promise((r) => setTimeout(r, 10));
    svc.cancel(owner);
    release();
    expect(await p).toEqual({ ok: false, cancelled: true });
    expect(seen).toEqual([]);
    // anche abortAll
    const p2 = svc.backup(owner);
    await new Promise((r) => setTimeout(r, 10));
    svc.abortAll();
    release();
    expect(await p2).toEqual({ ok: false, cancelled: true });
    expect(seen).toEqual([]);
  });

  it('collegamento caduto durante la finestra → errore, nessun collegamento', async () => {
    const seen: string[] = [];
    const uploads = new UploadService({ connect: wrapping(() => ({}), seen) });
    const r = await make({
      uploads,
      pick: async () => {
        await service.disconnect(owner);
        return target();
      },
    }).backup(owner);
    expect(r).toEqual({ ok: false, error: 'Nessun collegamento online' });
    expect(seen).toEqual([]);
  });

  it('oltre MAX_BLOCKS → errore senza file', async () => {
    const r = await make({ uploads: new UploadService({ maxBlocks: 2 }) }).backup(owner);
    expect(r.ok === false && 'error' in r && r.error).toMatch(/Troppi blocchi/);
    expect(await readdir(dir)).toEqual([]);
  });

  it('senza collegamento online → errore, nessuna finestra', async () => {
    let asked = false;
    const r = await make({
      pick: async () => {
        asked = true;
        return target();
      },
    }).backup(new Owner());
    expect(r).toEqual({ ok: false, error: 'Nessun collegamento online' });
    expect(asked).toBe(false);
  });

  it('regressione: né uploadAll né listOnlineBlocks danno SDB, solo il backup', async () => {
    const up = await new UploadService().start(owner as UploadOwner, access());
    expect(up.ok && up.files.map((f) => `${f.type}${f.number}`).sort()).toEqual(['DB1', 'OB1']);
    const list = await listOnlineBlocks(service, owner);
    expect(list.ok && list.blocks.map((b) => `${b.type}${b.number}`).sort()).toEqual([
      'DB1',
      'OB1',
    ]);
  });

  it('nome proposto: modulo e data', () => {
    expect(
      suggestedBackupName(
        { orderNumber: 'X', moduleName: 'CPU 315-2 PN/DP' },
        new Date(2026, 9, 5, 8, 7),
      ),
    ).toBe('CPU_315-2_PN_DP_20261005-0807.baapbak');
  });
});
