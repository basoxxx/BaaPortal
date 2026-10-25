import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const electronApp = vi.hoisted(() => ({ isPackaged: false }));
vi.mock('electron', () => ({ app: electronApp }));
import { createHash } from 'node:crypto';
import { buildBlockFile, parseBlockFile } from '@baaportal/s7comm';
import { connectTestTcp, connectWriteTcp } from '@baaportal/s7comm/node';
import { FakeCpu, syntheticSdb } from '@baaportal/s7-server';
import { listen, type ListeningCpu } from '@baaportal/s7-server/node';
import { encodeBackup, type BackupManifest } from '@baaportal/project';
import type { PlcAccess } from '@baaportal/ui';
import type { ConfirmFn } from '../../src/main/plc/confirm';
import { PlcService } from '../../src/main/plc/plcService';
import {
  PlcWriteService,
  type PlcWriteOwner,
  type RestoreClient,
} from '../../src/main/plc/plcWrite';
import { planRestore, restoreLines } from '../../src/main/plc/restore';

class FakeOwner implements PlcWriteOwner {
  sent: { channel: string; payload: unknown }[] = [];
  private destroyed = false;
  private listeners = new Set<() => void>();
  isDestroyed(): boolean {
    return this.destroyed;
  }
  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload });
  }
  once(_e: 'destroyed', cb: () => void): void {
    this.listeners.add(cb);
  }
  removeListener(_e: 'destroyed', cb: () => void): void {
    this.listeners.delete(cb);
  }
  destroy(): void {
    this.destroyed = true;
    for (const cb of [...this.listeners]) cb();
  }
}

const T0 = { year: 2020, month: 5, day: 17, hour: 10, minute: 20, second: 30, ms: 0 };
type UserType = 'OB' | 'FB' | 'FC' | 'DB';
function userBlock(type: UserType, number: number, len = 20, seed = 2): Uint8Array {
  const mc7 = Uint8Array.from({ length: len }, (_, i) => (seed + i) & 0xff);
  return buildBlockFile(
    {
      type,
      number,
      language: 1,
      flags: 0x01,
      security: 0,
      codeTime: T0,
      interfaceTime: T0,
      ssbLength: 0,
      addLength: 0,
      localDataLength: 0,
      mc7Length: len,
    },
    mc7,
    { author: 'BAA', family: 'TEST', name: `${type}${number}`, version: '1.1', checksum: 0x1234 },
  );
}
const sdb = (n: number, len = 40): Uint8Array => syntheticSdb(n, len);

interface Entry {
  type: 'OB' | 'FB' | 'FC' | 'DB' | 'SDB';
  number: number;
  file: Uint8Array;
}
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

function backupOf(
  entries: Entry[],
  orderNumber: string,
): { manifest: BackupManifest; bytes: Uint8Array } {
  const manifest: BackupManifest = {
    format: 'baaportal-backup',
    version: 1,
    createdAt: '2026-10-25T10:00:00.000Z',
    app: 'test',
    cpu: { orderNumber, host: '192.0.2.10', port: 102, rack: 0, slot: 2 },
    mode: 'RUN',
    blocks: entries.map((e) => ({
      type: e.type,
      number: e.number,
      file: `blocks/${e.type}${e.number}.blk`,
      length: e.file.length,
      sha256: sha(e.file),
    })),
    failed: [],
  };
  const files = Object.fromEntries(entries.map((e) => [`blocks/${e.type}${e.number}.blk`, e.file]));
  return { manifest, bytes: encodeBackup(manifest, files) };
}

const names = (steps: ReturnType<typeof planRestore>): string[] =>
  typeof steps === 'string'
    ? [steps]
    : steps.steps.map((s) => `${s.kind === 'deleteSdb' ? 'del' : 'load'} ${s.type}${s.number}`);

describe('planRestore', () => {
  const blocks = (list: [Entry['type'], number][]): Entry[] =>
    list.map(([type, number]) => ({
      type,
      number,
      file: type === 'SDB' ? sdb(number) : userBlock(type, number),
    }));
  const plan = (backup: [Entry['type'], number][], cpu: [string, number][]) => {
    const { manifest } = backupOf(blocks(backup), 'X');
    const files = Object.fromEntries(
      blocks(backup).map((e) => [`blocks/${e.type}${e.number}.blk`, e.file]),
    );
    return planRestore(
      manifest,
      files,
      cpu.map(([type, number]) => ({ type, number })),
    );
  };

  it('ordine: _DELE degli SDB solo-CPU, SDB crescenti con 0 ultimo, DB, FC, FB, OB con OB1 ultimo', () => {
    const p = plan(
      [
        ['SDB', 0],
        ['SDB', 1],
        ['SDB', 2],
        ['SDB', 7],
        ['SDB', 1000],
        ['DB', 1],
        ['FC', 2],
        ['FB', 3],
        ['OB', 1],
        ['OB', 35],
      ],
      [
        ['SDB', 0],
        ['SDB', 1],
        ['SDB', 2],
        ['SDB', 4],
        ['SDB', 2000],
        ['FC', 9],
      ],
    );
    expect(names(p)).toEqual([
      'del SDB4',
      'del SDB2000',
      'load SDB1',
      'load SDB7',
      'load SDB1000',
      'load SDB0',
      'load DB1',
      'load FC2',
      'load FB3',
      'load OB35',
      'load OB1',
    ]);
    if (typeof p === 'string') throw new Error(p);
    expect(p.skipped).toEqual([{ type: 'SDB', number: 2, why: 'creato dalla CPU' }]);
    expect(p.cpuOnly).toEqual([{ type: 'FC', number: 9 }]);
    expect(restoreLines(p).slice(-1)).toEqual(['Restano nella CPU: FC 9']);
    expect(restoreLines(p)[0]).toBe('Cancella SDB 4');
    expect(restoreLines(p)).toContain('Carica SDB 7');
    expect(restoreLines(p)).toContain('Carica OB1');
  });

  it('SDB 998 sulla CPU e non nel backup → lasciato e segnalato', () => {
    const p = plan([['OB', 1]], [['SDB', 998]]);
    if (typeof p === 'string') throw new Error(p);
    expect(p.steps.map((s) => s.kind)).toEqual(['load']);
    expect(p.skipped).toEqual([
      { type: 'SDB', number: 998, why: 'fuori dagli intervalli documentati: lasciato sulla CPU' },
    ]);
  });

  it('SDB 500 nel backup → rifiuto', () => {
    expect(plan([['SDB', 500]], [])).toBe(
      'SDB 500 fuori dagli intervalli documentati: ripristino non possibile',
    );
  });

  it('file OB2 dichiarato OB1 nel manifest → rifiuto', () => {
    const e = blocks([['OB', 1]]);
    const { manifest } = backupOf(e, 'X');
    const files = { 'blocks/OB1.blk': userBlock('OB', 2) };
    const p = planRestore(manifest, files, []);
    expect(typeof p).toBe('string');
    expect(p).toMatch(/OB2.*OB1/);
  });
});

describe('ripristino contro il finto PLC', () => {
  let cpu: FakeCpu;
  let plc: ListeningCpu;
  let service: PlcService;
  let owner: FakeOwner;
  let confirm: ReturnType<typeof vi.fn<ConfirmFn>>;
  let writes: PlcWriteService;
  let backupBytes: Uint8Array;
  let order: string;
  let restoreOpened: number;
  let wrap: (c: RestoreClient) => RestoreClient;
  let deny: (title: string, message: string) => boolean;
  const access = (): PlcAccess => ({
    host: '127.0.0.1',
    port: plc.port,
    rack: 0,
    slot: 2,
    connectionType: 'PG',
  });
  const OB1_NEW = userBlock('OB', 1, 30, 9);
  const SDB0_NEW = sdb(0, 64);
  const SDB1_NEW = sdb(1, 48);

  const makeBackup = (cpuOrder = order): void => {
    backupBytes = backupOf(
      [
        { type: 'SDB', number: 0, file: SDB0_NEW },
        { type: 'SDB', number: 1, file: SDB1_NEW },
        { type: 'OB', number: 1, file: OB1_NEW },
      ],
      cpuOrder,
    ).bytes;
  };

  beforeEach(async () => {
    cpu = new FakeCpu({ mode: 'RUN' });
    cpu.addBlock(userBlock('OB', 1, 20, 2));
    cpu.addBlock(sdb(0, 32));
    cpu.addBlock(sdb(1, 32));
    cpu.addBlock(sdb(2, 32));
    plc = await listen(cpu, { port: 0 });
    service = new PlcService({ intervalMs: 1000 });
    owner = new FakeOwner();
    deny = () => false;
    confirm = vi.fn<ConfirmFn>(async (_o, t) => !deny(t.title, t.message));
    restoreOpened = 0;
    wrap = (c) => c;
    writes = new PlcWriteService({
      service,
      confirm,
      sleep: async () => undefined,
      restoreConnect: async (o) => {
        restoreOpened++;
        return wrap((await connectWriteTcp(o, 'online-restore')) as RestoreClient);
      },
      restoreFile: {
        pick: async () => 'prova.baapbak',
        size: async () => backupBytes.length,
        read: async () => backupBytes,
      },
    });
    const r = await service.connect(owner, access());
    if (!r.ok) throw new Error(r.error);
    order = r.identity.orderNumber;
    makeBackup();
  });
  afterEach(async () => {
    await service.closeAll();
    await plc.close();
  });

  const plan = async () => {
    const p = await writes.restorePlan(owner);
    if (!p.ok) throw new Error(JSON.stringify(p));
    return p;
  };

  it('restorePlan: FRCE acceso → rifiuto prima di ogni conferma', async () => {
    cpu.forceActive = true;
    const p = await writes.restorePlan(owner);
    expect(p).toEqual({
      ok: false,
      error: 'Forzamento attivo sulla CPU: terminarlo con TIA o STEP 7 prima del ripristino',
    });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('restorePlan: numero d’ordine diverso → cpuMismatch; righe costruite dal main', async () => {
    makeBackup('6ES7 999-9XX99-0XX0');
    const p = await plan();
    expect(p.cpuMismatch).toEqual({ backup: '6ES7 999-9XX99-0XX0', online: order });
    expect(p.rows.map((r) => `${r.action} ${r.name}`)).toEqual([
      'load SDB 1',
      'load SDB 0',
      'load OB1',
    ]);
  });

  it('restorePlan: file di backup non valido → errore, nessuna conferma', async () => {
    backupBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const p = await writes.restorePlan(owner);
    expect(p).toMatchObject({ ok: false });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('restore: Annulla alla conferma della CPU diversa → nessun collegamento', async () => {
    makeBackup('6ES7 999-9XX99-0XX0');
    const p = await plan();
    deny = (title, message) => message.includes('CPU diversa');
    const r = await writes.restore(owner, { token: p.token, restart: false });
    expect(r).toMatchObject({ ok: false, cancelled: true, cpuStopped: false });
    expect(restoreOpened).toBe(0);
    expect(cpu.mode).toBe('RUN');
  });

  it('restore: un job 0x13 di un altro → rifiuto, CPU non arrestata', async () => {
    const other = await connectTestTcp({
      host: '127.0.0.1',
      port: plc.port,
      rack: 0,
      slot: 2,
      timeoutMs: 2000,
    });
    await other.createBlockStatus(
      { type: 'OB', number: 1, initMask: 3, lines: [{ offset: 0, mask: 3 }] },
      4,
    );
    const p = await plan();
    const r = await writes.restore(owner, { token: p.token, restart: false });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Una funzione di test attiva impedisce');
    expect(r.cpuStopped).toBe(false);
    expect(cpu.mode).toBe('RUN');
    await other.close();
  });

  it('restore: SDB 0 e 1 e OB1 caricati, CPU in STOP, blocchi identici al backup; testo con «FUNZIONE SPERIMENTALE»', async () => {
    const p = await plan();
    const r = await writes.restore(owner, { token: p.token, restart: false });
    expect(r.ok).toBe(true);
    expect(r.rows.map((x) => `${x.name}:${x.outcome}`)).toEqual([
      'SDB 1:loaded',
      'SDB 0:loaded',
      'OB1:loaded',
    ]);
    expect(r.cpuStopped).toBe(true);
    expect(cpu.mode).toBe('STOP');
    expect(cpu.block('SDB', 0)!.file).toEqual(SDB0_NEW);
    expect(cpu.block('SDB', 1)!.file).toEqual(SDB1_NEW);
    expect(cpu.block('OB', 1)!.file).toEqual(OB1_NEW);
    expect(cpu.block('SDB', 2)).toBeDefined(); // SDB 2 non si tocca
    const main = confirm.mock.calls.find(
      (c) => c[1].confirmLabel === 'Ripristina backup (sperimentale)',
    )!;
    expect(main[1].detail).toContain('FUNZIONE SPERIMENTALE');
    expect(main[1].detail).toContain('Carica SDB 1\nCarica SDB 0\nCarica OB1');
    expect(main[1].message).toContain('127.0.0.1');
    expect(confirm.mock.calls.map((c) => c[1].message)).toContain('Portare la CPU in STOP?');
    expect(owner.sent.filter((s) => s.channel === 'plc:writeProgress')).not.toHaveLength(0);
    // il blocco ricaricato si legge dalla CPU
    expect(parseBlockFile(cpu.block('SDB', 0)!.file).header.number).toBe(0);
  });

  it('restore con restart e conferma → RUN; con conferma negata → resta in STOP, cpuStopped true', async () => {
    let p = await plan();
    const r = await writes.restore(owner, { token: p.token, restart: true });
    expect(r).toMatchObject({ ok: true, restarted: true, cpuStopped: false });
    expect(cpu.mode).toBe('RUN');

    p = await plan();
    deny = (_t, m) => m.startsWith('Avviare la CPU');
    const r2 = await writes.restore(owner, { token: p.token, restart: true });
    expect(r2).toMatchObject({ ok: true, restarted: false, cpuStopped: true });
    expect(cpu.mode).toBe('STOP');
  });

  it('collegamento chiuso durante SDB 1 → SDB 1 unknown, i seguenti notDone, cpuStopped true', async () => {
    wrap = (c) => {
      const orig = c.downloadBlock.bind(c);
      c.downloadBlock = async (file, opts) => {
        await c.close();
        return orig(file, opts);
      };
      return c;
    };
    const p = await plan();
    const r = await writes.restore(owner, { token: p.token, restart: false });
    expect(r.ok).toBe(false);
    expect(r.rows.map((x) => `${x.name}:${x.outcome}`)).toEqual([
      'SDB 1:unknown',
      'SDB 0:notDone',
      'OB1:notDone',
    ]);
    expect(r.cpuStopped).toBe(true);
  });

  it('interrupt durante il ripristino → si ferma prima del passo successivo', async () => {
    wrap = (c) => {
      const orig = c.downloadBlock.bind(c);
      c.downloadBlock = async (file, opts) => {
        await orig(file, opts);
        writes.interrupt(owner);
      };
      return c;
    };
    const p = await plan();
    const r = await writes.restore(owner, { token: p.token, restart: false });
    expect(r.ok).toBe(false);
    expect(r.rows.map((x) => x.outcome)).toEqual(['loaded', 'notDone', 'notDone']);
    expect(cpu.block('SDB', 0)!.file).not.toEqual(SDB0_NEW);
  });

  it('token di un collegamento precedente o già usato → errore senza conferma', async () => {
    const p = await plan();
    await service.disconnect(owner);
    await service.connect(owner, access());
    const before = confirm.mock.calls.length;
    const r = await writes.restore(owner, { token: p.token, restart: false });
    expect(r.ok).toBe(false);
    expect(confirm.mock.calls.length).toBe(before);

    const p2 = await plan();
    expect((await writes.restore(owner, { token: p2.token, restart: false })).ok).toBe(true);
    const again = await writes.restore(owner, { token: p2.token, restart: false });
    expect(again.ok).toBe(false);
    expect(again.error).toContain('già usato');
  });

  it('l’osservazione attiva sulla stessa CPU si ferma prima del ripristino', async () => {
    const order: string[] = [];
    writes.beforeRestore = async () => void order.push('stop');
    const orig = confirm.getMockImplementation()!;
    confirm.mockImplementation(async (o, t) => {
      order.push('confirm');
      return orig(o, t);
    });
    const p = await plan();
    await writes.restore(owner, { token: p.token, restart: false });
    expect(order[0]).toBe('stop');
  });

  it('un riavvio con 0xD2A9 sul primo _INSE ritenta (busyRetry) e il ripristino riesce', async () => {
    await plc.close();
    cpu = new FakeCpu({ mode: 'RUN', faults: { insertBusy: 2 } });
    cpu.addBlock(sdb(0, 32));
    cpu.addBlock(sdb(1, 32));
    cpu.addBlock(userBlock('OB', 1, 20, 2));
    plc = await listen(cpu, { port: 0 });
    await service.disconnect(owner);
    await service.connect(owner, access());
    const p = await plan();
    const r = await writes.restore(owner, { token: p.token, restart: false });
    expect(r.ok).toBe(true);
    expect(cpu.block('SDB', 1)!.file).toEqual(SDB1_NEW);
  });
});
