import { app, BrowserWindow, dialog, Menu } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerIpc } from './ipc';
import type { Platform } from './recentProjects';
import { isTrustedUrl, type TrustOptions } from './trust';

// Hook di test (userData isolato, uscita senza conferma): mai onorato nelle build pacchettizzate.
const testUserData = !app.isPackaged ? process.env['BAA_USER_DATA'] : undefined;
if (testUserData) app.setPath('userData', testUserData);

// Solo e2e: BAA_DIALOG_RESPONSES (array JSON di numeri) sostituisce i dialoghi nativi già all'avvio,
// quando un test non fa in tempo a sostituirli (es. la domanda di recupero). Registra i messaggi.
if (testUserData && process.env['BAA_DIALOG_RESPONSES']) {
  try {
    const parsed: unknown = JSON.parse(process.env['BAA_DIALOG_RESPONSES']);
    if (Array.isArray(parsed) && parsed.every((n) => typeof n === 'number')) {
      const responses = [...(parsed as number[])];
      const g = globalThis as unknown as { __dialogs: string[] };
      g.__dialogs = [];
      dialog.showMessageBox = (async (...a: unknown[]) => {
        g.__dialogs.push((a[a.length - 1] as { message: string }).message);
        return { response: responses.shift() ?? 0, checkboxChecked: false };
      }) as unknown as typeof dialog.showMessageBox;
    }
  } catch {
    // JSON non valido: i dialoghi restano quelli veri.
  }
}

// Dev server di electron-vite: in una build pacchettizzata la pagina viene sempre dai file dell'app.
const devUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined;

const trust: TrustOptions = {
  indexFileUrl: pathToFileURL(join(import.meta.dirname, '../renderer/index.html')).href,
  devUrl,
  platform: process.platform as Platform,
};

const EDITOR_FRAME_NAME = /^baa-editor-[A-Za-z0-9-]+$/;

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
        submenu: [
          { label: 'Informazioni su BaaPortal', role: 'about' },
          { type: 'separator' },
          { label: 'Esci', role: 'quit' },
        ],
      },
      {
        label: 'Modifica',
        // Annulla e Ripeti nativi servono ai campi di testo: su macOS Cmd+Z nei campi funziona solo
        // tramite il menu. Il tasto arriva prima alla pagina: fuori dai campi il renderer annulla il
        // progetto e chiama preventDefault, così il menu non lo riceve e non c'è doppio annullamento;
        // se la pagina non lo gestisce, l'annullamento nativo fuori da un campo modificabile non fa
        // nulla. Scelte dal menu con il mouse, le voci agiscono solo sul campo con il focus.
        submenu: [
          { label: 'Annulla', role: 'undo' },
          { label: 'Ripeti', role: 'redo' },
          { type: 'separator' },
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
    if (allowClose || !rendererIsReady || win?.webContents.isCrashed()) return;
    e.preventDefault();
    win?.webContents.send('app:close-requested');
  });
  win.on('closed', () => {
    win = null;
    // Le uniche altre finestre sono gli editor staccati: non sopravvivono alla principale.
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  });
  // Solo un nuovo documento (es. ricarica) deve riannunciarsi: una navigazione bloccata da
  // will-navigate avvia comunque un caricamento ma lascia la pagina, e il renderer, com'erano.
  win.webContents.on('did-navigate', () => {
    rendererIsReady = false;
  });
  win.webContents.on('render-process-gone', () => {
    rendererIsReady = false;
  });
  // La pagina dell'app non deve mai navigare altrove (file rilasciati, link) né aprire altre finestre.
  win.webContents.on('will-navigate', (e, url) => {
    if (!isTrustedUrl(url, trust)) e.preventDefault();
  });
  // Unica eccezione: le finestre degli editor staccati (about:blank con nome baa-editor-*), che il
  // renderer anima da sé. Electron riporta `window.open('', nome)` con url 'about:blank'.
  win.webContents.setWindowOpenHandler(({ url, frameName }) =>
    url === 'about:blank' && EDITOR_FRAME_NAME.test(frameName)
      ? {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 1000,
            height: 700,
            minWidth: 480,
            minHeight: 320,
            title: 'BaaPortal',
            autoHideMenuBar: true,
          },
        }
      : { action: 'deny' },
  );
  win.webContents.on('did-create-window', (child) => {
    child.setMenu(null);
    child.webContents.on('will-navigate', (e) => e.preventDefault());
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
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
    () => {
      rendererIsReady = true;
      for (const p of pendingOpen.splice(0)) win?.webContents.send('app:open-file', p);
    },
  );

  void app.whenReady().then(() => {
    setupNativeMenu();
    createWindow();
  });
}
