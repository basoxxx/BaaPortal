/** Impostazioni degli aggiornamenti; `prerelease: null` segue il canale della build. */
export interface UpdatePrefs {
  checkOnStartup: boolean;
  prerelease: boolean | null;
}

export interface UpdateInfoView {
  enabled: boolean;
  prereleaseBuild: boolean;
  current: string;
  platform: 'win32' | 'darwin' | 'linux';
  mode: 'install' | 'dmg' | 'none';
}

export type UpdatePhase = 'check' | 'download' | 'install';

/** Eventi dal processo principale (canale `update:event`). */
export type UpdateEvent =
  | { type: 'checking'; manual: boolean }
  | { type: 'none'; manual: boolean }
  | { type: 'available'; version: string; manual: boolean }
  | { type: 'progress'; transferred: number; total: number }
  | { type: 'downloaded'; version: string }
  | { type: 'macReady'; version: string; path: string; reused: boolean }
  | { type: 'error'; phase: UpdatePhase; message: string; manual: boolean }
  | { type: 'cancelled' };

export type UpdateBlockReason = 'busy' | 'notReady';
export type UpdateCanInstall = { ok: true } | { ok: false; reason: UpdateBlockReason };
