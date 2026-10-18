import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject as newProject, writeBaap } from '@baaportal/project';
import { createProject, expect, launchApp, shownDialogs, stubMessageBox, test } from './helpers';

const title = (app: Awaited<ReturnType<typeof launchApp>>['app']) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle());

test("una navigazione della pagina viene bloccata: l'app resta sulla sua pagina con il bridge", async () => {
  const { app, page } = await launchApp();
  const before = page.url();
  await page.evaluate(() => {
    location.href = 'file:///etc/hosts';
  });
  await page.waitForTimeout(500);
  expect(page.url()).toBe(before);
  expect(await page.evaluate(() => typeof window.baa.readFile)).toBe('function');
  expect(await page.evaluate(() => !!document.querySelector('[data-testid="app-root"]'))).toBe(
    true,
  );
  // window.open è negato: nessuna seconda finestra
  await page.evaluate(() => window.open('https://example.com'));
  await page.waitForTimeout(300);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
});

test('dopo una navigazione bloccata la chiusura chiede ancora di salvare le modifiche', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'baa-guard-'));
  try {
    const { app, page } = await launchApp();
    await stubMessageBox(app, 2);
    await createProject(page, 'Pressa', join(dir, 'p'));
    await page.getByRole('button', { name: 'Apri la vista progetto' }).first().click();
    await page.getByTestId('tree-node-project').click();
    await page.getByTestId('panel-inspector').getByLabel('Autore').fill('Modificato');
    await page.evaluate(() => {
      location.href = 'file:///etc/hosts';
    });
    await page.waitForTimeout(500);

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await expect.poll(() => shownDialogs(app)).toHaveLength(1);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dopo una ricarica la pagina si riannuncia: la chiusura chiede di nuovo di salvare', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'baa-guard-'));
  try {
    const { app, page } = await launchApp();
    await stubMessageBox(app, 2);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.reload(),
    );
    await page.waitForFunction(() => !!document.querySelector('#root > *'));
    await createProject(page, 'Pressa', join(dir, 'p'));
    await page.getByRole('button', { name: 'Apri la vista progetto' }).first().click();
    await page.getByTestId('tree-node-project').click();
    await page.getByTestId('panel-inspector').getByLabel('Autore').fill('Modificato');

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await expect.poll(() => shownDialogs(app)).toHaveLength(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('il rilascio di un file sulla finestra non lo apre nel renderer', async () => {
  const { page } = await launchApp();
  const prevented = await page.evaluate(() => {
    const results: boolean[] = [];
    for (const type of ['dragover', 'drop']) {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File(['x'], 'a.txt'));
      const ev = new DragEvent(type, { cancelable: true, bubbles: true, dataTransfer });
      document.body.dispatchEvent(ev);
      results.push(ev.defaultPrevented);
    }
    return results;
  });
  expect(prevented).toEqual([true, true]);
});

test('il trascinamento di solo testo non viene bloccato dalla protezione dei file', async () => {
  const { page } = await launchApp();
  const prevented = await page.evaluate(() => {
    const results: boolean[] = [];
    for (const type of ['dragover', 'drop']) {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/plain', 'Nastro');
      const ev = new DragEvent(type, { cancelable: true, bubbles: true, dataTransfer });
      document.body.dispatchEvent(ev);
      results.push(ev.defaultPrevented);
    }
    return results;
  });
  expect(prevented).toEqual([false, false]);
});

test('un renderer in crash non impedisce di chiudere la finestra', async () => {
  const { app } = await launchApp();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.forcefullyCrashRenderer();
  });
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.webContents.isCrashed(),
      ),
    )
    .toBe(true);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  // La finestra si chiude (e con lei l'app): evaluate può fallire perché l'app è già terminata.
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length).catch(() => 0),
    )
    .toBe(0);
});

test('open-file (macOS) ripristina una finestra minimizzata e apre il file', async () => {
  test.skip(process.platform !== 'darwin', 'open-file esiste solo su macOS');
  const dir = mkdtempSync(join(tmpdir(), 'baa-openfile-'));
  try {
    const file = join(dir, 'minimizzato.baap');
    writeFileSync(
      file,
      writeBaap(newProject({ name: 'Min', author: 'x', comment: '' }, new Date()), {
        appVersion: '0.1.0',
      }),
    );
    const { app } = await launchApp();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.minimize());
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized()),
      )
      .toBe(true);
    await app.evaluate(({ app: a }, p) => {
      a.emit('open-file', { preventDefault() {} }, p);
    }, file);
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized()),
      )
      .toBe(false);
    await expect.poll(() => title(app)).toBe(`BaaPortal - ${file}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const windowCount = (app: Awaited<ReturnType<typeof launchApp>>['app']) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

test('window.open about:blank con nome baa-editor-* apre una finestra; altri URL o nomi sono negati', async () => {
  const { app, page } = await launchApp();
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>)['__w'] = window.open('', 'baa-editor-x');
  });
  await expect.poll(() => windowCount(app)).toBe(2);
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>)['__a'] = window.open('', 'altro');
    (window as unknown as Record<string, unknown>)['__b'] = window.open(
      'https://example.com',
      'baa-editor-y',
    );
    (window as unknown as Record<string, unknown>)['__c'] = window.open('', 'baa-editor-x/../');
  });
  await page.waitForTimeout(500);
  expect(await windowCount(app)).toBe(2);
  // Chiudendo la principale (nessun documento aperto: nessuna conferma) si chiudono tutte.
  // (getAllWindows() non garantisce l'ordine: la principale si prende dalla pagina)
  const main = await app.browserWindow(page);
  await main.evaluate((w) => w.close());
  await expect.poll(() => windowCount(app).catch(() => 0)).toBe(0);
});

test('la finestra di un editor non può navigare né aprire altre finestre', async () => {
  const { app, page } = await launchApp();
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>)['__w'] = window.open('', 'baa-editor-n');
  });
  await expect.poll(() => windowCount(app)).toBe(2);
  const result = await page.evaluate(async () => {
    const child = (window as unknown as { __w: Window }).__w;
    child.location.href = 'https://example.com';
    await new Promise((r) => setTimeout(r, 500));
    const nested = child.open('about:blank', 'baa-editor-z');
    return { href: child.location.href, nested: nested === null };
  });
  expect(result.href).toBe('about:blank');
  await page.waitForTimeout(300);
  expect(await windowCount(app)).toBe(2);
  const main = await app.browserWindow(page);
  const mainId = await main.evaluate((w) => w.id);
  const childMenu = await app.evaluate(({ BrowserWindow }, id) => {
    const child = BrowserWindow.getAllWindows().find((w) => w.id !== id);
    return child?.isMenuBarVisible();
  }, mainId);
  // Su macOS il menu è dell'app, non della finestra: isMenuBarVisible non è significativo.
  if (process.platform !== 'darwin') expect(childMenu).toBe(false);
});

test("chiudere una finestra editor non chiede conferma e lascia l'app aperta", async () => {
  const { app, page } = await launchApp();
  await stubMessageBox(app, 2);
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>)['__w'] = window.open('', 'baa-editor-c');
  });
  await expect.poll(() => windowCount(app)).toBe(2);
  await page.evaluate(() => (window as unknown as { __w: Window }).__w.close());
  await expect.poll(() => windowCount(app)).toBe(1);
  expect(await shownDialogs(app)).toEqual([]);
});
