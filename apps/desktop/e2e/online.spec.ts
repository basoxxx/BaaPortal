import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listen } from '@baaportal/s7-server/node';
import { SimCpu, simBackend } from '@baaportal/sim';
import {
  addCpu,
  createProject,
  expect,
  launchApp,
  openProjectView,
  removeDir,
  test,
} from './helpers';

// Criterio «fatto quando» del piano 3A sull'app costruita: collegamento a un PLC di prova (server S7
// locale con CPU simulata, avviato qui nel processo del test), LED, STOP dal lato server, perdita del
// collegamento. Non sostituisce la prova su una CPU reale.
test.setTimeout(90_000);

let tmp: string;
test.beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'baa-t3a-'));
});
test.afterEach(() => {
  removeDir(tmp);
});

test('Piano 3A: collegamento al PLC di prova, LED RUN/STOP, collegamento interrotto', async () => {
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
  const server = await listen(simBackend(cpu), { host: '127.0.0.1', port: 0 });
  let closed = false;
  try {
    const { page } = await launchApp();
    await createProject(page, 'Online', tmp);
    await openProjectView(page);
    await addCpu(page);

    await page.getByRole('button', { name: 'Dispositivi accessibili…', exact: true }).click();
    const dialog = page.getByTestId('dialog-access-devices');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Indirizzo manuale', { exact: true }).fill(`127.0.0.1:${server.port}`);
    await dialog.getByRole('button', { name: 'Aggiungi indirizzo', exact: true }).click();
    await dialog.getByRole('button', { name: 'Collega', exact: true }).click();

    // barra arancione con il modulo, LED RUN
    const indicator = page.getByTestId('plc-indicator');
    await expect(indicator).toContainText('Online:');
    await expect(indicator).toContainText('127.0.0.1');
    await expect(page.locator('.baa-app.online')).toHaveCount(1);
    await page.getByTestId('taskcard-tab-test').click();
    await expect(page.getByTestId('cpu-panel-online')).toBeVisible();
    await expect(page.getByTestId('led-run')).toHaveAttribute('data-on', 'true');
    await expect(page.getByTestId('led-stop')).toHaveAttribute('data-on', 'false');

    // con l'app online la simulazione è disabilitata
    await expect(page.getByRole('button', { name: 'Simulazione', exact: true })).toBeDisabled();

    // STOP dal lato server: i LED seguono entro 3 s
    cpu.stop();
    await expect(page.getByTestId('led-stop')).toHaveAttribute('data-on', 'true', {
      timeout: 3_000,
    });
    await expect(page.getByTestId('led-run')).toHaveAttribute('data-on', 'false');

    // il PLC sparisce: l'app torna offline con il messaggio
    await server.close();
    closed = true;
    await expect(page.getByTestId('plc-indicator')).toHaveCount(0, { timeout: 5_000 });
    await expect(page.locator('.baa-app.online')).toHaveCount(0);
    await expect(page.getByText('Collegamento interrotto', { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Simulazione', exact: true })).toBeEnabled();
  } finally {
    if (!closed) await server.close();
  }
});
