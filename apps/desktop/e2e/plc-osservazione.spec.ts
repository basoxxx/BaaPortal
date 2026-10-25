import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { connectTcp } from '@baaportal/s7comm/node';
import { decodeBackup } from '@baaportal/project';
import { startTestPlc } from '../src/main/plc/testPlc';
import { expect, launchApp, mod, removeDir, test, writeFixtureProject } from './helpers';

// Piano 3D sull'app costruita: osservazione del blocco sulla CPU, impostazione sperimentale e
// ripristino di un backup, contro il PLC di prova (avviato qui, nel processo di Playwright). Le
// conferme native e i file sono pilotati da BAAPORTAL_E2E_CONFIRM, _SAVE_PATH e _OPEN_PATH (solo app
// non impacchettata). Non sostituisce la prova su una CPU reale.
test.setTimeout(150_000);

let tmp: string;
test.beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'baa-t3d-'));
});
test.afterEach(() => {
  removeDir(tmp);
});

/** Il PLC di prova parte solo con la variabile; la si toglie subito perché l'app lanciata non ne avvii un altro. */
async function startPlc() {
  process.env['BAAPORTAL_TEST_PLC'] = '1';
  try {
    return await startTestPlc();
  } finally {
    delete process.env['BAAPORTAL_TEST_PLC'];
  }
}

function writeProject(file: string): void {
  writeFixtureProject(file, (dev) => {
    dev.blocks = dev.blocks.filter((b) => b.kind === 'OB' && b.number === 1);
    const ob = dev.blocks[0];
    if (!ob || ob.kind === 'DB' || ob.kind === 'IDB') throw new Error('OB1 mancante');
    ob.networks[0]!.source = 'L 5\nT MW 10';
  });
}

const ob1 = (page: Page) =>
  page.locator('[data-testid^="tree-node-plc:"]', { hasText: '[OB1]' }).first();
const badge = (page: Page) => ob1(page).locator('svg[data-compare]');

async function connect(page: Page, port: number): Promise<void> {
  await page.getByRole('button', { name: 'Dispositivi accessibili…', exact: true }).click();
  const dialog = page.getByTestId('dialog-access-devices');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Indirizzo manuale', { exact: true }).fill(`127.0.0.1:${port}`);
  await dialog.getByRole('button', { name: 'Aggiungi indirizzo', exact: true }).click();
  await dialog.getByRole('button', { name: 'Collega', exact: true }).click();
  await expect(page.getByTestId('plc-indicator')).toContainText('Online:');
}

async function menu(page: Page, name: string): Promise<void> {
  await page.getByTestId('menu-bar').getByRole('menuitem', { name, exact: true }).click();
}
async function menuCommand(page: Page, name: string, item: string | RegExp): Promise<void> {
  await menu(page, name);
  await page.getByRole('menuitem', { name: item }).click();
}

async function downloadAll(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Carica nel dispositivo', exact: true }).click();
  const preview = page.getByTestId('download-preview');
  await preview.getByTestId('download-ok').click();
  await expect(preview.getByTestId('download-result')).toContainText('Caricamento completato');
  await preview.getByTestId('download-cancel').click();
  await expect(badge(page)).toHaveAttribute('data-compare', 'same');
}

async function setOb1(page: Page, source: string): Promise<void> {
  await ob1(page).dblclick();
  const code = page.getByRole('region', { name: 'Segmento 1' }).locator('.cm-content');
  await code.click();
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.insertText(source);
  await page.getByRole('heading', { name: 'Segmenti' }).click();
}

/** Finestra grande e segmento in vista: l'osservazione chiede solo le righe visibili. */
async function showSegment(app: ElectronApplication, page: Page): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w?.setSize(1500, 1000);
  });
  await page.getByRole('region', { name: 'Segmento 1' }).scrollIntoViewIfNeeded();
}

async function setConfirm(app: ElectronApplication, answer: 'yes' | 'no'): Promise<void> {
  await app.evaluate((_e, a) => {
    process.env['BAAPORTAL_E2E_CONFIRM'] = a;
  }, answer);
}

async function enableExperimental(page: Page): Promise<void> {
  await menuCommand(page, 'Opzioni', 'Impostazioni');
  await page.getByTestId('settings-experimental').check();
  await page.getByTestId('dialog-ok').click();
  await expect(page.getByTestId('settings-dialog')).toHaveCount(0);
}

/** Il blocco com'è nella CPU adesso (upload con un collegamento a parte). */
async function cpuOb1(port: number): Promise<Uint8Array> {
  const c = await connectTcp({ host: '127.0.0.1', port, timeoutMs: 3000 });
  try {
    return await c.upload('OB', 1);
  } finally {
    await c.close();
  }
}

test('Piano 3D: osservazione del blocco acceso, spento, a collegamento interrotto e con blocco diverso', async () => {
  const plc = await startPlc();
  try {
    const file = join(tmp, 'osservazione.baap');
    writeProject(file);
    const { app, page } = await launchApp({ args: [file], env: { BAAPORTAL_E2E_CONFIRM: 'yes' } });
    await page.getByTestId('link-project-view').click();
    await expect(page.getByTestId('menu-bar')).toBeVisible();
    await connect(page, plc.port);
    await downloadAll(page);
    // acceso: valori sulla riga, barra di stato, un job 0x13 nel server
    await ob1(page).dblclick();
    await showSegment(app, page);
    const toggle = page.getByRole('button', { name: 'Osserva programma', exact: true });
    await toggle.click();
    await expect(page.getByTestId('monitor-bar')).toContainText('Osservazione attiva');
    await expect(page.getByTestId('plc-monitor-warning')).toContainText('Osservazione attiva');
    await expect(
      page.locator('.baa-mon-cell').filter({ hasText: 'ACCU1 00000005' }),
    ).not.toHaveCount(0, { timeout: 15_000 });
    await expect.poll(async () => (await plc.tisJobs()).length).toBe(1);

    // spento: il job sparisce entro 1 s
    await toggle.click();
    await expect.poll(() => plc.tisJobs(), { timeout: 1_000 }).toEqual([]);

    // di nuovo acceso, poi collegamento interrotto: nessun job rimasto
    await toggle.click();
    await expect.poll(async () => (await plc.tisJobs()).length).toBe(1);
    await menuCommand(page, 'Online', 'Interrompi collegamento online');
    await expect(page.getByTestId('plc-indicator')).toHaveCount(0);
    await expect.poll(() => plc.tisJobs(), { timeout: 5_000 }).toEqual([]);

    // blocco modificato e compilato ma non caricato: messaggio e nessun job
    await connect(page, plc.port);
    await setOb1(page, 'L 6\nT MW 10');
    await menuCommand(page, 'Modifica', 'Compila → Software (solo modifiche)');
    await showSegment(app, page);
    await page.getByRole('button', { name: 'Osserva programma', exact: true }).click();
    await expect(page.getByTestId('monitor-bar')).toContainText('Il blocco nella CPU è diverso');
    expect(await plc.tisJobs()).toEqual([]);
  } finally {
    await plc.close();
  }
});

test('Piano 3D: ripristino di un backup con l’impostazione sperimentale; conferma negata senza effetti', async () => {
  const plc = await startPlc();
  try {
    const file = join(tmp, 'ripristino.baap');
    const backup = join(tmp, 'copia.baapbak');
    writeProject(file);
    const { app, page } = await launchApp({
      args: [file],
      env: {
        BAAPORTAL_E2E_CONFIRM: 'yes',
        BAAPORTAL_E2E_SAVE_PATH: backup,
        BAAPORTAL_E2E_OPEN_PATH: backup,
      },
    });
    await page.getByTestId('link-project-view').click();
    await expect(page.getByTestId('menu-bar')).toBeVisible();
    await connect(page, plc.port);
    await downloadAll(page);
    await enableExperimental(page);

    // 1. backup online (OB1 con L 5)
    await menuCommand(page, 'Online', /Carica backup dal dispositivo online/);
    await expect.poll(() => existsSync(backup), { timeout: 30_000 }).toBe(true);
    await expect(page.getByText(/Backup salvato in/)).toBeVisible({ timeout: 30_000 });
    const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
    const { manifest, files } = decodeBackup(new Uint8Array(readFileSync(backup)), sha);
    const entry = manifest.blocks.find((b) => b.type === 'OB' && b.number === 1)!;
    const inBackup = files[entry.file]!;

    // 2. OB1 cambiato in L 7 e caricato
    await setOb1(page, 'L 7\nT MW 10');
    await downloadAll(page);
    const withL7 = await cpuOb1(plc.port);
    expect(Buffer.from(withL7).equals(Buffer.from(inBackup))).toBe(false);

    // 3. la finestra: OB1, SDB 0 e SDB 1 da caricare
    await menuCommand(page, 'Online', /Ripristina backup nel dispositivo/);
    const dialog = page.getByTestId('restore-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('restore-choose').click();
    const table = dialog.getByTestId('restore-table');
    for (const name of ['OB1', 'SDB 0', 'SDB 1']) {
      await expect(table.locator('tr', { hasText: new RegExp(`^${name}`) })).toContainText(
        'Carica',
      );
    }

    // conferma negata: nessuna modifica, la CPU resta in RUN
    await setConfirm(app, 'no');
    await dialog.getByTestId('restore-run').click();
    await expect(dialog.getByTestId('restore-choose')).toBeVisible();
    await expect(dialog.getByTestId('restore-result')).toHaveCount(0);
    expect(Buffer.from(await cpuOb1(plc.port)).equals(Buffer.from(withL7))).toBe(true);
    await expect(page.getByTestId('plc-indicator')).toContainText('RUN');

    // 4. conferme sì, avvio spento: tutto Caricato e CPU lasciata in STOP
    await setConfirm(app, 'yes');
    await dialog.getByTestId('restore-choose').click();
    await expect(table).toBeVisible();
    await expect(dialog.getByTestId('restore-restart')).not.toBeChecked();
    await dialog.getByTestId('restore-run').click();
    const result = dialog.getByTestId('restore-result');
    await expect(result).toContainText('CPU lasciata in STOP', { timeout: 60_000 });
    await expect(dialog.locator('tr[data-outcome="loaded"]')).toHaveCount(3);
    await dialog.getByTestId('restore-close').click();

    // il confronto dice OB1 diverso dal progetto (L 7); la CPU ha di nuovo il blocco del backup (L 5)
    await expect(badge(page)).toHaveAttribute('data-compare', 'different', { timeout: 15_000 });
    expect(Buffer.from(await cpuOb1(plc.port)).equals(Buffer.from(inBackup))).toBe(true);
  } finally {
    await plc.close();
  }
});

test('Piano 3D: con l’impostazione spenta il ripristino è disabilitato e gli stack rimandano alle impostazioni', async () => {
  const plc = await startPlc();
  try {
    const file = join(tmp, 'spenta.baap');
    writeProject(file);
    const { page } = await launchApp({ args: [file], env: { BAAPORTAL_E2E_CONFIRM: 'yes' } });
    await page.getByTestId('link-project-view').click();
    await expect(page.getByTestId('menu-bar')).toBeVisible();
    await connect(page, plc.port);

    await menu(page, 'Online');
    await expect(
      page.getByRole('menuitem', { name: /Ripristina backup nel dispositivo/ }),
    ).toBeDisabled();
    await page.keyboard.press('Escape');

    await page
      .locator('[data-testid^="tree-node-"]', { hasText: 'Online e diagnostica' })
      .first()
      .dblclick();
    await expect(page.getByTestId('diag-view')).toBeVisible();
    await page.getByTestId('diag-page-stacks').click();
    await expect(page.getByTestId('stacks-off')).toContainText(
      'Attivare le funzioni sperimentali in Opzioni → Impostazioni',
    );
  } finally {
    await plc.close();
  }
});
