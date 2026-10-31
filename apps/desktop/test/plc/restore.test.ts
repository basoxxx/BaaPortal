import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished as afterTest,
  vi,
} from 'vitest';
const electronApp = vi.hoisted(() => ({ isPackaged: false }));
vi.mock('electron', () => ({ app: electronApp }));
import { createHash } from 'node:crypto';
import { buildBlockFile, parseBlockFile, S7Error } from '@baaportal/s7comm';
import { connectTestTcp, connectWriteTcp } from '@baaportal/s7comm/node';
import { FakeCpu, syntheticSdb } from '@baaportal/s7-server';
import { listen, type ListeningCpu } from '@baaportal/s7-server/node';
import { encodeBackup, type BackupManifest } from '@baaportal/project';
import type { PlcAccess } from '@baaportal/ui';
import type { ConfirmFn } from '../../src/main/plc/confirm';
import { setDialogLang } from '../../src/main/plc/dialogText';
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

  const withFailed = (
    failed: BackupManifest['failed'],
    backup: [Entry['type'], number][],
    cpu: [string, number][],
  ) => {
    const es = blocks(backup);
    const { manifest } = backupOf(es, 'X');
    manifest.failed = failed;
    const files = Object.fromEntries(es.map((e) => [`blocks/${e.type}${e.number}.blk`, e.file]));
    return planRestore(
      manifest,
      files,
      cpu.map(([type, number]) => ({ type, number })),
    );
  };

  it('SDB non letto durante il backup (failed) → rifiuto, nessun _DELE', () => {
    const p = withFailed(
      [{ type: 'SDB', number: 1000, error: 'x' }],
      [['SDB', 0]],
      [
        ['SDB', 0],
        ['SDB', 1000],
      ],
    );
    expect(p).toMatch(/SDB 1000 non letto durante il backup/);
  });

  it('qualunque blocco in failed → rifiuto che nomina i blocchi', () => {
    const p = withFailed(
      [
        { type: 'DB', number: 5, error: 'x' },
        { type: 'FC', number: 7, error: 'y' },
      ],
      [['OB', 1]],
      [],
    );
    expect(p).toMatch(/Backup incompleto/);
    expect(p).toContain('DB5');
    expect(p).toContain('FC7');
  });

  it('la CPU ha SDB 0 e il backup no → rifiuto', () => {
    const p = plan([['SDB', 1]], [['SDB', 0]]);
    expect(p).toMatch(/SDB 0/);
    expect(typeof p).toBe('string');
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

  it('restorePlan: numero d’ordine diverso → rifiuto (§19.5.0), nessuna conferma; righe dal main', async () => {
    makeBackup('6ES7 999-9XX99-0XX0');
    const p = await writes.restorePlan(owner);
    expect(p).toMatchObject({ ok: false });
    expect((p as { error: string }).error).toContain('tipo diverso');
    expect(confirm).not.toHaveBeenCalled();
    expect(writes.pendingPlans()).toBe(0);
    expect(restoreOpened).toBe(0);
    makeBackup();
    const ok = await plan();
    expect(ok.rows.map((r) => `${r.action} ${r.name}`)).toEqual([
      'load SDB 1',
      'load SDB 0',
      'load OB1',
      'skip SDB 2',
    ]);
  });

  it('restorePlan: protezione di livello 2 o 3 → rifiuto prima di ogni conferma', async () => {
    for (const level of [2, 3] as const) {
      cpu.config.protectionLevel = level;
      const p = await writes.restorePlan(owner);
      expect(p, `livello ${level}`).toMatchObject({ ok: false });
      expect(confirm).not.toHaveBeenCalled();
    }
    cpu.config.protectionLevel = 2;
    expect(await writes.restorePlan(owner)).toMatchObject({
      error: expect.stringContaining('protezione'),
    });
  });

  it('restore: finché dura conta come lavoro sul PLC (restoring), poi no', async () => {
    const p = await plan();
    expect(writes.restoring()).toBe(false);
    const seen: boolean[] = [];
    deny = () => {
      seen.push(writes.restoring());
      return true; // rifiuta la prima conferma: il ripristino finisce lì
    };
    await writes.restore(owner, { token: p.token, restart: false });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
    expect(writes.restoring()).toBe(false);
  });

  it('restore: protezione alzata dopo il piano → rifiuto sul collegamento del ripristino, CPU in RUN', async () => {
    const p = await plan();
    cpu.config.protectionLevel = 2;
    const r = await writes.restore(owner, { token: p.token, restart: false });
    expect(r).toMatchObject({ ok: false, cpuStopped: false });
    expect(r.error).toContain('protezione');
    expect(cpu.mode).toBe('RUN');
    expect(r.rows.every((x) => x.outcome !== 'loaded')).toBe(true);
  });

  it('restore: FRCE acceso dopo il piano → rifiuto, CPU in RUN', async () => {
    const p = await plan();
    cpu.forceActive = true;
    const r = await writes.restore(owner, { token: p.token, restart: false });
    expect(r).toMatchObject({ ok: false, cpuStopped: false });
    expect(r.error).toContain('Forzamento attivo');
    expect(cpu.mode).toBe('RUN');
  });

  it('restore: FRCE illeggibile sul collegamento del ripristino → rifiuto', async () => {
    wrap = (c) => {
      const orig = c.readSzl.bind(c);
      c.readSzl = async (id, idx) => {
        if (id === 0x0174) throw new S7Error('CPU_ERROR', 'non disponibile');
        return orig(id, idx);
      };
      return c;
    };
    const p = await plan();
    const r = await writes.restore(owner, { token: p.token, restart: false });
    expect(r).toMatchObject({ ok: false, cpuStopped: false });
    expect(r.error).toContain('forzamento non leggibile');
    expect(cpu.mode).toBe('RUN');
  });

  it('restore: CPU in HOLD → rifiuto, nessun STOP', async () => {
    const p = await plan();
    cpu.setMode('HOLD');
    const r = await writes.restore(owner, { token: p.token, restart: false });
    expect(r).toMatchObject({ ok: false, cpuStopped: false });
    expect(r.error).toContain('HOLD');
    expect(confirm.mock.calls.map((c) => c[1].message)).not.toContain('Portare la CPU in STOP?');
  });

  it('restore: un job nato dopo lo STOP → rifiuto con la CPU in STOP, niente scritto', async () => {
    // la CPU di prova non ammette job in STOP: la seconda lettura ne mostra uno di un altro PG
    wrap = (c) => {
      const list = c.readJobList.bind(c);
      let calls = 0;
      c.readJobList = async () => (++calls === 1 ? list() : [{ fn: 0x13, job: 1 }]);
      return c;
    };
    const p = await plan();
    const r = await writes.restore(owner, { token: p.token, restart: false });
    expect(r).toMatchObject({ ok: false, cpuStopped: true });
    expect(r.error).toContain('Una funzione di test attiva impedisce');
    expect(r.error).toContain('rimasta in STOP');
    expect(cpu.mode).toBe('STOP');
    expect(r.rows.filter((x) => x.outcome === 'loaded' || x.outcome === 'deleted')).toEqual([]);
    expect(cpu.block('SDB', 0)!.file).not.toEqual(SDB0_NEW);
  });

  it('restore: STOP non confermato entro il tempo → stopUnconfirmed, cpuStopped false, niente scritto', async () => {
    wrap = (c) => {
      c.stop = async () => ({ name: 'ok' }) as never; // il comando "parte" ma la CPU non si ferma
      return c;
    };
    const p = await plan();
    const r = await writes.restore(owner, { token: p.token, restart: false });
    expect(r).toMatchObject({ ok: false, cpuStopped: false, stopUnconfirmed: true });
    expect(r.error).toContain('non confermato');
    expect(cpu.mode).toBe('RUN');
    expect(r.rows.every((x) => x.outcome === 'notDone' || x.outcome === 'skipped')).toBe(true);
  });

  it('restore: riavvio che lascia la CPU in STOP → restarted false, cpuStopped true, diag letta', async () => {
    wrap = (c) => {
      c.start = async () => ({ name: 'ok' }) as never; // l'avviamento non porta in RUN
      return c;
    };
    const p = await plan();
    const r = await writes.restore(owner, { token: p.token, restart: true });
    expect(r).toMatchObject({ ok: true, restarted: false, cpuStopped: true });
    expect(r.diag).toBeDefined();
    expect(cpu.mode).toBe('STOP');
  });

  it('restore: blocco caricato che poi non risulta nella CPU → ok false, motivo specifico, niente «completato»', async () => {
    wrap = (c) => {
      const close = c.close.bind(c);
      c.close = async () => {
        cpu.deleteBlock('OB', 1); // sparisce prima della rilettura dell'elenco
        return close();
      };
      return c;
    };
    const p = await plan();
    const r = await writes.restore(owner, { token: p.token, restart: false });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('OB1');
    expect(r.error).toContain('non risulta nella CPU');
    const row = r.rows.find((x) => x.name === 'OB1')!;
    expect(row.outcome).toBe('unknown');
    expect(row.error).toContain('non risulta nella CPU');
  });

  it('restore: SDB cambiati dopo la preparazione → rifiuto dopo lo STOP, niente scritto', async () => {
    const p = await plan();
    cpu.addBlock(sdb(5, 32)); // un altro PG aggiunge un SDB
    const r = await writes.restore(owner, { token: p.token, restart: false });
    expect(r).toMatchObject({ ok: false, cpuStopped: true });
    expect(r.error).toContain('SDB della CPU sono cambiati');
    expect(r.error).toContain('nulla è stato scritto');
    expect(cpu.mode).toBe('STOP');
    expect(r.rows.filter((x) => x.outcome === 'loaded' || x.outcome === 'deleted')).toEqual([]);
    expect(cpu.block('SDB', 0)!.file).not.toEqual(SDB0_NEW);
  });

  it('restore: errore di trasporto nel comando di avvio → stato della CPU sconosciuto, non «in STOP»', async () => {
    wrap = (c) => {
      c.start = async () => {
        throw new S7Error('CLOSED', 'collegamento chiuso');
      };
      return c;
    };
    const p = await plan();
    const r = await writes.restore(owner, { token: p.token, restart: true });
    expect(r.ok).toBe(false);
    expect(r.cpuStopped).toBe(false);
    expect(r.restarted).toBe(false);
    expect(r.error).toContain('sconosciuto');
    expect(r.error).toContain('non è noto');
  });

  it('restore: errore del filtro → «Rifiutato da BaaPortal (frame non ammesso)»; errore della CPU → «dalla CPU»', async () => {
    // anche in inglese le righe restano in italiano: le traduce il renderer (plcRestore.ts)
    setDialogLang('en');
    afterTest(() => setDialogLang('it'));
    for (const [code, want] of [
      ['FORBIDDEN', 'Rifiutato da BaaPortal (frame non ammesso)'],
      ['CPU_ERROR', 'Rifiutato dalla CPU'],
    ] as const) {
      wrap = (c) => {
        c.downloadBlock = async () => {
          throw new S7Error(code, 'x');
        };
        return c;
      };
      const p = await plan();
      const r = await writes.restore(owner, { token: p.token, restart: false });
      expect(r.rows[0]).toMatchObject({ outcome: 'rejected' });
      expect(r.rows[0]!.error).toContain(want);
      if (code === 'FORBIDDEN') expect(r.rows[0]!.error).not.toContain('dalla CPU');
    }
  });

  it('la conferma nativa elenca gli SDB non toccati: SDB 2 e quelli lasciati sulla CPU', async () => {
    cpu.addBlock(sdb(998, 32));
    const p = await plan();
    await writes.restore(owner, { token: p.token, restart: false });
    const main = confirm.mock.calls.find(
      (c) => c[1].confirmLabel === 'Ripristina backup (sperimentale)',
    )!;
    expect(main[1].detail).toContain('Non toccato: SDB 2 (creato dalla CPU)');
    expect(main[1].detail).toContain('Non toccato: SDB 998 (fuori dagli intervalli documentati');
  });

  it('piani in memoria: nuova preparazione, finestra chiusa e collegamento finito li liberano', async () => {
    await plan();
    await plan();
    expect(writes.pendingPlans()).toBe(1); // il secondo sostituisce il primo
    await service.disconnect(owner);
    expect(writes.pendingPlans()).toBe(0); // collegamento finito
    await service.connect(owner, access());
    await plan();
    expect(writes.pendingPlans()).toBe(1);
    owner.destroy();
    expect(writes.pendingPlans()).toBe(0); // finestra chiusa
  });

  it('abortAll durante il ripristino → si ferma prima del passo successivo e aspetta la chiusura', async () => {
    let aborting: Promise<void> | undefined;
    wrap = (c) => {
      const orig = c.downloadBlock.bind(c);
      c.downloadBlock = async (file, opts) => {
        await orig(file, opts);
        aborting ??= writes.abortAll();
      };
      return c;
    };
    const p = await plan();
    const r = await writes.restore(owner, { token: p.token, restart: false });
    await aborting;
    expect(r.ok).toBe(false);
    expect(r.rows.map((x) => x.outcome)).toEqual(['loaded', 'notDone', 'notDone', 'skipped']);
    expect(r.error).toContain('Interrotto');
    // dopo l'uscita dall'app nessun altro ripristino parte
    const p2 = await writes.restorePlan(owner);
    if (p2.ok) {
      expect(await writes.restore(owner, { token: p2.token, restart: false })).toMatchObject({
        ok: false,
        error: expect.stringContaining('Chiusura in corso'),
      });
    }
  });

  it('restorePlan: file di backup non valido → errore, nessuna conferma', async () => {
    backupBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const p = await writes.restorePlan(owner);
    expect(p).toMatchObject({ ok: false });
    expect(confirm).not.toHaveBeenCalled();
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
      'SDB 2:skipped',
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
      'SDB 2:skipped',
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
    expect(r.rows.map((x) => x.outcome)).toEqual(['loaded', 'notDone', 'notDone', 'skipped']);
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

  it('durante il ripristino la CPU è «in ripristino» (le osservazioni si rifiutano), poi si libera', async () => {
    const p = await plan();
    expect(writes.restoringOn(access())).toBe(false);
    const seen: boolean[] = [];
    const orig = confirm.getMockImplementation()!;
    confirm.mockImplementation(async (o, t) => {
      seen.push(writes.restoringOn(access()));
      return orig(o, t);
    });
    await writes.restore(owner, { token: p.token, restart: false });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
    expect(writes.restoringOn(access())).toBe(false);
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
