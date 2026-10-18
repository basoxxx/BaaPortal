import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeBaap, createProject as newProject } from '@baaportal/project';
import { expect, launchApp, spawnSecondInstance, test, removeDir } from './helpers';

let tmp: string;
test.beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'baa-single-'));
});
test.afterEach(() => {
  removeDir(tmp);
});

const title = (app: Awaited<ReturnType<typeof launchApp>>['app']) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle());

test("aprire un .baap con l'app già aperta lo apre nella finestra esistente", async () => {
  const file = join(tmp, 'progetto.baap');
  writeFileSync(
    file,
    writeBaap(newProject({ name: 'Progetto', author: 'x', comment: '' }, new Date()), {
      appVersion: '0.1.0',
    }),
  );
  const { app, userData } = await launchApp();
  expect(await spawnSecondInstance(userData, file)).toBe(0);
  await expect.poll(() => title(app)).toBe(`BaaPortal - ${file}`);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  await app.close();
});

test("un .baap passato alla riga di comando all'avvio si apre da solo", async () => {
  const file = join(tmp, 'avvio.baap');
  writeFileSync(
    file,
    writeBaap(newProject({ name: 'Avvio', author: 'x', comment: '' }, new Date()), {
      appVersion: '0.1.0',
    }),
  );
  const { app } = await launchApp({ args: [file] });
  await expect.poll(() => title(app)).toBe(`BaaPortal - ${file}`);
  await app.close();
});
