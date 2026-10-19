import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ElectronApplication, Page } from '@playwright/test';
import { encodeSourceText } from '@baaportal/importers';
import { readBaap, type Project } from '@baaportal/project';
import {
  closeApp,
  expect,
  launchAppWithRetry,
  mod,
  removeDir,
  screenshot,
  stubFileDialogs,
  stubMessageBox,
  test,
  writeFixtureProject,
} from './helpers';

const FIXTURES = fileURLToPath(
  new URL('../../../packages/importers/test/fixtures/', import.meta.url),
);
const fixturePath = (name: string) => join(FIXTURES, name);
const fixtureText = (name: string) => readFileSync(fixturePath(name), 'utf8');

let tmp: string;
test.beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'baa-awl-'));
});
test.afterEach(() => {
  removeDir(tmp);
});

const treeNode = (page: Page, text: string) =>
  page.locator('[data-testid^="tree-node-plc:"]', { hasText: text }).first();
const network = (page: Page, n: number) => page.getByRole('region', { name: `Segmento ${n}` });
const cm = (page: Page, n: number) => network(page, n).locator('.cm-content');
const problems = (page: Page) => page.getByRole('list', { name: 'Problemi' });

/** Progetto di prova: un PLC senza blocchi e un tag "Pulsante" (Bool, %I0.0). */
function writeProject(file: string): void {
  writeFixtureProject(file, (dev) => {
    dev.blocks = [];
    dev.tagTables[0]!.tags.push({
      id: crypto.randomUUID(),
      name: 'Pulsante',
      type: 'Bool',
      address: '%I0.0',
      hmi: true,
      comment: '',
    });
  });
}

async function openProject(opts: { file: string; userData?: string }) {
  const l = await launchAppWithRetry({
    args: [opts.file],
    ...(opts.userData ? { userData: opts.userData } : {}),
  });
  await l.page.getByTestId('link-project-view').click();
  await expect(l.page.getByTestId('menu-bar')).toBeVisible();
  return l;
}

/** Sostituisce il testo di un segmento (scrittura in blocco, come un incolla) e lo conferma uscendo dal focus. */
async function setCode(page: Page, n: number, text: string, commit = true): Promise<void> {
  const c = cm(page, n);
  await c.click();
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.insertText(text);
  if (commit) await page.getByRole('heading', { name: 'Segmenti' }).click();
}

const sourceNodeId = async (page: Page, dev: string): Promise<string[]> =>
  page
    .locator(`[data-testid^="tree-node-plc:${dev}:source:"]`)
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''));

async function deviceId(page: Page): Promise<string> {
  const node = page.locator('[data-testid^="tree-node-plc:"]').first();
  const testId = (await node.getAttribute('data-testid')) ?? '';
  return testId.slice('tree-node-plc:'.length).split(':')[0] ?? '';
}

/** Aggiunge `collaudo.awl` da file (dialogo simulato) e ne genera i blocchi. */
async function importCollaudo(app: ElectronApplication, page: Page): Promise<string> {
  const dev = await deviceId(page);
  await stubFileDialogs(app, { open: [fixturePath('collaudo.awl')] });
  await page.getByTestId(`tree-node-plc:${dev}:sources-add`).dblclick();
  const src = treeNode(page, 'collaudo.awl');
  await expect(src).toBeVisible();
  await src.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Genera blocchi dalla sorgente' }).click();
  await expect(treeNode(page, 'Ritardo [FB')).toBeVisible();
  await expect(treeNode(page, 'Doppio [FC')).toBeVisible();
  await expect(treeNode(page, 'Ritardo_DB [DB')).toBeVisible();
  await expect(treeNode(page, 'Dati [DB')).toBeVisible();
  await expect(treeNode(page, 'Misura')).toBeVisible();
  return dev;
}

const savedProject = (file: string): Project | undefined => {
  try {
    return readBaap(readFileSync(file));
  } catch {
    return undefined;
  }
};
const savedNetwork = (file: string, kind: string, name: string, n: number): string | undefined => {
  const b = savedProject(file)?.devices[0]?.blocks.find((x) => x.kind === kind && x.name === name);
  return b && b.kind !== 'DB' && b.kind !== 'IDB' ? b.networks[n]?.source : undefined;
};

test('sorgente di collaudo: importa, genera, modifica, errore, correzione, rigenera, esporta byte per byte', async () => {
  test.setTimeout(120_000);
  const file = join(tmp, 'collaudo.baap');
  writeProject(file);
  const { app, page } = await openProject({ file });
  await stubMessageBox(app, 0);

  // 1-2. Aggiungi da file e genera i blocchi
  const dev = await importCollaudo(app, page);

  // 3. Modifica una riga dell'OB1 (segmento 2)
  await treeNode(page, '[OB1]').dblclick();
  await expect(network(page, 3)).toBeVisible();
  await expect(cm(page, 2)).toContainText('S %M0.0;');
  // Evidenziazione: il testo ha parti con classi di stile
  await expect(cm(page, 2).locator('.cm-line span[class]').first()).toBeVisible();
  await setCode(page, 2, 'A "Pulsante";\nS %M0.1;');
  await expect(cm(page, 2)).toContainText('S %M0.1;');

  // 4. Un errore scritto apposta (segmento 1, riga 3): sottolineato e nei Problemi
  await setCode(page, 1, 'A "Pulsante";\n= %Q0.0;\nJU MANCA', false);
  await expect(network(page, 1).locator('.cm-lintRange-error').first()).toBeVisible();
  await expect(problems(page).getByRole('button')).toHaveCount(1);
  await expect(problems(page).getByRole('button')).toContainText(/^Segmento 1, riga 3: /);
  await screenshot(page, '1-editor.png');
  await page.getByRole('heading', { name: 'Segmenti' }).click(); // conferma
  await expect(cm(page, 1)).not.toBeFocused();
  await problems(page).getByRole('button').click();
  await expect(cm(page, 1)).toBeFocused();

  // 5. Si corregge togliendo la riga
  await setCode(page, 1, 'A "Pulsante";\n= %Q0.0;');
  await expect(network(page, 1).locator('.cm-lintRange-error')).toHaveCount(0);
  await expect(page.getByText('Nessun problema')).toBeVisible();

  // 6. Rigenera la sorgente dai blocchi (cartelle Tipi e Blocchi insieme) ed esporta
  await treeNode(page, 'Tipi di dati PLC').click();
  await treeNode(page, 'Blocchi di programma').click({ modifiers: [mod] });
  await treeNode(page, 'Blocchi di programma').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Genera sorgente dai blocchi' }).click();
  await expect.poll(async () => (await sourceNodeId(page, dev)).length).toBe(2);
  // La sorgente generata prende il nome del primo oggetto (l'UDT "Misura"): si sceglie per nome.
  const generated = page.locator(`[data-testid^="tree-node-plc:${dev}:source:"]`, {
    hasText: 'Misura.awl',
  });
  await expect(generated).toHaveCount(1);
  const out = join(tmp, 'uscita.awl');
  await stubFileDialogs(app, { save: out });
  await generated.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Esporta…' }).click();

  // 7. Identico byte per byte alla fixture modificata (BOM e CRLF compresi): si aspetta l'uguaglianza,
  // non solo che il file esista (la scrittura potrebbe essere ancora a metà).
  const expected = Buffer.from(encodeSourceText(fixtureText('collaudo_modificato.awl')));
  await expect
    .poll(() => readFileOrNull(out)?.equals(expected) ?? false, { timeout: 30_000 })
    .toBe(true);
  const actual = readFileSync(out);
  expect(actual.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  const text = actual.toString('utf8');
  expect(text).toContain('\r\n');
  // Nessun LF isolato: ogni a capo è CRLF.
  expect(text.replace(/\r\n/g, '')).not.toContain('\n');

  // Completamento dopo "#" nel FB, con una bozza che non si conferma
  await treeNode(page, 'Ritardo [FB').dblclick();
  await expect(network(page, 1)).toBeVisible();
  await cm(page, 1).click();
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.insertText('A ');
  await page.keyboard.type('#');
  await expect(page.locator('.cm-tooltip-autocomplete')).toBeVisible();
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('Avvio');
  await screenshot(page, '2-completion.png');
});

function readFileOrNull(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

test('rinomina del tag usato in tre segmenti: il codice si aggiorna e Mod+Z lo ripristina', async () => {
  test.setTimeout(120_000);
  const file = join(tmp, 'rinomina.baap');
  writeProject(file);
  const { app, page } = await openProject({ file });
  await importCollaudo(app, page);
  await treeNode(page, '[OB1]').dblclick();
  for (const n of [1, 2, 3]) await expect(cm(page, n)).toContainText('"Pulsante"');

  await treeNode(page, 'Tabella delle variabili standard').dblclick();
  const cell = page
    .getByRole('grid')
    .locator('[data-row-key]:not([data-row-key*="add:"])')
    .first()
    .locator('[data-col-id="name"]');
  await cell.click();
  await cell.press('Enter');
  const input = cell.locator('input');
  await input.fill('Avviamento');
  await input.press('Enter');
  await expect(input).toHaveCount(0);

  await treeNode(page, '[OB1]').dblclick();
  for (const n of [1, 2, 3]) {
    await expect(cm(page, n)).toContainText('"Avviamento"');
    await expect(cm(page, n)).not.toContainText('"Pulsante"');
  }
  // Un solo passo di annullamento ripristina tutto
  await treeNode(page, 'Tabella delle variabili standard').click();
  await page.keyboard.press(`${mod}+z`);
  for (const n of [1, 2, 3]) {
    await expect(cm(page, n)).toContainText('"Pulsante"');
    await expect(cm(page, n)).not.toContainText('"Avviamento"');
  }
});

test('mnemonico tedesco: si scrive in tedesco, si salva in internazionale, si riapre mostrato in tedesco', async () => {
  test.setTimeout(120_000);
  const file = join(tmp, 'tedesco.baap');
  writeFixtureProject(file);
  const first = await openProject({ file });
  const { page } = first;
  await treeNode(page, 'Nastro [FB').dblclick();
  await expect(network(page, 1)).toBeVisible();
  await page.getByLabel('Mnemonica').selectOption('german');
  await setCode(page, 1, 'U E 0.0\nUN E 0.1\n= A 0.0');
  await expect(problems(page)).toBeHidden();
  await screenshot(page, '3-german.png');
  await page.keyboard.press(`${mod}+s`);
  await expect
    .poll(() => savedNetwork(file, 'FB', 'Nastro', 0), { timeout: 15_000 })
    .toMatch(/^A\s+%?I\s*0\.0/);
  const stored = savedNetwork(file, 'FB', 'Nastro', 0)!;
  expect(stored).not.toMatch(/^U\b/m);
  expect(stored).toMatch(/^AN\s+%?I\s*0\.1/m);

  // Chiude e riapre: la preferenza sta nel localStorage dello stesso userData
  await closeApp(first.app);
  const second = await openProject({ file, userData: first.userData });
  await treeNode(second.page, 'Nastro [FB').dblclick();
  await expect(second.page.getByLabel('Mnemonica')).toHaveValue('german');
  await expect(cm(second.page, 1)).toContainText('U E 0.0');
  await expect(cm(second.page, 1)).toContainText('UN E 0.1');
  await second.page.getByLabel('Mnemonica').selectOption('international');
  await expect(cm(second.page, 1)).toContainText('A I 0.0');
});

test('editor AWL nella finestra separata: conferma all’uscita dal focus e con Mod+S', async () => {
  test.setTimeout(120_000);
  const file = join(tmp, 'separata.baap');
  writeFixtureProject(file);
  const { app, page } = await openProject({ file });
  await treeNode(page, 'Nastro [FB').dblclick();
  const opened = app.waitForEvent('window');
  await page.getByRole('button', { name: 'Apri in una finestra separata' }).click();
  const det = await opened;
  await det.waitForLoadState('domcontentloaded');
  await expect(network(det, 1)).toBeVisible();

  // (a) Scrive e esce dal focus: la modifica è nel progetto (la salva la finestra principale)
  const undo = page.getByTestId('toolbar').getByRole('button', { name: 'Annulla' });
  await expect(undo).toBeDisabled();
  await setCode(det, 1, 'A %I0.0;\n= %Q0.0;');
  // Prima di salvare: il modello ha già la modifica (Annulla ne porta il nome) e niente è sul disco.
  await expect(undo).toBeEnabled({ timeout: 30_000 });
  await expect(undo).toHaveAttribute('title', /Modifica codice del segmento/);
  expect(savedNetwork(file, 'FB', 'Nastro', 0) ?? '').not.toContain('%Q0.0');
  await page.bringToFront();
  await page.getByTestId('menu-bar').click();
  await page.keyboard.press(`${mod}+s`);
  await expect
    .poll(() => savedNetwork(file, 'FB', 'Nastro', 0), { timeout: 15_000 })
    .toContain('%Q0.0');

  // (b) Scrive ancora e salva con Mod+S dentro la finestra separata, senza uscire dal focus
  await setCode(det, 1, 'A %I0.0;\n= %Q0.1;', false);
  await expect(cm(det, 1)).toBeFocused();
  await screenshot(det, '4-detached.png');
  await det.keyboard.press(`${mod}+s`);
  await expect
    .poll(() => savedNetwork(file, 'FB', 'Nastro', 0), { timeout: 15_000 })
    .toContain('%Q0.1');
});
