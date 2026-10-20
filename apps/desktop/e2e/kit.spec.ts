import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readKitZip } from '@baaportal/s7comm';
import {
  expect,
  launchAppWithRetry,
  removeDir,
  shownFileDialogs,
  stubFileDialogs,
  test,
} from './helpers';

test.setTimeout(30_000);

const here = dirname(fileURLToPath(import.meta.url));
const s7bench = resolve(here, '../../s7bench');

let finto: ChildProcess | undefined;
let port = 0;
let tmp = '';

/** Su Windows uccide l'intero albero; altrove basta il segnale. */
function killTree(p: ChildProcess): void {
  if (p.exitCode !== null || p.signalCode !== null) return;
  if (process.platform === 'win32' && p.pid !== undefined) {
    spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F']);
  } else {
    p.kill('SIGKILL');
  }
}

/** Una porta locale libera, poi chiusa: nessuno ascolta, la connessione viene rifiutata. */
function closedPort(): Promise<number> {
  return new Promise((ok, ko) => {
    const s = createServer();
    s.once('error', ko);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });
}

test.beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'baa-kit-'));
  finto = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', 'finto', '--porta', '0'], {
    cwd: s7bench,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const child = finto;
  port = await new Promise<number>((ok, ko) => {
    let buf = '';
    const timer = setTimeout(() => ko(new Error(`finto non ha stampato la porta: ${buf}`)), 20_000);
    child.stdout!.on('data', (b: Buffer) => {
      buf += b.toString('utf8');
      const m = /^porta (\d+)\r?\n/.exec(buf);
      if (m) {
        clearTimeout(timer);
        ok(Number(m[1]));
      }
    });
    child.once('exit', () => ko(new Error(`finto uscito: ${buf}`)));
  });
});

test.afterAll(() => {
  if (finto) killTree(finto);
  if (tmp) removeDir(tmp);
});

test('raccolta completa contro il finto PLC e zip salvato (stub del dialogo)', async () => {
  const { app, page } = await launchAppWithRetry();
  const out = join(tmp, 'raccolta.zip');
  await stubFileDialogs(app, { save: out });

  // Senza progetto non c'è la barra dei menu: si apre dal portale.
  await page.getByTestId('action-collectCpu').click();
  const dlg = page.getByRole('dialog', { name: 'Raccolta dati CPU (sola lettura)' });
  await expect(dlg).toBeVisible();
  await expect(dlg.getByText('Questa funzione legge soltanto')).toBeVisible();
  await dlg.getByLabel('Indirizzo IP').fill('127.0.0.1');
  await dlg.getByText('Avanzate').click();
  await dlg.getByLabel('Porta').fill(String(port));
  await dlg.getByRole('button', { name: 'Avvia' }).click();

  await expect(dlg.getByTestId('kit-summary')).toBeVisible({ timeout: 20_000 });
  await expect(dlg.getByTestId('kit-summary')).toContainText('6ES7 315-2EH14-0AB0');
  await expect(dlg.getByTestId('kit-saved')).toContainText(out);

  expect(existsSync(out)).toBe(true);
  const kit = readKitZip(new Uint8Array(readFileSync(out)));
  expect(kit.summary.refusedCount).toBe(0);
  expect(kit.summary.identity?.orderNumber).toBe('6ES7 315-2EH14-0AB0');

  const dialogs = await shownFileDialogs(app);
  const save = dialogs.find((d) => d.kind === 'save');
  const opts = save?.opts as { defaultPath: string; filters: { name: string }[] };
  expect(opts.defaultPath).toMatch(/^raccolta-6ES7_315-2EH14-0AB0-\d{8}-\d{4}\.zip$/);
  expect(opts.filters[0]?.name).toBe('Archivio zip');

  await dlg.getByRole('button', { name: 'Chiudi' }).click();
  await expect(dlg).toHaveCount(0);
});

test("IP irraggiungibile: messaggio chiaro in pochi secondi, l'app resta usabile", async () => {
  const { app, page } = await launchAppWithRetry();
  const out = join(tmp, 'chiusa.zip');
  await stubFileDialogs(app, { save: out });
  const closed = await closedPort();

  await page.getByTestId('link-project-view').click();
  await expect(page.getByTestId('menu-bar')).toBeVisible();
  await page.getByRole('menuitem', { name: 'Strumenti' }).click();
  await page.getByRole('menuitem', { name: 'Raccolta dati CPU (sola lettura)…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Raccolta dati CPU (sola lettura)' });
  await dlg.getByLabel('Indirizzo IP').fill('127.0.0.1');
  await dlg.getByText('Avanzate').click();
  await dlg.getByLabel('Porta').fill(String(closed));
  await dlg.getByRole('button', { name: 'Avvia' }).click();

  await expect(dlg.getByRole('alert')).toContainText('La CPU non ha risposto', { timeout: 10_000 });
  await expect(dlg.getByText(/Errori: [1-9]/)).toBeVisible();

  await dlg.getByRole('button', { name: 'Chiudi' }).click();
  await expect(dlg).toHaveCount(0);
  // L'app resta usabile: i menu rispondono.
  await page.getByRole('menuitem', { name: 'Progetto' }).click();
  await expect(page.getByRole('menuitem', { name: 'Nuovo…' })).toBeVisible();
});
