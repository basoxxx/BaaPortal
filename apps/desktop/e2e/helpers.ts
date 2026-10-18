import { spawn } from 'node:child_process';
import electronPath from 'electron';
import { _electron, test as base, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Launched {
  app: ElectronApplication;
  page: Page;
  userData: string;
}

const launched: Launched[] = [];

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
        await l.app.close().catch(() => undefined);
        rmSync(l.userData, { recursive: true, force: true });
      }
    },
    { auto: true },
  ],
});
export { expect } from '@playwright/test';

/** `cwd`: cartella da cui avviare Electron; lo script principale `out/main/index.js` si risolve da lì. */
export async function launchApp(opts: { args?: string[]; cwd?: string } = {}): Promise<Launched> {
  const userData = mkdtempSync(join(tmpdir(), 'baa-userdata-'));
  // Con un timeout proprio, un avvio bloccato fallisce riportando nel call log l'uscita del processo.
  const app = await _electron.launch({
    args: ['out/main/index.js', ...(opts.args ?? [])],
    cwd: opts.cwd,
    env: { ...process.env, BAA_USER_DATA: userData },
    timeout: 15_000,
  });
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
      await app.close().catch(() => undefined);
      rmSync(userData, { recursive: true, force: true });
    }
    const where = page ? `pagina: ${page.url()}` : 'nessuna finestra';
    throw new Error(`l'app non si è mostrata (${where})\n${log.join('\n')}`, { cause: e });
  }
  return { app, page, userData };
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
