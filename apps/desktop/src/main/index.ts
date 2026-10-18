import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerIpc } from './ipc';
import { isTrustedUrl, type TrustOptions } from './trust';

// Hook di test (userData isolato, uscita senza conferma): mai onorato nelle build pacchettizzate.
const testUserData = !app.isPackaged ? process.env['BAA_USER_DATA'] : undefined;
if (testUserData) app.setPath('userData', testUserData);

const trust: TrustOptions = {
  indexFileUrl: pathToFileURL(join(import.meta.dirname, '../renderer/index.html')).href,
  devUrl: process.env['ELECTRON_RENDERER_URL'],
};

let win: BrowserWindow | null = null;
let allowClose = false;
let rendererIsReady = false;
const pendingOpen: string[] = [];

const isBaap = (p: string) => p.toLowerCase().endsWith('.baap');

function focusWindow(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function requestOpen(path: string): void {
  if (rendererIsReady && win) win.webContents.send('app:open-file', path);
  else pendingOpen.push(path);
}

/**
 * Il menu vero è quello nella finestra (renderer). Su macOS resta un menu nativo minimo con le voci
 * standard dell'app e Modifica (taglia/copia/incolla nei campi di testo); altrove il menu nativo si toglie.
 */
function setupNativeMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'BaaPortal',
        submenu: [{ label: 'Informazioni su BaaPortal', role: 'about' }, { type: 'separator' }, { label: 'Esci', role: 'quit' }],
      },
      {
        label: 'Modifica',
        submenu: [
          { label: 'Taglia', role: 'cut' },
          { label: 'Copia', role: 'copy' },
          { label: 'Incolla', role: 'paste' },
          { label: 'Seleziona tutto', role: 'selectAll' },
        ],
      },
    ]),
  );
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
  // Se il renderer non è pronto (avvio fallito, crash, caricamento) non c'è chi possa confermare: si chiude.
  win.on('close', (e) => {
    if (allowClose || !rendererIsReady) return;
    e.preventDefault();
    win?.webContents.send('app:close-requested');
  });
  win.on('closed', () => {
    win = null;
  });
  win.webContents.on('did-start-loading', () => {
    rendererIsReady = false;
  });
  win.webContents.on('render-process-gone', () => {
    rendererIsReady = false;
  });
  // La pagina dell'app non deve mai navigare altrove (file rilasciati, link) né aprire altre finestre.
  win.webContents.on('will-navigate', (e, url) => {
    if (!isTrustedUrl(url, trust)) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  for (const a of process.argv.slice(1)) if (isBaap(a)) pendingOpen.push(a);

  app.on('second-instance', (_e, argv) => {
    focusWindow();
    for (const a of argv.slice(1)) if (isBaap(a)) requestOpen(a);
  });
  app.on('open-file', (e, path) => {
    e.preventDefault();
    focusWindow();
    requestOpen(path);
  });
  // Solo nei test e2e (userData isolato): permette ad app.close() di Playwright di terminare
  // l'app senza passare dalla conferma di chiusura; la chiusura di finestra resta intercettata.
  if (testUserData) {
    app.on('before-quit', () => {
      allowClose = true;
    });
  }
  app.on('window-all-closed', () => app.quit());

  registerIpc(
    () => win,
    trust,
    () => {
      allowClose = true;
      win?.close();
    },
  );
  ipcMain.on('app:renderer-ready', () => {
    rendererIsReady = true;
    for (const p of pendingOpen.splice(0)) win?.webContents.send('app:open-file', p);
  });

  void app.whenReady().then(() => {
    setupNativeMenu();
    createWindow();
  });
}
