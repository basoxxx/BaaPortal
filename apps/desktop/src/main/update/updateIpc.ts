import type { IpcMainInvokeEvent } from 'electron';
import { parseUpdatePrefs } from './updatePolicy';
import type { UpdateService } from './updateService';
import type { UpdateInfoView } from '../../shared/updateTypes';

type Handle = (
  channel: string,
  listener: (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
) => void;

/** Canali `update:*`; `handle` è quello di registerIpc, che controlla il frame fidato. */
export function registerUpdate(
  handle: Handle,
  service: UpdateService | null,
  info: UpdateInfoView,
): void {
  // Senza servizio (build non pacchettizzata) i canali rispondono «spento» e non fanno nulla.
  handle('update:info', () => info);
  handle('update:state', () => service?.state() ?? null);
  handle('update:prefs', async (_e, raw) => {
    const p = parseUpdatePrefs(raw);
    if (typeof p === 'string') throw new Error(p);
    await service?.setPrefs(p);
  });
  handle('update:check', async () => {
    await service?.check(true);
  });
  handle('update:download', async () => {
    await service?.download();
  });
  handle('update:cancelDownload', () => service?.cancelDownload());
  handle('update:canInstall', () => service?.canInstall() ?? { ok: false, reason: 'notReady' });
  handle('update:install', async () =>
    service ? await service.install() : { ok: false, reason: 'notReady' },
  );
  // Il percorso lo tiene il main: il renderer non ne manda.
  handle('update:showInFolder', () => service?.showInFolder());
  handle('update:later', (_e, version) => {
    if (typeof version === 'string') service?.later(version);
  });
  handle('update:openNotes', async (_e, version) => {
    if (typeof version === 'string') await service?.openNotes(version);
  });
}
