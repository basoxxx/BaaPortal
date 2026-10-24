import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import {
  addBlock,
  addCpu,
  createProject,
  expect,
  firstDeviceId,
  launchApp,
  mainTitle,
  openProjectView,
  removeDir,
  test,
} from './helpers';

// Spec §9, Tappa 1 ("Fatto quando"): nell'app impacchettata, usando solo l'interfaccia, si crea un
// progetto con CPU, OB1, FB + DB di istanza, FC, DB globale e tabella variabili; si compila tutto
// senza errori, si salva, si chiude, si riapre dai recenti e si ricompila senza errori.
test.setTimeout(90_000);

let tmp: string;
test.beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'baa-t1-'));
});
test.afterEach(() => {
  removeDir(tmp);
});

const grid = (page: Page) => page.getByRole('grid').first();
const treeNode = (page: Page, text: string) =>
  page.locator('[data-testid^="tree-node-plc:"]', { hasText: text }).first();

async function typeCell(cell: Locator, text: string): Promise<void> {
  await cell.click();
  await cell.press('Enter');
  const input = cell.locator('input');
  await input.fill(text);
  await input.press('Enter');
  await expect(input).toHaveCount(0);
}

/** Compilazione completa dal menu contestuale del PLC; attende l'esito nella scheda Compila. */
async function compileAll(page: Page, dev: string, blocks: number): Promise<void> {
  await page.getByTestId(`tree-node-plc:${dev}`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Compila → Software (compilazione completa)' }).click();
  const summary = page.getByTestId('compile-summary');
  await expect(summary).toHaveText(
    `Compilazione terminata: ${blocks} blocchi, 0 errori, 0 avvisi`,
    { timeout: 30_000 },
  );
  await expect(page.locator('[data-testid="compile-row"][data-status="error"]')).toHaveCount(0);
}

test('Tappa 1: crea, compila, salva, chiude, riapre dai recenti e ricompila', async () => {
  const dir = join(tmp, 'Impianto');
  const file = join(dir, 'Impianto.baap');
  const { app, page } = await launchApp();
  await createProject(page, 'Impianto', dir);
  await openProjectView(page);

  await addCpu(page);
  const dev = await firstDeviceId(page);

  // tabella delle variabili con 3 variabili
  await treeNode(page, 'Tabella delle variabili standard').dblclick();
  for (const name of ['Motore', 'Sensore', 'Pulsante']) {
    await typeCell(grid(page).locator('[data-row-key$="add:0"] [data-col-id="name"]'), name);
  }
  await expect(grid(page).locator('[data-row-key]:not([data-row-key*="add:"])')).toHaveCount(3);

  // FB + DB di istanza, FC, DB globale (OB1 "Main" c'è già)
  await addBlock(page, dev, { kind: 'FB', name: 'Nastro' });
  await addBlock(page, dev, { kind: 'DB', name: 'Nastro_DB', instanceOf: 'Nastro' });
  await addBlock(page, dev, { kind: 'FC', name: 'Calcolo' });
  await addBlock(page, dev, { kind: 'DB', name: 'Dati_globali' });
  const expected = [
    'Main [OB',
    'Nastro [FB',
    'Nastro_DB [DB',
    'Calcolo [FC',
    'Dati_globali [DB',
    'Tabella delle variabili standard',
  ];
  for (const n of expected) await expect(treeNode(page, n)).toBeVisible();

  await compileAll(page, dev, 5);

  // salva, chiude, riapre dai recenti
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+s`);
  await page
    .getByTestId('menu-bar')
    .getByRole('menuitem', { name: 'Progetto', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Chiudi', exact: true }).click();
  await expect.poll(() => mainTitle(app)).toBe('BaaPortal');
  await page.getByTestId('portal-start').click();
  await page.getByTestId('action-open').click();
  await page.getByTestId('selection-pane').getByRole('row').nth(1).dblclick();
  await expect.poll(() => mainTitle(app)).toBe(`BaaPortal - ${file}`);
  await page.getByTestId('link-project-view').click();

  for (const n of expected) await expect(treeNode(page, n)).toBeVisible();
  await treeNode(page, 'Tabella delle variabili standard').dblclick();
  await expect(grid(page).locator('[data-row-key]:not([data-row-key*="add:"])')).toHaveCount(3);

  // Seconda compilazione con Ctrl+B (dopo la riapertura la sessione non ricorda nulla: compila tutto).
  await page.getByTestId(`tree-node-plc:${await firstDeviceId(page)}`).click();
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+b`);
  await expect(page.getByTestId('compile-summary')).toHaveText(
    'Compilazione terminata: 5 blocchi, 0 errori, 0 avvisi',
    { timeout: 30_000 },
  );
  await app.close();
});
