import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { registerIpc } from './ipc';

if (process.env['BAA_USER_DATA']) app.setPath('userData', process.env['BAA_USER_DATA']);

let win: BrowserWindow | null = null;
let allowClose = false;
let rendererIsReady = false;
const pendingOpen: string[] = [];

const isBaap = (p: string) => p.toLowerCase().endsWith('.baap');

function requestOpen(path: string): void {
  if (rendererIsReady && win) win.webContents.send('app:open-file', path);
  else pendingOpen.push(path);
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'BaaPortal',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    win?.webContents.send('app:close-requested');
  });
  win.on('closed', () => {
    win = null;
  });
  win.webContents.on('did-start-loading', () => {
    rendererIsReady = false;
  });
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  for (const a of process.argv.slice(1)) if (isBaap(a)) pendingOpen.push(a);

  app.on('second-instance', (_e, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    for (const a of argv.slice(1)) if (isBaap(a)) requestOpen(a);
  });
  app.on('open-file', (e, path) => {
    e.preventDefault();
    requestOpen(path);
  });
  // Solo nei test e2e (userData isolato): permette ad app.close() di Playwright di terminare
  // l'app senza passare dalla conferma di chiusura; la chiusura di finestra resta intercettata.
  if (process.env['BAA_USER_DATA']) {
    app.on('before-quit', () => {
      allowClose = true;
    });
  }
  app.on('window-all-closed', () => app.quit());

  registerIpc(
    () => win,
    () => {
      allowClose = true;
      win?.close();
    },
  );
  ipcMain.on('app:renderer-ready', () => {
    rendererIsReady = true;
    for (const p of pendingOpen.splice(0)) win?.webContents.send('app:open-file', p);
  });

  void app.whenReady().then(createWindow);
}
