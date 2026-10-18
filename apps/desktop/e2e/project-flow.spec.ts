import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createProject,
  launchApp,
  shownDialogs,
  spawnSecondInstance,
  stubMessageBox,
} from './helpers';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
let tmp: string;

test.beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'baa-flow-'));
});
test.afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test('crea, modifica, salva, chiude e riapre dai recenti, con nome non ASCII in cartella con spazi', async () => {
  const dir = join(tmp, 'cartella con spazi');
  const file = join(dir, 'Pressa àè 日本.baap');
  const { app, page } = await launchApp();
  await stubMessageBox(app, 0);

  await createProject(page, 'Pressa àè 日本', dir);
  await page.getByRole('button', { name: 'Apri la vista progetto' }).first().click();
  await expect(page.getByTestId('menu-bar')).toBeVisible();
  expect(existsSync(file)).toBe(true);

  await page.getByTestId('tree-node-project').click();
  const author = page.getByTestId('panel-inspector').getByLabel('Autore');
  await author.fill('Collaudo');
  await page.keyboard.press(`${mod}+s`);
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle()))
    .toBe(`BaaPortal - ${file}`);

  await page
    .getByTestId('menu-bar')
    .getByRole('menuitem', { name: 'Progetto', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Chiudi', exact: true }).click();
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle()))
    .toBe('BaaPortal');
  expect(await shownDialogs(app)).toEqual([]); // salvato: nessuna richiesta di conferma

  await page.getByTestId('portal-start').click();
  await page.getByTestId('action-open').click();
  await page.getByTestId('selection-pane').getByRole('row').nth(1).dblclick();

  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle()))
    .toBe(`BaaPortal - ${file}`);
  await page.getByTestId('link-project-view').click();
  await page.getByTestId('tree-node-project').click();
  await expect(page.getByTestId('panel-inspector').getByLabel('Autore')).toHaveValue('Collaudo');
  await app.close();
});

test("chiusura finestra con modifiche e Annulla: l'app resta aperta", async () => {
  const dir = join(tmp, 'p');
  const { app, page } = await launchApp();
  await stubMessageBox(app, 2);
  await createProject(page, 'Pressa', dir);
  await page.getByRole('button', { name: 'Apri la vista progetto' }).first().click();
  await page.getByTestId('tree-node-project').click();
  await page.getByTestId('panel-inspector').getByLabel('Autore').fill('Modificato');

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await expect.poll(() => shownDialogs(app)).toHaveLength(1);

  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  await expect(page.getByTestId('panel-inspector').getByLabel('Autore')).toHaveValue('Modificato');
  await expect(page.getByTestId('status-bar')).toBeVisible();
  await app.close();
});

test("file .baap danneggiato: messaggio d'errore e app utilizzabile", async () => {
  mkdirSync(tmp, { recursive: true });
  const broken = join(tmp, 'rotto.baap');
  writeFileSync(broken, 'xx');
  const { app, page, userData } = await launchApp();
  await stubMessageBox(app, 0);
  // Il file arriva da una seconda istanza (stessa via della riga di comando) con il dialogo già sostituito.
  await spawnSecondInstance(userData, broken);

  await expect.poll(() => shownDialogs(app)).toHaveLength(1);
  expect((await shownDialogs(app))[0]).toContain('non è un progetto BaaPortal valido');
  expect(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle()),
  ).toBe('BaaPortal');

  await createProject(page, 'Dopo', join(tmp, 'ok'));
  await expect(page.getByTestId('open-project-info')).toContainText('Dopo.baap');
  await app.close();
});
