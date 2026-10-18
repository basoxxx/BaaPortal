import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expect,
  killAppTree,
  launchApp,
  launchAppWithRetry,
  mainTitle,
  shownDialogs,
  test,
  windowCount,
  writeFixtureProject,
  removeDir,
} from './helpers';

let tmp: string;
test.beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'baa-rec-'));
});
test.afterEach(() => {
  removeDir(tmp);
});

test("dopo una chiusura anomala l'app offre il recupero e riapre il documento modificato", async () => {
  const file = join(tmp, 'cartella con spazi', 'Recupero àè.baap');
  writeFixtureProject(file);
  const first = await launchApp({ args: [file], env: { BAA_RECOVERY_MS: '500' } });
  await first.page.getByTestId('link-project-view').click();
  await first.page.getByTestId('tree-node-project').click();
  await first.page.getByTestId('panel-inspector').getByLabel('Autore').fill('Collaudo');
  await first.page.getByTestId('panel-inspector').getByLabel('Autore').press('Tab');

  // Aspetta la copia di recupero su disco: il .json si scrive per ultimo, quindi la voce è completa
  const recoveryDir = join(first.userData, 'recovery');
  const entries = () =>
    existsSync(recoveryDir) ? readdirSync(recoveryDir).filter((n) => n.endsWith('.json')) : [];
  await expect.poll(() => entries().length, { timeout: 15_000 }).toBe(1);
  await killAppTree(first.app);

  // Riavvio con lo stesso userData: la domanda compare e si risponde "Recupera"
  const second = await launchAppWithRetry({
    userData: first.userData,
    env: { BAA_RECOVERY_MS: '500', BAA_DIALOG_RESPONSES: '[0, 2]' },
  });
  await expect.poll(() => shownDialogs(second.app)).toHaveLength(1);
  expect((await shownDialogs(second.app))[0]).toContain('non è stato chiuso correttamente');
  await expect.poll(() => mainTitle(second.app)).toBe(`BaaPortal - ${file}`);

  // Il documento è aperto con la modifica...
  await second.page.getByTestId('link-project-view').click();
  await second.page.getByTestId('tree-node-project').click();
  await expect(second.page.getByTestId('panel-inspector').getByLabel('Autore')).toHaveValue(
    'Collaudo',
  );
  // ...ed è "modificato": chiudere la finestra chiede di salvare (lo stub risponde Annulla)
  await second.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await expect.poll(() => shownDialogs(second.app)).toHaveLength(2);
  expect(await windowCount(second.app)).toBe(1);
});
