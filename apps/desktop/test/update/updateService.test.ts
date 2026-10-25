import { describe, expect, it, vi } from 'vitest';
import { UpdateService, type UpdateServiceDeps } from '../../src/main/update/updateService';
import type { UpdaterPort } from '../../src/main/update/updaterPort';
import type { UpdateEvent } from '../../src/shared/updateTypes';

const SEC = 1000;
const HOUR = 3600 * SEC;
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** Orologio finto: i temporizzatori scattano solo con `advance`. */
class Clock {
  t = 0;
  private next = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();
  setTimeout = (fn: () => void, ms: number): number => {
    const id = this.next++;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  };
  clearTimeout = (id: unknown): void => {
    this.timers.delete(id as number);
  };
  now = (): number => this.t;
  get pending(): number {
    return this.timers.size;
  }
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, v]) => v.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = due[1].at;
      due[1].fn();
      await flush();
    }
    this.t = end;
    await flush();
  }
}

class FakeUpdater {
  allowPrerelease = false;
  allowDowngrade = true;
  autoDownload = true;
  autoInstallOnAppQuit = false;
  logger = null;
  version = '0.12.1';
  checks = 0;
  checkImpl: (() => Promise<unknown>) | null = null;
  downloads = 0;
  quits: [boolean | undefined, boolean | undefined][] = [];
  order: string[] = [];
  private cbs = new Map<string, (a: never) => void>();
  checkForUpdates = vi.fn(async () => {
    this.checks++;
    if (this.checkImpl) await this.checkImpl();
    return { updateInfo: { version: this.version, files: [] } };
  });
  downloadUpdate = vi.fn((token?: unknown) => {
    this.downloads++;
    return new Promise<unknown>((resolve, reject) => {
      this.finish = () => resolve(['x']);
      this.token = token as FakeToken;
      this.token.onCancel = () => reject(new Error('cancelled'));
    });
  });
  finish: () => void = () => undefined;
  token!: FakeToken;
  quitAndInstall = vi.fn((silent?: boolean, run?: boolean) => {
    this.quits.push([silent, run]);
    this.order.push('quit');
  });
  on(event: string, cb: (a: never) => void): this {
    this.cbs.set(event, cb);
    return this;
  }
  emit(event: string, arg: unknown): void {
    this.cbs.get(event)?.(arg as never);
  }
}

class FakeToken {
  onCancel: () => void = () => undefined;
  cancel(): void {
    this.onCancel();
  }
}

function make(over: Partial<UpdateServiceDeps> = {}) {
  const clock = new Clock();
  const updater = new FakeUpdater();
  const events: UpdateEvent[] = [];
  const opened: string[] = [];
  let busy = false;
  const closeOnline = vi.fn(async () => {
    updater.order.push('close');
  });
  const prepareQuit = vi.fn(() => {
    updater.order.push('prepare');
  });
  const cancelQuit = vi.fn();
  const deps: UpdateServiceDeps = {
    updater: async () => updater as unknown as UpdaterPort,
    newToken: async () => new FakeToken(),
    platform: 'win32',
    arch: 'x64',
    prereleaseBuild: false,
    current: '0.12.0',
    busy: () => busy,
    closeOnline,
    prepareQuit,
    cancelQuit,
    send: (e) => events.push(e),
    openExternal: async (u) => {
      opened.push(u);
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    ...over,
  };
  const svc = new UpdateService(deps);
  return {
    svc,
    clock,
    updater,
    events,
    opened,
    closeOnline,
    prepareQuit,
    cancelQuit,
    setBusy: (b: boolean) => {
      busy = b;
    },
  };
}

const PREFS_ON = { checkOnStartup: true, prerelease: null };
const types = (ev: UpdateEvent[]) => ev.map((e) => e.type);

describe('controllo: esito e regole', () => {
  it('downgrade rifiutato: nessun available, solo none a mano', async () => {
    const m = make({ prereleaseBuild: true, current: '0.12.0' });
    m.updater.version = '0.11.0';
    await m.svc.check();
    expect(types(m.events)).toEqual(['checking', 'none']);
    expect(m.events[1]).toEqual({ type: 'none', manual: true });
  });

  it('ogni controllo imposta allowDowngrade e autoDownload falsi', async () => {
    const m = make();
    await m.svc.check();
    expect(m.updater.allowDowngrade).toBe(false);
    expect(m.updater.autoDownload).toBe(false);
    expect(m.updater.autoInstallOnAppQuit).toBe(true);
  });

  it('allowPrerelease: build stabile senza casella false, con casella true', async () => {
    const m = make();
    await m.svc.check();
    expect(m.updater.allowPrerelease).toBe(false);
    await m.svc.setPrefs({ checkOnStartup: false, prerelease: true });
    await m.svc.check();
    expect(m.updater.allowPrerelease).toBe(true);
  });

  it('cambiare prerelease non avvia un controllo', async () => {
    const m = make();
    await m.svc.setPrefs({ checkOnStartup: false, prerelease: true });
    await m.svc.setPrefs({ checkOnStartup: false, prerelease: false });
    await m.clock.advance(10 * HOUR);
    expect(m.updater.checks).toBe(0);
  });

  it('nuova versione: available con il flag manual', async () => {
    const m = make();
    await m.svc.check();
    expect(m.events).toContainEqual({ type: 'available', version: '0.12.1', manual: true });
  });
});

describe('pianificazione', () => {
  it('nessun controllo prima di update:prefs; poi 10 s e 6 h dopo la fine del primo', async () => {
    const m = make();
    await m.clock.advance(HOUR);
    expect(m.updater.checks).toBe(0);
    await m.svc.setPrefs(PREFS_ON);
    await m.clock.advance(9 * SEC);
    expect(m.updater.checks).toBe(0);
    await m.clock.advance(1 * SEC);
    expect(m.updater.checks).toBe(1);
    await m.clock.advance(6 * HOUR - SEC);
    expect(m.updater.checks).toBe(1);
    await m.clock.advance(SEC);
    expect(m.updater.checks).toBe(2);
  });

  it('checkOnStartup falso: nessun controllo automatico; quello a mano funziona', async () => {
    const m = make();
    await m.svc.setPrefs({ checkOnStartup: false, prerelease: null });
    await m.clock.advance(24 * HOUR);
    expect(m.updater.checks).toBe(0);
    await m.svc.check();
    expect(m.updater.checks).toBe(1);
  });

  it('spegnere toglie il temporizzatore, riaccendere ne pianifica uno a 10 s', async () => {
    const m = make();
    await m.svc.setPrefs(PREFS_ON);
    await m.svc.setPrefs({ checkOnStartup: false, prerelease: null });
    expect(m.clock.pending).toBe(0);
    await m.svc.setPrefs(PREFS_ON);
    await m.clock.advance(10 * SEC);
    expect(m.updater.checks).toBe(1);
  });

  it('durante lo scaricamento o con un aggiornamento scaricato i controlli automatici non partono', async () => {
    const m = make();
    await m.svc.setPrefs(PREFS_ON);
    await m.clock.advance(10 * SEC);
    expect(m.updater.checks).toBe(1);
    await m.svc.download();
    await m.clock.advance(7 * HOUR);
    expect(m.updater.checks).toBe(1);
    m.updater.emit('update-downloaded', { version: '0.12.1' });
    await m.clock.advance(12 * HOUR);
    expect(m.updater.checks).toBe(1);
  });

  it('un controllo a mano durante uno automatico: un solo checkForUpdates, esito mostrato', async () => {
    const m = make();
    let release!: () => void;
    m.updater.checkImpl = () => new Promise<void>((r) => (release = r));
    await m.svc.setPrefs(PREFS_ON);
    await m.clock.advance(10 * SEC);
    expect(m.updater.checks).toBe(1);
    const manual = m.svc.check();
    release();
    await manual;
    expect(m.updater.checks).toBe(1);
    expect(m.events).toContainEqual({ type: 'available', version: '0.12.1', manual: true });
  });
});

describe('errori', () => {
  it('rete assente: nessun evento nel controllo automatico, error in quello a mano', async () => {
    const m = make();
    m.updater.checkImpl = async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' });
    };
    await m.svc.setPrefs(PREFS_ON);
    await m.clock.advance(10 * SEC);
    expect(m.events.filter((e) => e.type === 'error')).toEqual([]);
    await m.svc.check();
    expect(m.events.find((e) => e.type === 'error')).toMatchObject({
      type: 'error',
      phase: 'check',
      manual: true,
    });
  });

  it('403 di GitHub a mano: messaggio italiano', async () => {
    const m = make();
    m.updater.checkImpl = async () => {
      throw Object.assign(new Error('HTTP 403'), { statusCode: 403 });
    };
    await m.svc.check();
    expect(m.events.find((e) => e.type === 'error')).toMatchObject({
      message: 'GitHub ha limitato le richieste: riprova più tardi',
    });
  });

  it('errore di scaricamento: sempre inviato', async () => {
    const m = make();
    await m.svc.check();
    m.updater.downloadUpdate.mockRejectedValueOnce(new Error('sha512 checksum mismatch'));
    await m.svc.download();
    await flush();
    expect(m.events.find((e) => e.type === 'error')).toMatchObject({
      phase: 'download',
      manual: false,
    });
  });
});

describe('stato scaricato e controlli successivi', () => {
  it('un controllo a mano dopo lo scaricamento non sovrascrive downloaded', async () => {
    const m = make();
    await m.svc.check();
    await m.svc.download();
    m.updater.emit('update-downloaded', { version: '0.12.1' });
    m.updater.version = '0.12.2';
    await m.svc.check();
    expect(m.svc.state()).toEqual({ type: 'downloaded', version: '0.12.1' });
    expect(m.events.filter((e) => e.type === 'available')).toHaveLength(1);
  });

  it("update-downloaded di un'altra versione è ignorato", async () => {
    const m = make();
    await m.svc.check();
    await m.svc.download();
    m.updater.emit('update-downloaded', { version: '0.13.0' });
    expect(m.svc.canInstall()).toEqual({ ok: false, reason: 'notReady' });
  });

  it('download chiamato due volte di fila: un solo downloadUpdate', async () => {
    const m = make();
    await m.svc.check();
    await Promise.all([m.svc.download(), m.svc.download()]);
    expect(m.updater.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('un controllo a mano che si unisce a uno automatico emette checking manual', async () => {
    const m = make();
    let release!: () => void;
    m.updater.checkImpl = () => new Promise<void>((r) => (release = r));
    await m.svc.setPrefs(PREFS_ON);
    await m.clock.advance(10 * SEC);
    const p = m.svc.check();
    release();
    await p;
    expect(m.events.filter((e) => e.type === 'checking')).toEqual([
      { type: 'checking', manual: false },
      { type: 'checking', manual: true },
    ]);
  });
});

describe('«Più tardi»', () => {
  it('versioni non semver sono ignorate', () => {
    const m = make();
    m.svc.later('x');
    m.svc.later(5 as unknown as string);
  });

  it('il controllo automatico dopo non avvisa; quello a mano sì', async () => {
    const m = make();
    m.svc.later('0.12.1');
    await m.svc.setPrefs(PREFS_ON);
    await m.clock.advance(10 * SEC);
    expect(m.events.filter((e) => e.type === 'available')).toEqual([]);
    await m.svc.check();
    expect(m.events.filter((e) => e.type === 'available')).toHaveLength(1);
  });
});

describe('scaricamento', () => {
  it('progresso (al massimo ogni 250 ms) e downloaded', async () => {
    const m = make();
    await m.svc.check();
    await m.svc.download();
    m.updater.emit('download-progress', { transferred: 10, total: 100 });
    m.updater.emit('download-progress', { transferred: 20, total: 100 });
    m.clock.t += 300;
    m.updater.emit('download-progress', { transferred: 30, total: 100 });
    m.updater.emit('update-downloaded', { version: '0.12.1' });
    const prog = m.events.filter((e) => e.type === 'progress');
    expect(prog).toEqual([
      { type: 'progress', transferred: 10, total: 100 },
      { type: 'progress', transferred: 30, total: 100 },
    ]);
    expect(m.events.at(-1)).toEqual({ type: 'downloaded', version: '0.12.1' });
  });

  it('annulla dà cancelled', async () => {
    const m = make();
    await m.svc.check();
    await m.svc.download();
    m.svc.cancelDownload();
    await flush();
    expect(m.events.at(-1)).toEqual({ type: 'cancelled' });
    expect(m.events.some((e) => e.type === 'error')).toBe(false);
  });

  it("state() restituisce l'ultimo evento significativo", async () => {
    const m = make();
    expect(m.svc.state()).toBeNull();
    await m.svc.check();
    expect(m.svc.state()).toEqual({ type: 'available', version: '0.12.1', manual: true });
  });
});

describe('installazione', () => {
  async function ready() {
    const m = make();
    await m.svc.check();
    await m.svc.download();
    m.updater.emit('update-downloaded', { version: '0.12.1' });
    return m;
  }

  it('canInstall: senza scaricamento notReady; con scrittura o backup in corso busy', async () => {
    const m = make();
    expect(m.svc.canInstall()).toEqual({ ok: false, reason: 'notReady' });
    const r = await ready();
    expect(r.svc.canInstall()).toEqual({ ok: true });
    r.setBusy(true);
    expect(r.svc.canInstall()).toEqual({ ok: false, reason: 'busy' });
  });

  it('busy diventato vero fra canInstall e install: nessun quitAndInstall', async () => {
    const m = await ready();
    expect(m.svc.canInstall()).toEqual({ ok: true });
    m.setBusy(true);
    expect(await m.svc.install()).toEqual({ ok: false, reason: 'busy' });
    expect(m.updater.quitAndInstall).not.toHaveBeenCalled();
    expect(m.closeOnline).not.toHaveBeenCalled();
  });

  it("closeOnline, prepareQuit e quitAndInstall(false, true) in quest'ordine", async () => {
    const m = await ready();
    await m.svc.install();
    expect(m.updater.order).toEqual(['close', 'prepare', 'quit']);
    expect(m.updater.quits).toEqual([[false, true]]);
  });

  it('closeOnline che non risponde: dopo 1 s si installa lo stesso', async () => {
    const hung = vi.fn(() => new Promise<void>(() => undefined));
    const m2 = make({ closeOnline: hung });
    await m2.svc.check();
    await m2.svc.download();
    m2.updater.emit('update-downloaded', { version: '0.12.1' });
    const p = m2.svc.install();
    await flush();
    expect(m2.updater.quitAndInstall).not.toHaveBeenCalled();
    await m2.clock.advance(1000);
    await p;
    expect(m2.updater.quits).toEqual([[false, true]]);
  });

  it('quitAndInstall che emette error invece di uscire: error install e annullamento', async () => {
    const m = await ready();
    m.updater.quitAndInstall.mockImplementationOnce(() => {
      m.updater.emit('error', new Error('spawn fallito'));
    });
    await m.svc.install();
    expect(m.events.at(-1)).toMatchObject({ type: 'error', phase: 'install', manual: false });
    expect(m.cancelQuit).toHaveBeenCalledTimes(1);
    // dopo il fallimento si può riprovare
    await m.svc.install();
    expect(m.updater.quitAndInstall).toHaveBeenCalledTimes(2);
  });

  it('busy diventato vero durante closeOnline: nessun quitAndInstall, annullato', async () => {
    const m = make({
      closeOnline: async () => {
        m.setBusy(true);
      },
    });
    await m.svc.check();
    await m.svc.download();
    m.updater.emit('update-downloaded', { version: '0.12.1' });
    expect(await m.svc.install()).toEqual({ ok: false, reason: 'busy' });
    expect(m.updater.quitAndInstall).not.toHaveBeenCalled();
    expect(m.prepareQuit).not.toHaveBeenCalled();
    expect(m.cancelQuit).toHaveBeenCalledTimes(1);
  });

  it('due install di fila: il secondo è rifiutato, un solo quitAndInstall', async () => {
    const m = await ready();
    const a = m.svc.install();
    const b = m.svc.install();
    expect(await b).toEqual({ ok: false, reason: 'busy' });
    await a;
    expect(m.updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });
});

describe('macOS', () => {
  it('mai downloadUpdate né quitAndInstall; autoInstallOnAppQuit falso', async () => {
    const m = make({ platform: 'darwin' });
    await m.svc.check();
    await m.svc.download();
    expect(m.updater.autoInstallOnAppQuit).toBe(false);
    expect(m.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(m.svc.canInstall()).toEqual({ ok: false, reason: 'notReady' });
    expect(await m.svc.install()).toEqual({ ok: false, reason: 'notReady' });
    expect(m.updater.quitAndInstall).not.toHaveBeenCalled();
  });
});

describe('note di rilascio', () => {
  it('apre solo versioni semver valide', async () => {
    const m = make();
    await m.svc.openNotes('0.12.1');
    await m.svc.openNotes('v0.13');
    await m.svc.openNotes('../../etc');
    expect(m.opened).toEqual(['https://github.com/basoxxx/BaaPortal/releases/tag/v0.12.1']);
  });
});
