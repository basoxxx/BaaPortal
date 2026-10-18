import { mkdtempSync, readFileSync } from 'node:fs';
import { readBaap } from '@baaportal/project';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import {
  expect,
  launchApp,
  mod,
  shownDialogs,
  stubMessageBox,
  test,
  windowCount,
  writeFixtureProject,
  removeDir,
} from './helpers';

let tmp: string;
test.beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'baa-det-'));
});
test.afterEach(() => {
  removeDir(tmp);
});

/** Apre l'editor della tabella standard e lo stacca in una finestra separata; restituisce la nuova pagina. */
async function detachTable(app: ElectronApplication, page: Page): Promise<Page> {
  await page
    .locator('[data-testid^="tree-node-plc:"]', { hasText: 'Tabella delle variabili standard' })
    .dblclick();
  const opened = app.waitForEvent('window');
  await page.getByRole('button', { name: 'Apri in una finestra separata' }).click();
  const detached = await opened;
  await detached.waitForLoadState('domcontentloaded');
  return detached;
}

async function renameFirstTag(page: Page, name: string): Promise<void> {
  const cell: Locator = page
    .getByRole('grid')
    .locator('[data-row-key]:not([data-row-key*="add:"])')
    .first()
    .locator('[data-col-id="name"]');
  await cell.click();
  await cell.press('Enter');
  const input = cell.locator('input');
  await input.fill(name);
  await input.press('Enter');
  await expect(input).toHaveCount(0);
}

test('editor in finestra separata: modifica visibile nella principale, annulla, riporta nell’area di lavoro', async () => {
  const file = join(tmp, 'det.baap');
  writeFixtureProject(file, (dev) => {
    dev.tagTables[0]!.tags.push({
      id: crypto.randomUUID(),
      name: 'Motore',
      type: 'Bool',
      address: '%M0.0',
      hmi: true,
      comment: '',
    });
  });
  const { app, page } = await launchApp({ args: [file] });
  await page.getByTestId('link-project-view').click();

  // 1. Due finestre
  const detached = await detachTable(app, page);
  await expect.poll(() => windowCount(app)).toBe(2);
  await expect(page.locator('[data-testid^="editor-frame-"]')).toHaveCount(0);

  // 2. Un nome cambiato nella finestra separata compare nella vista dettagli della principale
  await renameFirstTag(detached, 'Pompa');
  const details = page.getByTestId('details-row');
  await expect(details).toContainText('Pompa');

  // 3. Mod+Z nella principale lo annulla
  await page.locator('[data-testid^="tree-node-plc:"]', { hasText: 'Mostra tutte' }).click();
  await page
    .locator('[data-testid^="tree-node-plc:"]', { hasText: 'Tabella delle variabili standard' })
    .click();
  await page.keyboard.press(`${mod}+z`);
  await expect(details).toContainText('Motore');
  await expect(details).not.toContainText('Pompa');

  // 4. Chiusa la finestra separata, l'editor torna nell'area di lavoro
  await detached.close();
  await expect.poll(() => windowCount(app)).toBe(1);
  await expect(page.locator('[data-testid^="editor-frame-"]')).toHaveCount(1);
  await expect(page.getByRole('grid')).toBeVisible();

  // 5. Un'altra finestra separata e chiusura della principale con "Non salvare": non resta nulla
  const again = await detachTable(app, page);
  await renameFirstTag(again, 'Valvola');
  await expect.poll(() => windowCount(app)).toBe(2);

  // Le scorciatoie funzionano anche con il focus nella finestra separata (fuori dai campi di testo)
  await again.getByRole('grid').locator('[data-row-key]').first().locator('[data-rownum]').click();
  await again.keyboard.press(`${mod}+s`);
  await expect
    .poll(() => {
      try {
        return readBaap(readFileSync(file)).devices[0]?.tagTables[0]?.tags[0]?.name;
      } catch {
        return undefined;
      }
    })
    .toBe('Valvola');
  await again.keyboard.press(`${mod}+z`);
  await expect(page.getByTestId('details-row')).toContainText('Motore');

  // La principale è l'unica pagina dell'app: le finestre separate sono about:blank
  const closeMain = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().startsWith('file:'))
        ?.close(),
    );
  await stubMessageBox(app, 2); // Annulla: la richiesta compare e le finestre restano
  await closeMain();
  await expect.poll(() => shownDialogs(app)).toHaveLength(1);
  expect(await windowCount(app)).toBe(2);
  await stubMessageBox(app, 1); // Non salvare
  const closed = app.waitForEvent('close');
  await closeMain();
  await closed;
  expect(app.windows()).toHaveLength(0);
});

/** Avvia la modifica del nome del primo tag nella finestra separata e scrive senza confermare. */
async function typeFirstTagName(page: Page, name: string): Promise<Locator> {
  const cell = page
    .getByRole('grid')
    .locator('[data-row-key]:not([data-row-key*="add:"])')
    .first()
    .locator('[data-col-id="name"]');
  await cell.click();
  await cell.press('Enter');
  const input = cell.locator('input');
  await input.fill(name);
  await expect(input).toBeFocused();
  return input;
}

const savedFirstTag = (file: string) => {
  try {
    return readBaap(readFileSync(file)).devices[0]?.tagTables[0]?.tags[0]?.name;
  } catch {
    return undefined;
  }
};

test('Mod+S con una cella in modifica nella finestra separata salva il testo scritto', async () => {
  const file = join(tmp, 'det-save.baap');
  writeFixtureProject(file, (dev) => {
    dev.tagTables[0]!.tags.push({
      id: crypto.randomUUID(),
      name: 'Motore',
      type: 'Bool',
      address: '%M0.0',
      hmi: true,
      comment: '',
    });
  });
  const { app, page } = await launchApp({ args: [file] });
  await page.getByTestId('link-project-view').click();
  const detached = await detachTable(app, page);
  const input = await typeFirstTagName(detached, 'Pompa');
  await input.press(`${mod}+s`);
  await expect.poll(() => savedFirstTag(file)).toBe('Pompa');
});

test('chiudere la finestra separata con la X mentre una cella è in modifica conserva la bozza', async () => {
  const file = join(tmp, 'det-close.baap');
  writeFixtureProject(file, (dev) => {
    dev.tagTables[0]!.tags.push({
      id: crypto.randomUUID(),
      name: 'Motore',
      type: 'Bool',
      address: '%M0.0',
      hmi: true,
      comment: '',
    });
  });
  const { app, page } = await launchApp({ args: [file] });
  await page.getByTestId('link-project-view').click();
  const detached = await detachTable(app, page);
  await typeFirstTagName(detached, 'Pompa');
  // Come il pulsante di chiusura della finestra: la pagina riceve beforeunload.
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => !w.webContents.getURL().startsWith('file:'))
      ?.close(),
  );
  await expect.poll(() => windowCount(app)).toBe(1);
  const name = page
    .getByRole('grid')
    .locator('[data-row-key]:not([data-row-key*="add:"])')
    .first()
    .locator('[data-col-id="name"]');
  await expect(name).toHaveText('Pompa');
});
