import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { syntheticSdb } from '@baaportal/s7-server';
import { listen, type ListeningCpu } from '@baaportal/s7-server/node';
import { addWatchTable, createGlobalDb, createWatchRow, decodeBackup } from '@baaportal/project';
import { SimCpu, simBackend } from '@baaportal/sim';
import { expect, launchApp, removeDir, test, writeFixtureProject } from './helpers';

// Piano 3C sull'app costruita: «Online e diagnostica», tabelle di controllo online e backup online
// contro il PLC di prova (server S7 locale con CPU simulata, avviato qui nel processo del test). Le
// conferme native sono pilotate da BAAPORTAL_E2E_CONFIRM e il file di backup da
// BAAPORTAL_E2E_SAVE_PATH (solo app non impacchettata). Non sostituisce la prova su una CPU reale.
test.setTimeout(120_000);

let tmp: string;
test.beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'baa-t3c-'));
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
  const server = await listen(
    simBackend(cpu, { systemBlocks: [syntheticSdb(0, 64), syntheticSdb(1, 64)] }),
    { host: '127.0.0.1', port: 0 },
  );
  return { cpu, server };
}

/** Progetto con OB1, DB1 (una parola) e una tabella di controllo con MW 10, DB1.DBW 0 e PQW 0. */
function writeProject(file: string): void {
  writeFixtureProject(file, (dev) => {
    dev.blocks = dev.blocks.filter((b) => b.kind === 'OB' && b.number === 1);
    const ob = dev.blocks[0];
    if (!ob || ob.kind === 'DB' || ob.kind === 'IDB') throw new Error('OB1 mancante');
    ob.networks[0]!.source = 'A I 0.0\n= Q 4.0';
    const db = createGlobalDb({ number: 1, name: 'Dati' });
    db.members.push({ id: 'm-w', name: 'Parola', type: 'Int', comment: '' });
    dev.blocks.push(db);
    const t = addWatchTable(dev, 'Controllo', () => 'wt-controllo');
    t.rows.push({ ...createWatchRow('MW 10', 'DEC', () => 'wr1'), modify: '42' });
    t.rows.push(createWatchRow('DB1.DBW 0', 'DEC', () => 'wr2'));
    t.rows.push(createWatchRow('PQW 0', 'DEC', () => 'wr3'));
  });
}

async function connect(page: Page, port: number): Promise<void> {
  await page.getByRole('button', { name: 'Dispositivi accessibili…', exact: true }).click();
  const dialog = page.getByTestId('dialog-access-devices');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Indirizzo manuale', { exact: true }).fill(`127.0.0.1:${port}`);
  await dialog.getByRole('button', { name: 'Aggiungi indirizzo', exact: true }).click();
  await dialog.getByRole('button', { name: 'Collega', exact: true }).click();
  await expect(page.getByTestId('plc-indicator')).toContainText('Online:');
}

const node = (page: Page, text: string | RegExp) =>
  page.locator('[data-testid^="tree-node-"]', { hasText: text }).first();

async function openDiag(page: Page): Promise<void> {
  await node(page, 'Online e diagnostica').dblclick();
  await expect(page.getByTestId('diag-view')).toBeVisible();
}

test('Piano 3C: diagnostica, ora, tabella di controllo online e backup', async () => {
  const { server } = await startPlc();
  try {
    const file = join(tmp, 'diagnostica.baap');
    const backup = join(tmp, 'copia.baapbak');
    writeProject(file);
    const { page } = await launchApp({
      args: [file],
      env: { BAAPORTAL_E2E_CONFIRM: 'yes', BAAPORTAL_E2E_SAVE_PATH: backup },
    });
    await page.getByTestId('link-project-view').click();
    await expect(page.getByTestId('menu-bar')).toBeVisible();
    await connect(page, server.port);

    // il programma va nella CPU, così il backup ha un OB1 da copiare
    await page.getByRole('button', { name: 'Carica nel dispositivo', exact: true }).click();
    const preview = page.getByTestId('download-preview');
    await preview.getByTestId('download-ok').click();
    await expect(preview.getByTestId('download-result')).toContainText('Caricamento completato');
    await preview.getByTestId('download-cancel').click();

    // Generale: numero d'ordine, modo RUN, LED RUN acceso
    await openDiag(page);
    await page.getByTestId('diag-page-general').click();
    await expect(page.getByTestId('diag-general')).toContainText('6ES7 315-2EH14-0AB0');
    await expect(page.getByTestId('diag-mode')).toHaveText('RUN');
    await expect(page.getByTestId('diag-led-RUN')).toHaveAttribute('data-on', 'true');

    // STOP (conferma sì): in testa al buffer c'è l'evento; poi RUN
    await page.getByTestId('taskcard-tab-test').click();
    await page.getByTestId('cpu-stop').click();
    await expect(page.getByTestId('diag-mode')).toHaveText('STOP', { timeout: 10_000 });
    await page.getByTestId('diag-page-buffer').click();
    await expect(page.getByTestId('diag-row-0')).toContainText('STOP dal PG o da SFB 20', {
      timeout: 10_000,
    });
    await page.getByTestId('cpu-run').click();
    await expect(page.getByTestId('diag-mode')).toHaveText('RUN', { timeout: 10_000 });

    // tempo di ciclo: tre valori in ms; memoria di lavoro
    await page.getByTestId('diag-page-cycle').click();
    await expect(page.getByTestId('cycle-last')).toContainText('ms');
    await expect(
      page.getByTestId('diag-cycle').locator('dd').filter({ hasText: /ms$/ }),
    ).toHaveCount(4);
    await page.getByTestId('diag-page-memory').click();
    await expect(page.getByTestId('diag-memory')).toContainText('Memoria di lavoro');

    // Imposta ora a mano: 2030-01-01 12:00:00
    await page.getByTestId('diag-page-clock').click();
    await page.getByTestId('clock-date').fill('2030-01-01');
    await page.getByTestId('clock-time').fill('12:00:00');
    await page.getByTestId('clock-apply').click();
    await expect(page.getByTestId('clock-cpu')).toHaveText(/^01\/01\/2030 12:00:0[0-9]$/, {
      timeout: 10_000,
    });

    // tabella di controllo online
    await node(page, /^Controllo/).dblclick();
    await page.getByRole('button', { name: 'Osserva tutto', exact: true }).click();
    await expect(page.getByTestId('watch-bar')).toContainText('Osservazione attiva');
    await expect(page.getByRole('row', { name: /PQW 0/ })).toContainText('non disponibile online', {
      timeout: 10_000,
    });
    await page.getByRole('button', { name: 'Comanda', exact: true }).click();
    // valore di comando e valore di stato di MW 10 valgono entrambi 42
    await expect(page.getByText('42', { exact: true })).toHaveCount(2, { timeout: 10_000 });

    // backup online: il file esiste e contiene OB1 e gli SDB 0 e 1
    await page
      .getByTestId('menu-bar')
      .getByRole('menuitem', { name: 'Online', exact: true })
      .click();
    await page.getByRole('menuitem', { name: /Carica backup dal dispositivo online/ }).click();
    await expect.poll(() => existsSync(backup), { timeout: 30_000 }).toBe(true);
    await expect(page.getByText(/Backup salvato in/)).toBeVisible({ timeout: 30_000 });
    const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
    const { manifest } = decodeBackup(new Uint8Array(readFileSync(backup)), sha);
    const has = (type: string, number: number) =>
      manifest.blocks.some((b) => b.type === type && b.number === number);
    expect(has('OB', 1)).toBe(true);
    expect(has('SDB', 0)).toBe(true);
    expect(has('SDB', 1)).toBe(true);
  } finally {
    await server.close();
  }
});

test('Piano 3C: con la conferma negata l’ora e MW 10 non cambiano', async () => {
  const { cpu, server } = await startPlc();
  try {
    const file = join(tmp, 'negata.baap');
    writeProject(file);
    const { page } = await launchApp({ args: [file], env: { BAAPORTAL_E2E_CONFIRM: 'no' } });
    await page.getByTestId('link-project-view').click();
    await expect(page.getByTestId('menu-bar')).toBeVisible();
    await connect(page, server.port);

    await openDiag(page);
    await page.getByTestId('diag-page-clock').click();
    await page.getByTestId('clock-date').fill('2030-01-01');
    await page.getByTestId('clock-time').fill('12:00:00');
    await page.getByTestId('clock-apply').click();
    await page.waitForTimeout(2_500);
    await expect(page.getByTestId('clock-cpu')).not.toContainText('2030');

    await node(page, /^Controllo/).dblclick();
    await page.getByRole('button', { name: 'Comanda', exact: true }).click();
    await page.waitForTimeout(1_500);
    expect(cpu.memory.M[10]).toBe(0);
    expect(cpu.memory.M[11]).toBe(0);
  } finally {
    await server.close();
  }
});
