import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, launchApp, removeDir, stubMessageBox, test, writeFixtureProject } from './helpers';

// Prova sull'app costruita (CSP `default-src 'self'`) che il Worker del simulatore si carica da file://,
// poi il percorso completo: Simulazione, Carica nel dispositivo, RUN, chiusura del progetto.
test.setTimeout(90_000);

let tmp: string;
test.beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'baa-sim-'));
});
test.afterEach(() => {
  removeDir(tmp);
});

test('Simulazione: il worker parte nell’app costruita e la barra di stato mostra STOP', async () => {
  const file = join(tmp, 'sim.baap');
  writeFixtureProject(file);
  const { page } = await launchApp({ args: [file] });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByTestId('link-project-view').click();
  await expect(page.getByTestId('sim-indicator')).toHaveCount(0);

  await page.getByRole('button', { name: 'Simulazione', exact: true }).click();
  await expect(page.getByTestId('sim-indicator')).toHaveText('Simulazione: STOP');
  expect(errors).toEqual([]);
});

test('Carica nel dispositivo avvia la CPU simulata; chiudere il progetto spegne la simulazione', async () => {
  const file = join(tmp, 'sim2.baap');
  writeFixtureProject(file);
  const { app, page } = await launchApp({ args: [file] });
  await stubMessageBox(app, 0); // «Avviare la CPU?» → Sì
  await page.getByTestId('link-project-view').click();
  await page.getByRole('button', { name: 'Simulazione', exact: true }).click();
  await expect(page.getByTestId('sim-indicator')).toHaveText('Simulazione: STOP');

  await page.getByRole('button', { name: 'Carica nel dispositivo', exact: true }).click();
  await expect(page.getByTestId('sim-indicator')).toHaveText('Simulazione: RUN');

  await page.getByRole('button', { name: 'Arresta CPU', exact: true }).click();
  await expect(page.getByTestId('sim-indicator')).toHaveText('Simulazione: STOP');

  await page
    .getByTestId('menu-bar')
    .getByRole('menuitem', { name: 'Progetto', exact: true })
    .click();
  await page.getByRole('menuitem', { name: /^Chiudi/ }).click();
  await expect(page.getByTestId('sim-indicator')).toHaveCount(0);
});

test('Osserva programma: dopo il caricamento l’editor mostra i valori dell’OB1', async () => {
  const file = join(tmp, 'sim3.baap');
  writeFixtureProject(file, (dev) => {
    // il dispositivo nuovo ha già l'OB1 «Main»
    const ob = dev.blocks.find((b) => b.kind === 'OB' && b.number === 1);
    if (!ob || ob.kind === 'DB' || ob.kind === 'IDB') throw new Error('OB1 mancante');
    ob.networks[0]!.source = 'L 42\nT MW 10';
  });
  const { app, page } = await launchApp({ args: [file] });
  await stubMessageBox(app, 0); // «Avviare la CPU?» → Sì
  await page.getByTestId('link-project-view').click();
  await page.locator('[data-testid^="tree-node-plc:"]', { hasText: '[OB1]' }).first().dblclick();
  await page.getByRole('button', { name: 'Simulazione', exact: true }).click();
  await expect(page.getByTestId('sim-indicator')).toHaveText('Simulazione: STOP');

  // senza caricamento il motivo è chiaro
  await page.getByRole('button', { name: 'Osserva programma', exact: true }).click();
  await expect(page.getByTestId('monitor-bar')).toContainText('non è caricato nel simulatore');

  await page.getByRole('button', { name: 'Carica nel dispositivo', exact: true }).click();
  await expect(page.getByTestId('sim-indicator')).toHaveText('Simulazione: RUN');
  await expect(page.getByTestId('monitor-bar')).toContainText('Osservazione attiva');
  await expect(page.locator('.baa-mon-cell').first()).toContainText('ACCU1 0000002A');
});
