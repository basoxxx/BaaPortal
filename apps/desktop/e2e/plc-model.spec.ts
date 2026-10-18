import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readBaap } from '@baaportal/project';
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
  mod,
  openProjectView,
  shownDialogs,
  stubMessageBox,
  test,
  writeFixtureProject,
} from './helpers';

let tmp: string;
test.beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'baa-plc-'));
});
test.afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Griglia dell'editor attivo (la prima della pagina). */
const grid = (page: Page) => page.getByRole('grid').first();
const dataRows = (g: Locator) => g.locator('[data-row-key]:not([data-row-key*="add:"])');

/** Modifica una cella: seleziona, Invio per aprire il campo, scrive e conferma. */
async function typeCell(cell: Locator, text: string): Promise<void> {
  await cell.click();
  await cell.press('Enter');
  const input = cell.locator('input');
  await input.fill(text);
  await input.press('Enter');
  await expect(input).toHaveCount(0);
}

/** Aggiunge una riga scrivendo nella riga "<Aggiungi>" (`add:n`), nella colonna indicata. */
async function addByTyping(g: Locator, slot: number, col: string, text: string): Promise<void> {
  await typeCell(g.locator(`[data-row-key$="add:${slot}"] [data-col-id="${col}"]`), text);
}

/** Testo di ogni riga della griglia: serve a confrontare un editor prima e dopo il salvataggio. */
const rowTexts = (g: Locator) =>
  g.locator('[data-row-key]').evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText));

const treeNode = (page: Page, text: string) =>
  page.locator('[data-testid^="tree-node-plc:"]', { hasText: text }).first();
const treeIds = (page: Page) =>
  page
    .locator('[data-testid^="tree-node-"]')
    .evaluateAll((els) =>
      els.map((e) => `${e.getAttribute('data-testid')}|${(e as HTMLElement).innerText.trim()}`),
    );

/** Rinomina un nodo dell'albero con F2. */
async function renameNode(page: Page, node: Locator, name: string): Promise<void> {
  await node.click();
  await node.press('F2');
  const input = page.getByLabel('Nuovo nome');
  await input.fill(name);
  await input.press('Enter');
  await expect(input).toHaveCount(0);
}

test('modello dati PLC: crea, annulla e ripeti, salva, chiudi e riapri', async () => {
  const dir = join(tmp, 'cartella con spazi è');
  const { app, page } = await launchApp();
  await stubMessageBox(app, 2); // Annulla: serve solo a registrare le richieste di chiusura
  await createProject(page, 'Impianto àè', dir);
  await openProjectView(page);

  // 1. CPU 315-2 PN/DP
  await addCpu(page);
  const dev = await firstDeviceId(page);
  await expect(treeNode(page, 'PLC_1 [CPU 315-2 PN/DP]')).toBeVisible();

  // 2. Tabella standard: tre tag scrivendo, poi riempimento fino a sei
  await treeNode(page, 'Tabella delle variabili standard').dblclick();
  const tags = grid(page);
  await addByTyping(tags, 0, 'name', 'Motore');
  await addByTyping(tags, 0, 'name', 'Sensore');
  await addByTyping(tags, 0, 'name', 'Pulsante');
  await expect(dataRows(tags)).toHaveCount(3);
  const first = dataRows(tags).first().locator('[data-col-id="name"]');
  await first.click();
  const handle = tags.locator('[data-fill-handle]');
  const h = (await handle.boundingBox())!;
  const target = (await tags.locator('[data-row-key$="add:0"]').boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + 20, target.y + target.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(dataRows(tags)).toHaveCount(6);

  // 3. Una costante
  await page.getByRole('tab', { name: 'Costanti utente' }).click();
  await addByTyping(grid(page), 0, 'name', 'Limite');
  await expect(dataRows(grid(page))).toHaveCount(1);
  await page.getByRole('tab', { name: 'Variabili' }).click();
  const tagsText = await rowTexts(grid(page));
  await page.getByRole('tab', { name: 'Costanti utente' }).click();
  const constText = await rowTexts(grid(page));

  // 4. UDT "Asse" con una struct
  await page.getByTestId(`tree-node-plc:${dev}:types-add`).dblclick();
  await renameNode(page, treeNode(page, 'Tipo di dati utente_1'), 'Asse');
  const udt = grid(page);
  await addByTyping(udt, 0, 'name', 'Dati');
  await typeCell(dataRows(udt).first().locator('[data-col-id="type"]'), 'Struct');
  await addByTyping(udt, 0, 'name', 'Posizione'); // slot 0 = dentro la struct
  await addByTyping(udt, 0, 'type', 'Int');
  await expect(dataRows(udt)).toHaveCount(3);
  const udtText = await rowTexts(udt);

  // 5. FB "Nastro": Input, Static di tipo "Asse" e multi-istanza di un altro FB
  await addBlock(page, dev, { kind: 'FB', name: 'Rullo' });
  await addBlock(page, dev, { kind: 'FB', name: 'Nastro' });
  await treeNode(page, 'Nastro [FB').dblclick();
  const fb = grid(page);
  await addByTyping(fb, 0, 'name', 'Avvio'); // Input
  await addByTyping(fb, 3, 'name', 'Asse1'); // Static
  await typeCell(
    fb.locator('[data-row-key]', { hasText: 'Asse1' }).locator('[data-col-id="type"]'),
    '"Asse"',
  );
  await addByTyping(fb, 3, 'name', 'Rullo1');
  await typeCell(
    fb.locator('[data-row-key]', { hasText: 'Rullo1' }).locator('[data-col-id="type"]'),
    '"Rullo"',
  );
  const fbText = await rowTexts(fb);

  // 6. DB globale e DB di istanza Nastro_DB
  await addBlock(page, dev, { kind: 'DB', name: 'Dati_globali' });
  await treeNode(page, 'Dati_globali [DB').dblclick();
  await addByTyping(grid(page), 0, 'name', 'Contatore');
  await typeCell(
    grid(page).locator('[data-row-key]', { hasText: 'Contatore' }).locator('[data-col-id="type"]'),
    'DInt',
  );
  const dbText = await rowTexts(grid(page));
  await addBlock(page, dev, { kind: 'DB', name: 'Nastro_DB', instanceOf: 'Nastro' });
  await treeNode(page, 'Nastro_DB [DB').dblclick();
  await grid(page).locator('[data-row-key="section:static"] [data-expander]').click();
  await expect(grid(page).locator('[data-row-key]', { hasText: 'Rullo1' })).toBeVisible();
  const idbText = await rowTexts(grid(page));

  // 7. Mod+Z annulla l'ultima modifica (il DB di istanza), Mod+Y la ripete
  const nodes = await treeIds(page);
  expect(nodes.some((n) => n.includes('Nastro_DB'))).toBe(true);
  await treeNode(page, 'Nastro [FB').click();
  await page.keyboard.press(`${mod}+z`);
  await expect(treeNode(page, 'Nastro_DB [DB')).toHaveCount(0);
  await page.keyboard.press(`${mod}+y`);
  await expect(treeNode(page, 'Nastro_DB [DB')).toHaveCount(1);
  expect(await treeIds(page)).toEqual(nodes);

  // 8. Salva, chiudi e riapri: tutto presente e uguale
  const treeBefore = await treeIds(page);
  // Con modifiche in sospeso la chiusura della finestra chiede conferma (lo stub risponde Annulla)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await expect.poll(() => shownDialogs(app)).toHaveLength(1);
  await page.keyboard.press(`${mod}+s`);
  const file = join(dir, 'Impianto àè.baap');
  // Il file esiste già dalla creazione: si aspetta che contenga davvero il DB di istanza
  await expect
    .poll(() => {
      try {
        return readBaap(readFileSync(file)).devices[0]?.blocks.some((b) => b.name === 'Nastro_DB');
      } catch {
        return false;
      }
    })
    .toBe(true);
  // 9. Salvato: chiudere il progetto non chiede più nulla
  await page
    .getByTestId('menu-bar')
    .getByRole('menuitem', { name: 'Progetto', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Chiudi', exact: true }).click();
  await expect.poll(() => mainTitle(app)).toBe('BaaPortal');
  expect(await shownDialogs(app)).toHaveLength(1);

  await page.getByTestId('portal-start').click();
  await page.getByTestId('action-open').click();
  await page.getByTestId('selection-pane').getByRole('row').nth(1).dblclick();
  await expect.poll(() => mainTitle(app)).toBe(`BaaPortal - ${file}`);
  await page.getByTestId('link-project-view').click();
  await expect(treeNode(page, 'Nastro_DB [DB')).toBeVisible();
  expect(await treeIds(page)).toEqual(treeBefore);

  await treeNode(page, 'Tabella delle variabili standard').dblclick();
  expect(await rowTexts(grid(page))).toEqual(tagsText);
  await page.getByRole('tab', { name: 'Costanti utente' }).click();
  expect(await rowTexts(grid(page))).toEqual(constText);
  await page.locator('[data-testid*=":udt:"]').dblclick();
  // Lo stato aperto/chiuso delle struct è dell'editor, non del file
  await grid(page)
    .locator('[data-row-key]', { hasText: 'Dati' })
    .locator('[data-expander]')
    .click();
  await expect(dataRows(grid(page))).toHaveCount(3);
  expect(await rowTexts(grid(page))).toEqual(udtText);
  await treeNode(page, 'Nastro [FB').dblclick();
  expect(await rowTexts(grid(page))).toEqual(fbText);
  await treeNode(page, 'Dati_globali [DB').dblclick();
  expect(await rowTexts(grid(page))).toEqual(dbText);
  await treeNode(page, 'Nastro_DB [DB').dblclick();
  await grid(page).locator('[data-row-key="section:static"] [data-expander]').click();
  await expect(grid(page).locator('[data-row-key]', { hasText: 'Rullo1' })).toBeVisible();
  expect(await rowTexts(grid(page))).toEqual(idbText);
  await app.close();
});

test('copia righe di tag con Mod+C e incollale in una tabella nuova con Mod+V', async () => {
  const file = join(tmp, 'tag.baap');
  writeFixtureProject(file, (dev) => {
    const tag = (n: string, address: string) => ({
      id: crypto.randomUUID(),
      name: n,
      type: 'Bool',
      address,
      hmi: true,
      comment: '',
    });
    dev.tagTables[0]!.tags.push(tag('Motore', '%M0.0'), tag('Sensore', '%M0.1'));
    dev.tagTables.push({
      id: crypto.randomUUID(),
      name: 'Tabella 2',
      group: '',
      tags: [],
      constants: [],
    });
  });
  const { page } = await launchApp({ args: [file] });
  await page.getByTestId('link-project-view').click();

  await treeNode(page, 'Tabella delle variabili standard').dblclick();
  const rows = dataRows(grid(page));
  await expect(rows).toHaveCount(2);
  await rows.first().locator('[data-rownum]').click();
  await rows
    .last()
    .locator('[data-rownum]')
    .click({ modifiers: ['Shift'] });
  await page.keyboard.press(`${mod}+c`);

  await treeNode(page, 'Tabella 2').dblclick();
  await grid(page).locator('[data-row-key$="add:0"] [data-col-id="name"]').click();
  await page.keyboard.press(`${mod}+v`);
  await expect(dataRows(grid(page))).toHaveCount(2);
  const names = await dataRows(grid(page)).locator('[data-col-id="name"]').allInnerTexts();
  expect(names).toEqual(['Motore_1', 'Sensore_1']);
});

test('trascina un blocco in un gruppo ed elimina con conferma', async () => {
  const file = join(tmp, 'gruppo.baap');
  writeFixtureProject(file, (dev) => {
    dev.groups.blocks.push('Gruppo_1');
  });
  const { app, page } = await launchApp({ args: [file] });
  await page.getByTestId('link-project-view').click();
  const dev = await firstDeviceId(page);

  const group = page.getByTestId(`tree-node-plc:${dev}:blocks:group:Gruppo_1`);
  await treeNode(page, 'Nastro [FB').dragTo(group);
  // Il blocco ora è sotto il gruppo: un livello più in basso di Main
  await expect(treeNode(page, 'Main [OB')).toHaveAttribute('aria-level', '4');
  await expect(treeNode(page, 'Nastro [FB')).toHaveAttribute('aria-level', '5');
  await group.click();
  await expect(page.getByTestId('details-row')).toHaveCount(1);
  await expect(page.getByTestId('details-row')).toContainText('Nastro');

  // Elimina: con "No" resta, con "Sì" sparisce
  await stubMessageBox(app, 1);
  await treeNode(page, 'Nastro [FB').click();
  await page.keyboard.press('Delete');
  await expect.poll(() => shownDialogs(app)).toHaveLength(1);
  expect((await shownDialogs(app))[0]).toContain('Nastro');
  await expect(treeNode(page, 'Nastro [FB')).toHaveCount(1);

  await stubMessageBox(app, 0);
  await treeNode(page, 'Nastro [FB').click();
  await page.keyboard.press('Delete');
  await expect(treeNode(page, 'Nastro [FB')).toHaveCount(0);
  expect(await shownDialogs(app)).toHaveLength(1);
});
