import semver from 'semver';
import type { UpdateCanInstall, UpdateEvent, UpdatePrefs } from '../../shared/updateTypes';
import { effectivePrerelease, errorText, isNewer, shouldReport } from './updatePolicy';
import { DownloadCancelled, type MacFile } from './macDownload';
import type { UpdaterPort } from './updaterPort';

const FIRST_CHECK_MS = 10_000;
const CHECK_EVERY_MS = 6 * 3600_000;
const PROGRESS_MIN_MS = 250;
const CLOSE_ONLINE_MS = 1000;
const NOTES_URL = 'https://github.com/basoxxx/BaaPortal/releases/tag/v';

export interface UpdateServiceDeps {
  updater: () => Promise<UpdaterPort>;
  /** Il token di annullamento di builder-util-runtime (importato solo quando serve). */
  newToken: () => Promise<{ cancel(): void }>;
  platform: 'win32' | 'darwin' | 'linux';
  arch: string;
  prereleaseBuild: boolean;
  current: string;
  /** Scrittura nella CPU, caricamento dal dispositivo o backup in corso. */
  busy(): boolean;
  closeOnline(): Promise<void>;
  /** Prepara l'uscita: né la finestra né before-quit devono più rimandarla. */
  prepareQuit(): void;
  /** Annulla `prepareQuit` e riabilita le operazioni online (installazione fallita o rinviata). */
  cancelQuit(): void;
  send(e: UpdateEvent): void;
  openExternal(url: string): Promise<void>;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
  now(): number;
  /** Solo macOS: sceglie, scarica e verifica il DMG; lancia `DownloadCancelled` se annullato. */
  macDownload?: (
    a: { version: string; files: MacFile[] },
    onProgress: (transferred: number, total: number) => void,
    signal: AbortSignal,
  ) => Promise<{ path: string; reused: boolean }>;
  /** Solo macOS: apre il DMG (stringa vuota = riuscito, come `shell.openPath`). */
  openPath?: (path: string) => Promise<string>;
  showInFolder?: (path: string) => void;
}

/** Stato, pianificazione, controllo, scaricamento (Windows) e installazione degli aggiornamenti. */
export class UpdateService {
  private prefs: UpdatePrefs | null = null;
  private timer: unknown = null;
  private checking: { promise: Promise<void>; manual: boolean } | null = null;
  private port: UpdaterPort | null = null;
  private last: UpdateEvent | null = null;
  private availableVersion: string | null = null;
  private downloadedVersion: string | null = null;
  private downloading = false;
  private installing = false;
  private token: { cancel(): void } | null = null;
  private abort: AbortController | null = null;
  private availableFiles: MacFile[] = [];
  private macPath: string | null = null;
  private cancelling = false;
  private lastProgress = -Infinity;
  private readonly dismissed = new Set<string>();

  constructor(private readonly d: UpdateServiceDeps) {}

  /** L'ultimo evento significativo, per ricostruire l'avviso dopo una ricarica del renderer. */
  state(): UpdateEvent | null {
    return this.last;
  }

  /** Arrivano dal renderer dopo l'avvio: da qui in poi (e non prima) si pianificano i controlli. */
  async setPrefs(p: UpdatePrefs): Promise<void> {
    this.prefs = p;
    if (!p.checkOnStartup) this.clearTimer();
    else if (this.timer === null && !this.checking) this.schedule(FIRST_CHECK_MS);
  }

  /** A mano (predefinito) o automatico; un controllo alla volta, chi arriva dopo aspetta quello. */
  check(manual = true): Promise<void> {
    if (this.d.platform === 'linux') return Promise.resolve();
    if (this.checking) {
      if (manual && !this.checking.manual) {
        this.checking.manual = true;
        this.d.send({ type: 'checking', manual: true });
      }
      return this.checking.promise;
    }
    const run = { promise: Promise.resolve(), manual };
    run.promise = this.runCheck(run).finally(() => {
      this.checking = null;
      if (this.prefs?.checkOnStartup) this.schedule(CHECK_EVERY_MS);
    });
    this.checking = run;
    return run.promise;
  }

  later(version: string): void {
    if (typeof version !== 'string' || semver.valid(version) !== version) return;
    this.dismissed.add(version);
    if (this.last?.type === 'available' && this.last.version === version) this.last = null;
  }

  async openNotes(version: string): Promise<void> {
    const v = typeof version === 'string' ? semver.valid(version) : null;
    if (v !== null && v === version) await this.d.openExternal(NOTES_URL + v);
  }

  async download(): Promise<void> {
    if (this.downloading || this.downloadedVersion || !this.availableVersion) return;
    if (this.d.platform === 'darwin') {
      await this.macDownload(this.availableVersion);
      return;
    }
    if (this.d.platform !== 'win32') return;
    // Subito, prima di ogni attesa: una seconda chiamata non deve partire.
    this.downloading = true;
    this.cancelling = false;
    this.lastProgress = -Infinity;
    try {
      const updater = await this.updater();
      const token = await this.d.newToken();
      this.token = token;
      // `download-progress` e `update-downloaded` arrivano dai gestori fissati in `updater()`.
      updater
        .downloadUpdate(token as never)
        .then(() => undefined)
        .catch((err: unknown) => this.downloadFailed(err))
        .finally(() => {
          this.downloading = false;
          this.token = null;
        });
    } catch (err) {
      this.downloading = false;
      this.downloadFailed(err);
    }
  }

  private async macDownload(version: string): Promise<void> {
    if (!this.d.macDownload) return;
    this.downloading = true;
    this.cancelling = false;
    this.lastProgress = -Infinity;
    const ac = new AbortController();
    this.abort = ac;
    try {
      const r = await this.d.macDownload(
        { version, files: this.availableFiles },
        (transferred, total) => this.progress(transferred, total),
        ac.signal,
      );
      this.macPath = r.path;
      // Se non si apre da solo, l'avviso offre «Mostra nel Finder»: l'evento porta comunque il percorso.
      await this.d.openPath?.(r.path).catch(() => undefined);
      this.send({ type: 'macReady', version, path: r.path, reused: r.reused });
    } catch (err) {
      if (err instanceof DownloadCancelled) this.send({ type: 'cancelled' });
      else this.send({ type: 'error', phase: 'download', message: errorText(err), manual: false });
    } finally {
      this.downloading = false;
      this.abort = null;
    }
  }

  /** Mostra nel Finder il file scaricato: il percorso è quello tenuto qui, mai del renderer. */
  showInFolder(): void {
    if (this.macPath) this.d.showInFolder?.(this.macPath);
  }

  private progress(transferred: number, total: number): void {
    const t = this.d.now();
    if (t - this.lastProgress < PROGRESS_MIN_MS) return;
    this.lastProgress = t;
    this.send({ type: 'progress', transferred, total });
  }

  private downloadFailed(err: unknown): void {
    if (this.cancelling) this.send({ type: 'cancelled' });
    else this.send({ type: 'error', phase: 'download', message: errorText(err), manual: false });
  }

  cancelDownload(): void {
    if (this.downloading && this.abort) {
      this.abort.abort();
      return;
    }
    if (!this.downloading || !this.token) return;
    this.cancelling = true;
    this.token.cancel();
  }

  canInstall(): UpdateCanInstall {
    if (this.d.platform !== 'win32' || !this.downloadedVersion) {
      return { ok: false, reason: 'notReady' };
    }
    if (this.d.busy()) return { ok: false, reason: 'busy' };
    return { ok: true };
  }

  /** Con successo l'app esce e non restituisce nulla. */
  async install(): Promise<{ ok: false; reason: 'busy' | 'notReady' } | undefined> {
    if (this.installing) return { ok: false, reason: 'busy' };
    // Fra canInstall e qui potrebbe essere partita una scrittura: si ricontrolla.
    const can = this.canInstall();
    if (!can.ok) return can;
    this.installing = true; // subito: un secondo clic non deve ripartire
    try {
      const updater = await this.updater();
      let timer: unknown;
      const cap = new Promise<void>((r) => {
        timer = this.d.setTimeout(r, CLOSE_ONLINE_MS);
      });
      await Promise.race([this.d.closeOnline().catch(() => undefined), cap]);
      this.d.clearTimeout(timer);
      // Durante la chiusura può essere partita un'operazione, o l'updater può aver già fallito.
      if (!this.installing) return { ok: false, reason: 'busy' };
      if (this.d.busy()) {
        this.rollbackInstall();
        return { ok: false, reason: 'busy' };
      }
      this.d.prepareQuit();
      updater.quitAndInstall(false, true);
    } catch (err) {
      this.installFailed(err);
    }
    return undefined;
  }

  private rollbackInstall(): void {
    this.installing = false;
    this.d.cancelQuit();
  }

  private installFailed(err: unknown): void {
    this.rollbackInstall();
    this.send({ type: 'error', phase: 'install', message: errorText(err), manual: false });
  }

  private send(e: UpdateEvent): void {
    // Si ricorda solo ciò che serve a ricostruire l'avviso: non progresso, errori e «nessuno».
    if (e.type === 'available' || e.type === 'downloaded' || e.type === 'macReady') this.last = e;
    this.d.send(e);
  }

  private clearTimer(): void {
    if (this.timer !== null) this.d.clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    this.clearTimer();
    this.timer = this.d.setTimeout(() => {
      this.timer = null;
      // Con uno scaricamento in corso o un aggiornamento pronto non serve cercare altro.
      if (this.downloading || this.downloadedVersion || this.last?.type === 'macReady') {
        this.schedule(CHECK_EVERY_MS);
        return;
      }
      void this.check(false);
    }, ms);
  }

  private async updater(): Promise<UpdaterPort> {
    if (!this.port) {
      const u = await this.d.updater();
      u.logger = console;
      u.on('error', (e) => {
        // quitAndInstall non lancia: se fallisce emette 'error' e non esce.
        if (this.installing) this.installFailed(e);
        else console.warn('[aggiornamenti]', e);
      });
      u.on('download-progress', (p) => {
        this.progress(p.transferred, p.total);
      });
      u.on('update-downloaded', (i) => {
        if (!isNewer(i.version, this.d.current)) return;
        if (this.availableVersion && i.version !== this.availableVersion) return;
        this.downloadedVersion = i.version;
        this.send({ type: 'downloaded', version: i.version });
      });
      this.port = u;
    }
    return this.port;
  }

  private async runCheck(run: { manual: boolean }): Promise<void> {
    this.send({ type: 'checking', manual: run.manual });
    try {
      const u = await this.updater();
      u.autoDownload = false;
      u.autoInstallOnAppQuit = this.d.platform === 'win32';
      u.allowDowngrade = false;
      u.allowPrerelease = effectivePrerelease(
        this.d.prereleaseBuild,
        this.prefs?.prerelease ?? null,
      );
      const r = await u.checkForUpdates();
      const version = r?.updateInfo.version;
      // Con uno scaricamento in corso o già fatto lo stato non si tocca: prima si installa o si scarta.
      if (this.downloading || this.downloadedVersion || this.last?.type === 'macReady') {
        if (run.manual && this.last?.type === 'macReady') this.d.send(this.last);
        else if (run.manual && this.last?.type === 'downloaded') this.d.send(this.last);
        return;
      }
      // Si decide con le nostre regole, anche se electron-updater dice altro.
      if (!version || !isNewer(version, this.d.current)) {
        this.availableVersion = null;
        if (this.last?.type === 'available') this.last = null;
        if (shouldReport('none', run.manual)) this.send({ type: 'none', manual: run.manual });
        return;
      }
      this.availableVersion = version;
      this.availableFiles = r?.updateInfo.files ?? [];
      if (!run.manual && this.dismissed.has(version)) return;
      this.send({ type: 'available', version, manual: run.manual });
    } catch (err) {
      const message = errorText(err);
      if (shouldReport('error', run.manual)) {
        this.send({ type: 'error', phase: 'check', message, manual: true });
      } else {
        console.warn('[aggiornamenti] controllo non riuscito:', message);
      }
    }
  }
}
