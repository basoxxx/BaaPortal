import type { CancellationToken } from 'builder-util-runtime';

export interface UpdateCheckResult {
  updateInfo: { version: string; files: { url: string; sha512: string; size?: number }[] };
}

/** Il sottoinsieme di `AppUpdater` che serve al servizio: i test lo sostituiscono con un finto. */
export interface UpdaterPort {
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  logger: { info(m?: unknown): void; warn(m?: unknown): void; error(m?: unknown): void } | null;
  checkForUpdates(): Promise<UpdateCheckResult | null>;
  downloadUpdate(token?: CancellationToken): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: 'download-progress', cb: (p: { transferred: number; total: number }) => void): unknown;
  on(event: 'update-downloaded', cb: (i: { version: string }) => void): unknown;
  on(event: 'error', cb: (e: Error) => void): unknown;
}

/** Pacchetto CommonJS dentro un main ESM: niente import con nome. */
export async function loadUpdater(): Promise<UpdaterPort> {
  const m = await import('electron-updater');
  return m.default.autoUpdater as unknown as UpdaterPort;
}
