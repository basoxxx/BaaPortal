import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addWatchTable, createWatchRow } from '@baaportal/project';
import { expect, launchApp, removeDir, stubMessageBox, test, writeFixtureProject } from './helpers';

// Criterio «fatto quando» del piano 2C sull'app costruita: programma in AWL, simulazione, pannello I/O,
// osservazione, tabella di controllo, STOP e chiusura del progetto.
test.setTimeout(120_000);

let tmp: string;
test.beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'baa-t2-'));
});
test.afterEach(() => {
  removeDir(tmp);
});

test('Tappa 2: ingresso -> uscita, osservazione, tabella di controllo, STOP, chiusura', async () => {
  const file = join(tmp, 'tappa2.baap');
  writeFixtureProject(file, (dev) => {
    const ob = dev.blocks.find((b) => b.kind === 'OB' && b.number === 1);
    if (!ob || ob.kind === 'DB' || ob.kind === 'IDB') throw new Error('OB1 mancante');
    ob.networks[0]!.source = 'A I 0.0\n= Q 4.0\nA I 0.1\nCU C 1';
    const tags = dev.tagTables[0]!.tags;
    const tag = (id: string, name: string, address: string) =>
      tags.push({ id, name, type: 'Bool', address, hmi: false, comment: '' });
    tag('tg-in0', 'Start', '%I0.0');
    tag('tg-in1', 'Conta', '%I0.1');
    tag('tg-out', 'Motore', '%Q4.0');
    const t = addWatchTable(dev, 'Prova', () => 'wt-prova');
    t.rows.push({ ...createWatchRow('MW 10', 'DEC', () => 'wr1'), modify: '1234' });
  });
  const { app, page } = await launchApp({ args: [file] });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await stubMessageBox(app, 0); // «Avviare la CPU?» -> Sì
  await page.getByTestId('link-project-view').click();
  await page.locator('[data-testid^="tree-node-plc:"]', { hasText: '[OB1]' }).first().dblclick();

  await page.getByRole('button', { name: 'Simulazione', exact: true }).click();
  await expect(page.getByTestId('sim-indicator')).toHaveText('Simulazione: STOP');
  await page.getByRole('button', { name: 'Carica nel dispositivo', exact: true }).click();
  await expect(page.getByTestId('sim-indicator')).toHaveText('Simulazione: RUN');

  // pannello I/O: I 0.0 = 1 -> Q 4.0 = 1
  await page.getByTestId('taskcard-tab-test').click();
  await expect(page.getByTestId('led-run')).toBeVisible();
  await page.getByTestId('in-bit-0-0').click();
  await expect(page.getByTestId('in-bit-0-0')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('out-bit-4-0')).toHaveAttribute('aria-label', /: 1$/, {
    timeout: 10_000,
  });

  // osservazione dell'OB1: RLO = 1 sulla riga «= Q 4.0»
  await page.getByRole('button', { name: 'Osserva programma', exact: true }).click();
  await expect(page.getByTestId('monitor-bar')).toContainText('Osservazione attiva');
  const line = page.locator('.cm-line', { hasText: '= Q 4.0' });
  await expect(line.locator('.baa-mon-cell')).toContainText('RLO 1');

  // tabella di controllo: si comanda MW 10 = 1234 e si legge 1234
  await page
    .locator('[data-testid^="tree-node-"]', { hasText: /^Prova/ })
    .first()
    .dblclick();
  await page.getByRole('button', { name: 'Osserva tutto', exact: true }).click();
  await expect(page.getByTestId('watch-bar')).toContainText('Osservazione');
  await page.getByRole('button', { name: 'Comanda', exact: true }).click();
  await expect(page.getByTestId('watch-bar')).toContainText('1');
  // valore di stato e valore di comando valgono entrambi 1234
  await expect(page.getByText('1234', { exact: true })).toHaveCount(2, { timeout: 10_000 });

  // STOP e LED
  await page.getByTestId('cpu-stop').click();
  await expect(page.getByTestId('sim-indicator')).toHaveText('Simulazione: STOP');
  await expect(page.getByTestId('led-stop')).toHaveAttribute('aria-label', /: acceso$/);
  await expect(page.getByTestId('led-run')).toHaveAttribute('aria-label', /: spento$/);

  // chiusura del progetto: la simulazione si spegne
  await page
    .getByTestId('menu-bar')
    .getByRole('menuitem', { name: 'Progetto', exact: true })
    .click();
  await page.getByRole('menuitem', { name: /^Chiudi/ }).click();
  await expect(page.getByTestId('sim-indicator')).toHaveCount(0);
  expect(errors).toEqual([]);
});
