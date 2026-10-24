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
