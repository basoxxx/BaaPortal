import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConfirmTexts, QuestionTexts, RecentEntry, RecoveryInfo } from '@baaportal/ui';
import { writeFileAtomic } from './fsAtomic';
import { toIpcResult } from '../shared/ipcResult';
import { isTrustedFrame, type FrameLike, type TrustOptions } from './trust';
import { deleteRecovery, listRecovery, readRecovery, writeRecovery } from './recoveryStore';
import { parseOpenOptions, parseSaveOptions } from './fileDialogOptions';
import { registerKit } from './kit';
import { createConfirm } from './plc/confirm';
import { registerPlc } from './plc/plcIpc';
import { addRecent, removeRecent, type Platform, type StoredRecent } from './recentProjects';

const platform = process.platform as Platform;

function recentFile(): string {
  return join(app.getPath('userData'), 'recent.json');
}

async function loadRecent(): Promise<StoredRecent[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(recentFile(), 'utf8'));
    return Array.isArray(parsed) ? (parsed as StoredRecent[]) : [];
  } catch {
    return [];
  }
}

async function saveRecent(list: StoredRecent[]): Promise<void> {
  await writeFileAtomic(recentFile(), new TextEncoder().encode(JSON.stringify(list, null, 2)));
}

function withExists(list: StoredRecent[]): RecentEntry[] {
  return list.map((e) => ({ ...e, exists: existsSync(e.path) }));
}

export function registerIpc(
  getWindow: () => BrowserWindow | null,
  trust: TrustOptions,
  onCloseConfirmed: () => void,
  onRendererReady: () => void,
): { closeOnline(): Promise<void>; writing(): boolean; interruptWrites(): void } {
  // Ogni canale risponde solo al frame principale della pagina dell'app.
  const trusted = (e: IpcMainEvent | IpcMainInvokeEvent) =>
    isTrustedFrame(e.senderFrame as FrameLike | null, trust);
  const handle: typeof ipcMain.handle = (channel, listener) =>
    ipcMain.handle(channel, (e, ...args) => {
      if (!trusted(e)) throw new Error('IPC non autorizzato');
      return listener(e, ...args);
    });
  const on: typeof ipcMain.on = (channel, listener) =>
    ipcMain.on(channel, (e, ...args) => {
      if (trusted(e)) listener(e, ...args);
    });

  handle('app:version', () => app.getVersion());
  handle('app:default-project-dir', () => join(app.getPath('documents'), 'BaaPortal'));

  handle('dialog:open-project', async () => {
    const win = getWindow();
    const opts = {
      properties: ['openFile' as const],
      filters: [{ name: 'BaaPortal', extensions: ['baap'] }],
    };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  handle('dialog:save-project', async (_e, suggestedName: string) => {
    const win = getWindow();
    const opts = {
      defaultPath: suggestedName,
      filters: [{ name: 'BaaPortal', extensions: ['baap'] }],
    };
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    return r.canceled ? null : (r.filePath ?? null);
  });
  handle('dialog:open-file', async (_e, raw: unknown) => {
    const { filters, multi } = parseOpenOptions(raw);
    const win = getWindow();
    const opts = {
      properties: multi ? ['openFile' as const, 'multiSelections' as const] : ['openFile' as const],
      filters,
    };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled ? [] : multi ? r.filePaths : r.filePaths.slice(0, 1);
  });
  handle('dialog:save-file', async (_e, raw: unknown) => {
    const { defaultName, filters } = parseSaveOptions(raw);
    const win = getWindow();
    const opts = { defaultPath: defaultName, filters };
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    return r.canceled ? null : (r.filePath ?? null);
  });
  handle('dialog:select-folder', async () => {
    const win = getWindow();
    const opts = { properties: ['openDirectory' as const, 'createDirectory' as const] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  handle('fs:read', (_e, path: string) =>
    toIpcResult(async () => new Uint8Array(await readFile(path))),
  );
  handle('fs:write-atomic', (_e, path: string, data: Uint8Array) =>
    toIpcResult(() => writeFileAtomic(path, data)),
  );
  handle('fs:exists', (_e, path: string) => existsSync(path));

  handle('recent:list', async () => withExists(await loadRecent()));
  handle('recent:add', async (_e, path: string, name: string) => {
    const list = addRecent(await loadRecent(), path, name, new Date(), platform);
    await saveRecent(list);
    return withExists(list);
  });
  handle('recent:remove', async (_e, path: string) => {
    const list = removeRecent(await loadRecent(), path, platform);
    await saveRecent(list);
    return withExists(list);
  });

  on('window:set-title', (_e, title: string) => getWindow()?.setTitle(title));
  on('window:close-confirmed', () => onCloseConfirmed());
  // Anche "pronta" deve venire dalla pagina dell'app: un messaggio rimasto in coda da una pagina in
  // crash (senderFrame non più valido) non deve far credere al main che ci sia chi conferma la chiusura.
  on('app:renderer-ready', () => onRendererReady());

  handle('dialog:confirm-unsaved', async (_e, t: ConfirmTexts) => {
    const opts = {
      type: 'warning' as const,
      title: t.title,
      message: t.message,
      buttons: [t.yes, t.no, t.cancel],
      defaultId: 0,
      cancelId: 2,
    };
    const win = getWindow();
    const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    return r.response === 0 ? 'save' : r.response === 1 ? 'discard' : 'cancel';
  });
  handle('dialog:question', async (_e, t: QuestionTexts) => {
    const opts = {
      type: 'question' as const,
      title: t.title,
      message: t.message,
      buttons: [t.yes, t.no],
      // Con `defaultNo` (es. «Avviare la CPU?») il predefinito e la fuga sono «No».
      defaultId: t.defaultNo ? 1 : 0,
      cancelId: 1,
    };
    const win = getWindow();
    const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    return r.response === 0;
  });
  handle('dialog:error', async (_e, title: string, message: string) => {
    const opts = { type: 'error' as const, title, message, buttons: ['OK'] };
    const win = getWindow();
    if (win) await dialog.showMessageBox(win, opts);
    else await dialog.showMessageBox(opts);
  });

  on('clipboard:write-text', (_e, text: string) => {
    if (typeof text === 'string') clipboard.writeText(text);
  });
  handle('clipboard:read-text', () => clipboard.readText());

  // File di recupero: la chiave è validata da recoveryStore prima di formare qualunque percorso.
  const recoveryDir = () => join(app.getPath('userData'), 'recovery');
  handle('recovery:write', (_e, key: string, data: Uint8Array, info: RecoveryInfo) =>
    toIpcResult(() => writeRecovery(recoveryDir(), key, data, info)),
  );
  handle('recovery:list', () => listRecovery(recoveryDir()));
  handle('recovery:read', (_e, key: string) => toIpcResult(() => readRecovery(recoveryDir(), key)));
  handle('recovery:delete', (_e, key: string) =>
    toIpcResult(() => deleteRecovery(recoveryDir(), key)),
  );

  registerKit(handle);
  const plc = registerPlc(
    handle,
    createConfirm(dialog, (o) => BrowserWindow.fromWebContents(o as WebContents)),
  );

  // Valori solo per i test e2e: come BAA_USER_DATA, mai onorati nelle build pacchettizzate.
  handle('app:test-overrides', () => {
    const ms = Number(process.env['BAA_RECOVERY_MS']);
    const enabled = !app.isPackaged && !!process.env['BAA_USER_DATA'];
    return enabled && Number.isInteger(ms) && ms > 0 ? { recoveryIntervalMs: ms } : {};
  });
  return {
    closeOnline: () => plc.closeAll(),
    writing: () => plc.writing(),
    interruptWrites: () => plc.interruptWrites(),
  };
}
