import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { createCodeBlock, readBaap, readBaapz, type Project } from '@baaportal/project';
import {
  expect,
  firstDeviceId,
  launchApp,
  mainTitle,
  mod,
  removeDir,
  stubFileDialogs,
  stubMessageBox,
  test,
  writeFixtureProject,
} from './helpers';

// Funzioni della tappa 1F usate dall'interfaccia: esporta/importa variabili (csv e xlsx), archivia e
// ritira, progetto di riferimento, trova e sostituisci, impostazioni.
// I dialoghi nativi si guidano sostituendo dialog.showOpenDialog/showSaveDialog nel processo
// principale (stubFileDialogs / openDialogQueue qui sotto): nessun codice di prova nell'app.
test.setTimeout(90_000);

let tmp: string;
test.beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'baa-t1f-'));
});
test.afterEach(() => {
  removeDir(tmp);
});

const norm = (p: string) => p.replaceAll('\\', '/');
const treeNode = (page: Page, text: string) =>
  page.locator('[data-testid^="tree-node-plc:"]', { hasText: text }).first();
const grid = (page: Page) => page.getByRole('grid').first();

async function typeCell(cell: Locator, text: string): Promise<void> {
  await cell.click();
  await cell.press('Enter');
  const input = cell.locator('input');
  await input.fill(text);
  await input.press('Enter');
  await expect(input).toHaveCount(0);
}

async function menuItem(page: Page, menu: string, item: string): Promise<void> {
  await page.getByTestId('menu-bar').getByRole('menuitem', { name: menu, exact: true }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

/** Ogni chiamata a showOpenDialog restituisce il risultato successivo della coda. */
async function openDialogQueue(app: ElectronApplication, results: string[][]): Promise<void> {
  await app.evaluate(({ dialog }, r) => {
    const queue = [...r];
    dialog.showOpenDialog = (async () => {
      const next = queue.shift();
      return next ? { canceled: false, filePaths: next } : { canceled: true, filePaths: [] };
    }) as unknown as typeof dialog.showOpenDialog;
  }, results);
}

/** Salva con Mod+S e aspetta che il file contenga lo stato atteso. */
async function savedProject(
  page: Page,
  file: string,
  ok: (p: Project) => boolean,
): Promise<Project> {
  await page.keyboard.press(`${mod}+s`);
  await expect
    .poll(() => {
      try {
        return ok(readBaap(readFileSync(file)));
      } catch {
        return false;
      }
    })
    .toBe(true);
  return readBaap(readFileSync(file));
}

const tagAddress = (p: Project, name: string) =>
  p.devices[0]?.tagTables[0]?.tags.find((t) => t.name === name)?.address;

test('esporta e reimporta una tabella di variabili in csv e in xlsx', async () => {
  const file = join(tmp, 'tag.baap');
  writeFixtureProject(file, (dev) => {
    const tag = (name: string, address: string) => ({
      id: crypto.randomUUID(),
      name,
      type: 'Bool',
      address,
      hmi: true,
      comment: '',
    });
    dev.tagTables[0]!.tags.push(tag('Motore', '%M0.0'), tag('Sensore', '%M0.1'));
  });
  const { app, page } = await launchApp({ args: [file] });
  await page.getByTestId('link-project-view').click();
  const tableNode = treeNode(page, 'Tabella delle variabili standard');
  const contextMenu = async (item: string) => {
    await tableNode.click({ button: 'right' });
    await page.getByRole('menuitem', { name: item, exact: true }).click();
  };
  await tableNode.dblclick();
  const addressCell = () =>
    grid(page).locator('[data-row-key]', { hasText: 'Motore' }).locator('[data-col-id="address"]');

  for (const ext of ['csv', 'xlsx']) {
    const out = join(tmp, `variabili.${ext}`);
    await stubFileDialogs(app, { save: out, open: [out] });
    await contextMenu('Esporta variabili…');
    await expect.poll(() => existsSync(out)).toBe(true);

    // Si cambia un indirizzo e si reimporta il file: torna quello esportato.
    const changed = ext === 'csv' ? '%M9.0' : '%M9.1';
    await typeCell(addressCell(), changed);
    await expect(addressCell()).toContainText(changed);
    await contextMenu('Importa variabili…');
    // Il resoconto dell'importazione: 2 variabili aggiornate, nessuna scartata.
    const report = page.getByRole('dialog', { name: 'Importazione variabili' });
    await expect(report).toContainText('Aggiornati: 2');
    await expect(report).toContainText('Scartati: 0');
    await report.getByRole('button', { name: 'OK' }).click();
    await expect(report).toHaveCount(0);
    await expect(addressCell()).toContainText('%M0.0');
    const p = await savedProject(page, file, (x) => tagAddress(x, 'Motore') === '%M0.0');
    expect(p.devices[0]!.tagTables[0]!.tags.map((t) => t.name)).toEqual(['Motore', 'Sensore']);
  }
});

test('archivia e ritira un progetto', async () => {
  const file = join(tmp, 'Archivio.baap');
  writeFixtureProject(file);
  const archive = join(tmp, 'copia.baapz');
  const dest = join(tmp, 'ritirato');
  mkdirSync(dest, { recursive: true });
  const { app, page } = await launchApp({ args: [file] });
  await stubMessageBox(app, 0);
  await page.getByTestId('link-project-view').click();

  await stubFileDialogs(app, { save: archive });
  await menuItem(page, 'Progetto', 'Archivia…');
  await expect.poll(() => existsSync(archive)).toBe(true);
  expect(readBaapz(readFileSync(archive)).manifest.projectFileName).toBe('Archivio.baap');

  // Ritira: prima il file dell'archivio, poi la cartella di destinazione.
  await openDialogQueue(app, [[archive], [dest]]);
  await menuItem(page, 'Progetto', 'Ritira archivio…');
  const restored = join(dest, 'Archivio.baap');
  await expect
    .poll(() => mainTitle(app).then((t) => norm(t ?? '')))
    .toBe(`BaaPortal - ${norm(restored)}`);
  expect(readBaap(readFileSync(restored)).devices[0]!.blocks.map((b) => b.name)).toContain(
    'Nastro',
  );
});

test('apre un progetto di riferimento e ne copia un FC', async () => {
  const file = join(tmp, 'principale.baap');
  const ref = join(tmp, 'riferimento.baap');
  writeFixtureProject(file);
  writeFixtureProject(ref, (dev) => {
    dev.blocks.push(createCodeBlock({ kind: 'FC', number: 7, name: 'Calcolo', language: 'AWL' }));
  });
  const { app, page } = await launchApp({ args: [file] });
  await page.getByTestId('link-project-view').click();
  await expect(treeNode(page, 'Calcolo [FC')).toHaveCount(0);

  await stubFileDialogs(app, { open: [ref] });
  await menuItem(page, 'Progetto', 'Apri progetto di riferimento…');
  const panel = page.getByTestId('panel-reference-projects');
  await expect(panel).toBeVisible();
  const node = panel.locator('[data-testid^="reference-node-"]', { hasText: 'Calcolo' }).first();
  await node.click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Copia nel progetto/ }).click();
  await expect(treeNode(page, 'Calcolo [FC')).toBeVisible();

  const p = await savedProject(page, file, (x) =>
    x.devices[0]!.blocks.some((b) => b.name === 'Calcolo'),
  );
  expect(p.devices[0]!.blocks.filter((b) => b.name === 'Calcolo')).toHaveLength(1);
});

test('trova e sostituisci in tutto il progetto, poi Ctrl+Z annulla', async () => {
  const file = join(tmp, 'trova.baap');
  writeFixtureProject(file, (dev) => {
    const fc = createCodeBlock({ kind: 'FC', number: 2, name: 'Calcolo', language: 'AWL' });
    fc.networks[0]!.source = 'L MW10\nT MW12';
    dev.blocks.push(fc);
  });
  const { page } = await launchApp({ args: [file] });
  await page.getByTestId('link-project-view').click();
  await firstDeviceId(page);

  await page.keyboard.press(`${mod}+h`);
  const replace = page.getByRole('textbox', { name: 'Sostituisci con' });
  await expect(replace).toBeFocused(); // Ctrl+H: il fuoco va al campo "Sostituisci con"
  await replace.fill('MW20');
  await page.getByRole('textbox', { name: 'Trova' }).fill('MW10');
  await page.getByRole('button', { name: 'Trova', exact: true }).click();
  await expect(page.getByText('1 risultato')).toBeVisible();
  await page.getByRole('button', { name: 'Sostituisci tutto' }).click();
  const source = (p: Project) =>
    (p.devices[0]!.blocks.find((b) => b.name === 'Calcolo') as { networks: { source: string }[] })
      .networks[0]!.source;
  await savedProject(page, file, (p) => source(p) === 'L MW20\nT MW12');

  // Un solo Ctrl+Z ripristina il testo originale (il fuoco sull'albero, non nel campo di testo).
  await treeNode(page, 'Calcolo [FC').click();
  await page.keyboard.press(`${mod}+z`);
  await savedProject(page, file, (p) => source(p) === 'L MW10\nT MW12');
});

test('Impostazioni: cambia lingua e mnemonica', async () => {
  const file = join(tmp, 'impostazioni.baap');
  writeFixtureProject(file);
  const { page } = await launchApp({ args: [file] });
  await page.getByTestId('link-project-view').click();

  await menuItem(page, 'Opzioni', 'Impostazioni');
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel("Lingua dell'interfaccia").selectOption('en');
  await dialog.getByLabel('Mnemonica SIMATIC').selectOption('de');
  await page.getByTestId('dialog-ok').click();
  await expect(dialog).toHaveCount(0);

  // L'interfaccia è in inglese e le scelte restano nel dialogo riaperto.
  const options = page
    .getByTestId('menu-bar')
    .getByRole('menuitem', { name: 'Options', exact: true });
  await expect(options).toBeVisible();
  await options.click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await expect(dialog.getByLabel('Interface language')).toHaveValue('en');
  await expect(dialog.getByLabel('SIMATIC mnemonics')).toHaveValue('de');
});
