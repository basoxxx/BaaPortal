import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { listen, type ListeningCpu } from '@baaportal/s7-server/node';
import { SimCpu, simBackend } from '@baaportal/sim';
import { expect, launchApp, mod, removeDir, test, writeFixtureProject } from './helpers';

// Piano 3B sull'app costruita: carica nel dispositivo, confronto, comandi della CPU e carica dal
// dispositivo contro il PLC di prova (server S7 locale con CPU simulata, avviato qui nel processo del
// test). Le conferme native sono pilotate da BAAPORTAL_E2E_CONFIRM (solo app non impacchettata).
// Non sostituisce la prova su una CPU reale.
test.setTimeout(120_000);

let tmp: string;
test.beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'baa-t3b-'));
});
test.afterEach(() => {
  removeDir(tmp);
});

async function startPlc(): Promise<{ cpu: SimCpu; server: ListeningCpu }> {
  const cpu = new SimCpu({
    cpuTypeId: 'cpu-315-2-pn-dp',
    props: {
      maxCycleMs: 150,
      minCycleMs: 0,
      clockMemory: { enabled: false, byte: 0 },
      retentivity: { mBytes: 16, timers: 0, counters: 8 },
      cyclicInterruptMs: 0,
    },
  });
  cpu.run();
  const server = await listen(simBackend(cpu), { host: '127.0.0.1', port: 0 });
  return { cpu, server };
}

/** Progetto con la sola OB1 (`A I 0.0` / `= Q 4.0`). */
function writeProject(file: string): void {
  writeFixtureProject(file, (dev) => {
    dev.blocks = dev.blocks.filter((b) => b.kind === 'OB' && b.number === 1);
    const ob = dev.blocks[0];
    if (!ob || ob.kind === 'DB' || ob.kind === 'IDB') throw new Error('OB1 mancante');
    ob.networks[0]!.source = 'A I 0.0\n= Q 4.0';
  });
}

const ob1 = (page: Page) =>
  page.locator('[data-testid^="tree-node-plc:"]', { hasText: '[OB1]' }).first();
const badge = (page: Page) => ob1(page).locator('svg[data-compare]');

/** Dialogo «Dispositivi accessibili»: aggiunge l'indirizzo manuale e lascia la selezione fatta. */
async function addAddress(page: Page, port: number) {
  const dialog = page.getByTestId('dialog-access-devices');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Indirizzo manuale', { exact: true }).fill(`127.0.0.1:${port}`);
  await dialog.getByRole('button', { name: 'Aggiungi indirizzo', exact: true }).click();
  return dialog;
}

async function connect(page: Page, port: number): Promise<void> {
  await page.getByRole('button', { name: 'Dispositivi accessibili…', exact: true }).click();
  const dialog = await addAddress(page, port);
  await dialog.getByRole('button', { name: 'Collega', exact: true }).click();
  await expect(page.getByTestId('plc-indicator')).toContainText('Online:');
}

async function menuCommand(page: Page, menu: string, item: string | RegExp): Promise<void> {
  await page.getByTestId('menu-bar').getByRole('menuitem', { name: menu, exact: true }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

test('Piano 3B: carica nel dispositivo, confronto, STOP/RUN, editor di confronto e carica dal dispositivo', async () => {
  const { server } = await startPlc();
  try {
    const file = join(tmp, 'scrittura.baap');
    writeProject(file);
    const { page } = await launchApp({ args: [file], env: { BAAPORTAL_E2E_CONFIRM: 'yes' } });
    await page.getByTestId('link-project-view').click();
    await expect(page.getByTestId('menu-bar')).toBeVisible();
    await connect(page, server.port);

    // confronto: la CPU è vuota, OB1 è solo nel progetto
    await expect(badge(page)).toHaveAttribute('data-compare', 'offlineOnly');

    // carica nel dispositivo: anteprima, avviso RUN, conferma nativa (simulata)
    await page.getByRole('button', { name: 'Carica nel dispositivo', exact: true }).click();
    const preview = page.getByTestId('download-preview');
    await expect(preview).toBeVisible();
    await expect(preview.getByTestId('download-run-warning')).toBeVisible();
    await preview.getByTestId('download-ok').click();
    await expect(preview.getByTestId('download-result')).toContainText('Caricamento completato');
    await preview.getByTestId('download-cancel').click();
    await expect(preview).toHaveCount(0);

    // dopo il caricamento il confronto riparte da solo: uguale
    await expect(badge(page)).toHaveAttribute('data-compare', 'same');

    // STOP, poi RUN: i LED seguono
    await page.getByTestId('taskcard-tab-test').click();
    await page.getByTestId('cpu-stop').click();
    await expect(page.getByTestId('led-stop')).toHaveAttribute('data-on', 'true', {
      timeout: 5_000,
    });
    await expect(page.getByTestId('led-run')).toHaveAttribute('data-on', 'false');
    await page.getByTestId('cpu-run').click();
    await expect(page.getByTestId('led-run')).toHaveAttribute('data-on', 'true', {
      timeout: 5_000,
    });
    await expect(page.getByTestId('led-stop')).toHaveAttribute('data-on', 'false');

    // modifica di OB1: il confronto dà «diverso» e l'editor di confronto mostra la riga cambiata
    await ob1(page).dblclick();
    const code = page.getByRole('region', { name: 'Segmento 1' }).locator('.cm-content');
    await code.click();
    await page.keyboard.press(`${mod}+a`);
    await page.keyboard.insertText('A I 0.0\n= Q 4.1');
    await page.getByRole('heading', { name: 'Segmenti' }).click();
    await menuCommand(page, 'Online', 'Confronta con la CPU');
    await expect(badge(page)).toHaveAttribute('data-compare', 'different');

    await ob1(page).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Confronta online/offline' }).click();
    const view = page.getByTestId('compare-view');
    await expect(view).toBeVisible();
    await expect(
      view.locator('[data-diff="changed"], [data-diff="added"], [data-diff="missing"]'),
    ).not.toHaveCount(0);
    await expect(view).toContainText('= %Q4.1;');
    await expect(view).toContainText('= %Q4.0;');
  } finally {
    await server.close();
  }
});

test('Piano 3B: carica dal dispositivo crea un progetto nuovo con OB1 in AWL, uguale alla CPU', async () => {
  const { server } = await startPlc();
  try {
    // 1. un progetto carica OB1 nella CPU di prova
    const file = join(tmp, 'origine.baap');
    writeProject(file);
    const first = await launchApp({ args: [file], env: { BAAPORTAL_E2E_CONFIRM: 'yes' } });
    await first.page.getByTestId('link-project-view').click();
    await connect(first.page, server.port);
    await first.page.getByRole('button', { name: 'Carica nel dispositivo', exact: true }).click();
    const preview = first.page.getByTestId('download-preview');
    await preview.getByTestId('download-ok').click();
    await expect(preview.getByTestId('download-result')).toContainText('Caricamento completato');
    await first.app.close();

    // 2. un'altra app, dal portale: «Carica dal dispositivo»
    const { page } = await launchApp();
    await page.getByTestId('action-uploadDevice').click();
    const dialog = await addAddress(page, server.port);
    await dialog.getByRole('button', { name: 'Carica dal dispositivo', exact: true }).click();
    await expect(page.getByTestId('menu-bar')).toBeVisible({ timeout: 30_000 });
    await ob1(page).dblclick();
    await expect(
      page.getByRole('region', { name: 'Segmento 1' }).locator('.cm-content'),
    ).toContainText('= %Q4.0;');

    // 3. il confronto del progetto nuovo con la CPU dà «uguale»
    await connect(page, server.port);
    await expect(badge(page)).toHaveAttribute('data-compare', 'same');
  } finally {
    await server.close();
  }
});

test('Piano 3B: con la conferma negata il caricamento non cambia la CPU', async () => {
  const { server } = await startPlc();
  try {
    const file = join(tmp, 'negata.baap');
    writeProject(file);
    const { page } = await launchApp({ args: [file], env: { BAAPORTAL_E2E_CONFIRM: 'no' } });
    await page.getByTestId('link-project-view').click();
    await connect(page, server.port);
    await expect(badge(page)).toHaveAttribute('data-compare', 'offlineOnly');

    await page.getByRole('button', { name: 'Carica nel dispositivo', exact: true }).click();
    const preview = page.getByTestId('download-preview');
    await preview.getByTestId('download-ok').click();
    await expect(preview.getByTestId('download-result')).toContainText('annullato');
    await preview.getByTestId('download-cancel').click();

    // la CPU è come prima: confronto di nuovo «solo nel progetto»
    await menuCommand(page, 'Online', 'Confronta con la CPU');
    await expect(badge(page)).toHaveAttribute('data-compare', 'offlineOnly');
  } finally {
    await server.close();
  }
});
