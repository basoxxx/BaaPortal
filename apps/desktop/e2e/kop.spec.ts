import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodeBlock, readBaap } from '@baaportal/project';
import {
  expect,
  launchApp,
  mod,
  removeDir,
  stubMessageBox,
  test,
  writeFixtureProject,
} from './helpers';

// Editor KOP sull'app costruita: FC1 in KOP (I 0.0 in serie con I 0.1, bobina Q 4.0), OB1 in AWL che
// scrive I 0.0 e I 0.1 a 1 nell'immagine di processo e chiama FC 1. Si controlla il disegno, l'AWL
// generato, il salvataggio, una compilazione senza errori, il caricamento nel simulatore in RUN e
// l'osservazione attiva su FC1 (le combinazioni di ingressi sono in packages/project/test/kopCompile.test.ts).
test.setTimeout(90_000);

let tmp: string;
test.beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'baa-kop-'));
});
test.afterEach(() => {
  removeDir(tmp);
});

test('KOP: disegna, vede l’AWL, salva, compila e osserva il blocco nel simulatore', async () => {
  const file = join(tmp, 'kop.baap');
  writeFixtureProject(file, (dev) => {
    // Tempo di ciclo massimo al limite (6 s): con la macchina carica il worker del simulatore può
    // restare fermo oltre i 150 ms di serie e la CPU andrebbe in STOP (TEMPO_CICLO_SUPERATO).
    dev.properties.cycle.maxCycleMs = 6000;
    dev.blocks = dev.blocks.filter((b) => b.kind !== 'FB' || b.name !== 'Nastro');
    dev.blocks.push(createCodeBlock({ kind: 'FC', number: 1, name: 'Logica', language: 'KOP' }));
    const ob = dev.blocks.find((b) => b.kind === 'OB' && b.number === 1);
    if (!ob || ob.kind === 'DB' || ob.kind === 'IDB') throw new Error('OB1 mancante');
    ob.networks[0]!.source = 'SET\n= I 0.0\n= I 0.1\nCALL FC 1';
  });
  const { app, page } = await launchApp({ args: [file] });
  await stubMessageBox(app, 0); // «Avviare la CPU?» → Sì
  await page.getByTestId('link-project-view').click();
  await expect(page.getByTestId('menu-bar')).toBeVisible();

  await page.locator('[data-testid^="tree-node-plc:"]', { hasText: '[FC1]' }).first().dblclick();
  const canvas = page.getByRole('group', { name: 'Segmento KOP 1' });
  await expect(canvas).toBeVisible();
  await expect(canvas.getByRole('button', { name: /^Bobina / })).toBeVisible();

  // F2: contatto NA dopo la selezione; Invio modifica l'operando.
  await canvas.focus();
  await page.keyboard.press('F2');
  await page.keyboard.press('Enter');
  await page.keyboard.type('I 0.0');
  await page.keyboard.press('Enter');
  await page.keyboard.press('F2');
  await page.keyboard.press('Enter');
  await page.keyboard.type('I 0.1');
  await page.keyboard.press('Enter');
  await canvas.getByRole('button', { name: /^Bobina / }).dblclick();
  await page.keyboard.type('Q 4.0');
  await page.keyboard.press('Enter');

  await expect(page.getByRole('button', { name: 'Contatto NA I 0.0' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Contatto NA I 0.1' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Bobina Q 4.0' })).toBeVisible();

  // «Mostra AWL»: il codice generato, con gli operandi assoluti in forma `%`.
  await page.getByRole('button', { name: 'Mostra AWL' }).click();
  const awl = page.getByRole('textbox', { name: 'Codice del segmento 1' });
  await expect(awl).toContainText('A %I0.0');
  await expect(awl).toContainText('A %I0.1');
  await expect(awl).toContainText('= %Q4.0');

  // Salvataggio: il grafico e l'AWL generato sono nel file.
  await page.keyboard.press(`${mod}+s`);
  await expect
    .poll(
      () => {
        try {
          const dev = readBaap(readFileSync(file)).devices[0]!;
          const b = dev.blocks.find((x) => x.kind === 'FC' && x.number === 1);
          return b && b.kind !== 'DB' && b.kind !== 'IDB' && b.networks[0]?.lad ? b.language : '';
        } catch {
          return '';
        }
      },
      { timeout: 10_000 },
    )
    .toBe('KOP');

  // Compilazione completa: nessun errore.
  const plc = page.locator('[data-testid^="tree-node-plc:"]').first();
  await plc.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Compila → Software (compilazione completa)' }).click();
  await expect(page.getByTestId('compile-summary')).toContainText('0 errori, 0 avvisi', {
    timeout: 30_000,
  });
  await expect(page.locator('[data-testid="compile-row"][data-status="error"]')).toHaveCount(0);

  // Nel simulatore: caricamento, RUN e osservazione di FC1.
  await page.getByRole('button', { name: 'Simulazione', exact: true }).click();
  await expect(page.getByTestId('sim-indicator')).toHaveText('Simulazione: STOP');
  await page.getByRole('button', { name: 'Carica nel dispositivo', exact: true }).click();
  await expect(page.getByTestId('sim-indicator')).toHaveText('Simulazione: RUN');
  await page.getByRole('button', { name: 'Osserva programma', exact: true }).click();
  await expect(page.getByTestId('monitor-bar')).toContainText('Osservazione attiva');
  // I 0.0 e I 0.1 a 1 (le scrive OB1): i due contatti chiusi e la bobina a 1.
  await expect(page.getByRole('button', { name: /^Contatto NA I 0\.0 \(stato 1/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Contatto NA I 0\.1 \(stato 1/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Bobina Q 4\.0 \(stato 1/ })).toBeVisible();
});
