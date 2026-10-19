import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import electronPath from 'electron';
import {
  _electron,
  expect,
  test as base,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findCpu } from '@baaportal/catalog';
import {
  createCodeBlock,
  createPlcDevice,
  createProject as newProject,
  writeBaap,
  type PlcDevice,
  type Project,
} from '@baaportal/project';

export interface Launched {
  app: ElectronApplication;
  page: Page;
  userData: string;
}

const launched: Launched[] = [];
// app.process() non è più utilizzabile dopo app.close(): il processo si conserva al lancio.
const processes = new WeakMap<ElectronApplication, ChildProcess>();

/**
 * Rimuove una cartella temporanea. Su Windows i processi figli di Electron (GPU, utility) tengono
 * aperti alcuni file di userData per un po' dopo la chiusura: rmSync riprova su EBUSY/EPERM/ENOTEMPTY.
 * Se dopo tutti i tentativi la pulizia fallisce, avvisa senza far fallire la prova.
 */
export function removeDir(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  } catch (e) {
    console.warn(`pulizia di ${path} non riuscita: ${String(e)}`);
  }
}

/** Risolve quando il processo principale di Electron è uscito (o dopo `timeoutMs`). */
export async function waitForExit(proc: ChildProcess, timeoutMs = 15_000): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Chiude l'app e aspetta l'uscita del processo principale: dopo, userData si può cancellare. */
export async function closeApp(app: ElectronApplication): Promise<void> {
  await app.close().catch(() => undefined);
  const proc = processes.get(app);
  if (proc) await waitForExit(proc);
}

/**
 * Termina l'app senza alcuna chiusura ordinata e aspetta l'uscita del processo principale. Su Windows
 * uccide l'intero albero: i figli (GPU, utility, renderer) altrimenti restano vivi e tengono il blocco
 * di istanza unica e i file di userData, e la riapertura con lo stesso userData fallisce.
 */
export async function killAppTree(app: ElectronApplication): Promise<void> {
  const proc = processes.get(app) ?? app.process();
  const exited = waitForExit(proc);
  if (process.platform === 'win32' && proc.pid !== undefined) {
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F']);
  } else {
    proc.kill('SIGKILL');
  }
  await exited;
}

/**
 * `test` di Playwright con una fixture automatica che, dopo ogni test (anche fallito), chiude le app
 * lanciate e rimuove i loro userData temporanei. Gli spec devono importare `test` da qui: un
 * afterEach a livello di modulo si aggancerebbe solo al primo file che importa questo helper.
 */
export const test = base.extend<{ closeLaunchedApps: void }>({
  closeLaunchedApps: [
    async ({}, use) => {
      await use();
      for (const l of launched.splice(0)) {
        await closeApp(l.app);
        removeDir(l.userData);
      }
    },
    { auto: true },
  ],
});
export { expect };

/** `cwd`: cartella da cui avviare Electron; lo script principale `out/main/index.js` si risolve da lì. */
export async function launchApp(
  opts: {
    args?: string[];
    cwd?: string;
    /** Variabili d'ambiente in più. */
    env?: Record<string, string>;
    /** userData esistente da riusare (invece di crearne uno); viene rimosso comunque a fine test. */
    userData?: string;
  } = {},
): Promise<Launched> {
  const created = opts.userData === undefined;
  const userData = opts.userData ?? mkdtempSync(join(tmpdir(), 'baa-userdata-'));
  // Con un timeout proprio, un avvio bloccato fallisce riportando nel call log l'uscita del processo.
  let app: ElectronApplication;
  try {
    app = await _electron.launch({
      args: ['out/main/index.js', ...(opts.args ?? [])],
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, BAA_USER_DATA: userData },
      timeout: 15_000,
    });
  } catch (e) {
    // Un userData passato dal chiamante resta (serve ai tentativi successivi e lo pulisce la fixture).
    if (created) removeDir(userData);
    throw e;
  }
  processes.set(app, app.process());
  // Uscita di main e renderer: compare nell'errore solo se l'app non arriva a mostrarsi.
  const log: string[] = [];
  app.process().stdout?.on('data', (d) => log.push(`[main] ${String(d).trimEnd()}`));
  app.process().stderr?.on('data', (d) => log.push(`[main:err] ${String(d).trimEnd()}`));
  let page: Page | undefined;
  try {
    page = await app.firstWindow({ timeout: 10_000 });
    launched.push({ app, page, userData });
    page.on('console', (m) => log.push(`[renderer:${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => log.push(`[renderer:pageerror] ${e.message}`));
    // firstWindow() risolve alla creazione della finestra, prima che il modulo del renderer sia
    // eseguito: senza questa attesa window.baa e la UI possono ancora non esistere.
    await page.waitForFunction(
      () =>
        typeof (window as { baa?: unknown }).baa === 'object' &&
        !!document.querySelector('#root > *'),
      undefined,
      { timeout: 15_000 },
    );
  } catch (e) {
    if (!page) {
      await closeApp(app);
      if (created) removeDir(userData);
    }
    const where = page ? `pagina: ${page.url()}` : 'nessuna finestra';
    throw new Error(`l'app non si è mostrata (${where})\n${log.join('\n')}`, { cause: e });
  }
  return { app, page, userData };
}

/**
 * Come launchApp, ma riprova (3 tentativi) se l'avvio fallisce: dopo una chiusura anomala su Windows i
 * processi figli possono tenere ancora per qualche istante il blocco di istanza unica di userData.
 */
export async function launchAppWithRetry(
  opts: Parameters<typeof launchApp>[0] = {},
  attempts = 3,
  waitMs = 1_000,
): Promise<Launched> {
  for (let i = 1; ; i++) {
    try {
      return await launchApp(opts);
    } catch (e) {
      if (i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

/** Sostituisce i dialoghi nativi nel processo principale: ogni messaggio viene registrato in globalThis.__dialogs. */
export async function stubMessageBox(app: ElectronApplication, response: number): Promise<void> {
  await app.evaluate(({ dialog }, r) => {
    const g = globalThis as unknown as { __dialogs: string[] };
    g.__dialogs = [];
    dialog.showMessageBox = (async (...a: unknown[]) => {
      const opts = a[a.length - 1] as { message: string };
      g.__dialogs.push(opts.message);
      return { response: r, checkboxChecked: false };
    }) as unknown as typeof dialog.showMessageBox;
  }, response);
}

export function shownDialogs(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as unknown as { __dialogs: string[] }).__dialogs);
}

export async function createProject(page: Page, name: string, dir: string): Promise<void> {
  await page.getByTestId('action-new').click();
  await page.getByLabel('Nome progetto').fill(name);
  await page.getByLabel('Percorso').fill(dir);
  await page.getByRole('button', { name: 'Crea', exact: true }).click();
}

/** Avvia una seconda istanza di Electron con lo stesso userData; risolve con il suo codice di uscita. */
export function spawnSecondInstance(userData: string, file: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(electronPath as unknown as string, ['out/main/index.js', file], {
      env: { ...process.env, BAA_USER_DATA: userData },
      stdio: 'ignore',
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('la seconda istanza non è terminata'));
    }, 15_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.on('error', reject);
  });
}

/** Scorciatoia "Mod": Cmd su macOS, Ctrl altrove. */
export const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

/** Titolo della prima finestra (quella principale). */
export function mainTitle(app: ElectronApplication): Promise<string | undefined> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle());
}

export function windowCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
}

/** Dalla vista portale apre la vista progetto. */
export async function openProjectView(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Apri la vista progetto' }).first().click();
  await expect(page.getByTestId('menu-bar')).toBeVisible();
}

/** Aggiunge una CPU dal catalogo con il dialogo "Aggiungi nuovo dispositivo". */
export async function addCpu(page: Page, cpuId = 'cpu-315-2-pn-dp'): Promise<void> {
  await page.getByTestId('tree-node-add-device').dblclick();
  const dialog = page.getByRole('dialog');
  await dialog.getByTestId(`catalog-cpu:${cpuId}`).click();
  await page.getByTestId('dialog-ok').click();
  await expect(dialog).toHaveCount(0);
}

/** Id del primo PLC nell'albero (gli id dei nodi sono `plc:<id>[:...]`). */
export async function firstDeviceId(page: Page): Promise<string> {
  const node = page.locator('[data-testid^="tree-node-plc:"]').first();
  await expect(node).toBeVisible();
  const testId = (await node.getAttribute('data-testid')) ?? '';
  return testId.slice('tree-node-plc:'.length).split(':')[0] ?? '';
}

/** Aggiunge un blocco con il dialogo "Aggiungi nuovo blocco" (senza aprirlo nell'editor). */
export async function addBlock(
  page: Page,
  dev: string,
  opts: { kind: 'OB' | 'FB' | 'FC' | 'DB'; name?: string; instanceOf?: string },
): Promise<void> {
  await page.getByTestId(`tree-node-plc:${dev}:blocks-add`).dblclick();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', { name: new RegExp(`\\(${opts.kind}\\)`) }).check();
  if (opts.instanceOf !== undefined) {
    await dialog.getByRole('radio', { name: 'DB di istanza di' }).check();
    await dialog.getByLabel('Blocco funzionale', { exact: true }).selectOption(opts.instanceOf);
  }
  if (opts.name !== undefined) await dialog.getByLabel('Nome', { exact: true }).fill(opts.name);
  await dialog.getByRole('checkbox', { name: 'Aggiungi e apri' }).uncheck();
  await page.getByTestId('dialog-ok').click();
  await expect(dialog).toHaveCount(0);
}

/**
 * Scrive un .baap con un PLC (CPU 315-2 PN/DP) e un FB "Nastro", per gli spec che non devono ripassare
 * dalla creazione guidata. `customize` modifica il PLC prima della scrittura.
 */
export function writeFixtureProject(
  file: string,
  customize: (dev: PlcDevice) => void = () => undefined,
): { project: Project; dev: PlcDevice } {
  const cpu = findCpu('cpu-315-2-pn-dp');
  if (!cpu) throw new Error('CPU di prova mancante nel catalogo');
  const project = newProject({ name: 'Prova', author: '', comment: '' }, new Date());
  const dev = createPlcDevice({
    cpu,
    orderNumber: cpu.versions[0]!.orderNumber,
    firmware: cpu.versions[0]!.firmware[0]!,
    name: 'PLC_1',
    texts: { defaultTagTable: 'Tabella delle variabili standard' },
  });
  dev.blocks.push(createCodeBlock({ kind: 'FB', number: 1, name: 'Nastro', language: 'AWL' }));
  customize(dev);
  project.devices.push(dev);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, writeBaap(project, { appVersion: '0.0.0-e2e' }));
  return { project, dev };
}

/**
 * Sostituisce dialog.showOpenDialog/showSaveDialog nel processo principale: restituiscono i percorsi
 * dati (null = annullato) e registrano in globalThis.__fileDialogs le opzioni ricevute (senza finestra).
 */
export async function stubFileDialogs(
  app: ElectronApplication,
  results: { open?: string[] | null; save?: string | null },
): Promise<void> {
  await app.evaluate(({ dialog }, r) => {
    const g = globalThis as unknown as { __fileDialogs: { kind: string; opts: unknown }[] };
    g.__fileDialogs = [];
    dialog.showOpenDialog = (async (...a: unknown[]) => {
      g.__fileDialogs.push({ kind: 'open', opts: a[a.length - 1] });
      return r.open ? { canceled: false, filePaths: r.open } : { canceled: true, filePaths: [] };
    }) as unknown as typeof dialog.showOpenDialog;
    dialog.showSaveDialog = (async (...a: unknown[]) => {
      g.__fileDialogs.push({ kind: 'save', opts: a[a.length - 1] });
      return r.save ? { canceled: false, filePath: r.save } : { canceled: true };
    }) as unknown as typeof dialog.showSaveDialog;
  }, results);
}

export function shownFileDialogs(
  app: ElectronApplication,
): Promise<{ kind: string; opts: unknown }[]> {
  return app.evaluate(
    () =>
      (globalThis as unknown as { __fileDialogs: { kind: string; opts: unknown }[] }).__fileDialogs,
  );
}

/** Salva una schermata in `BAA_SCREENSHOT_DIR` per un controllo a occhio; con la variabile non impostata non scrive nulla. */
export async function screenshot(page: Page, name: string): Promise<void> {
  const dir = process.env['BAA_SCREENSHOT_DIR'];
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, name) });
}
