import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, launchApp, shownDialogs, stubMessageBox, test } from './helpers';

test('writeFileAtomic, readFile e fileExists funzionano attraverso il bridge', async () => {
  const { app, page } = await launchApp();
  const dir = mkdtempSync(join(tmpdir(), 'baa-bridge-'));
  try {
    const path = join(dir, 'sub', 'a.baap');
    const result = await page.evaluate(async (p) => {
      await window.baa.writeFileAtomic(p, new Uint8Array([1, 2, 3]));
      const data = await window.baa.readFile(p);
      return { bytes: Array.from(data), exists: await window.baa.fileExists(p) };
    }, path);
    expect(result).toEqual({ bytes: [1, 2, 3], exists: true });
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeFileAtomic in cartella di sola lettura rifiuta con code e message originali', async () => {
  test.skip(process.platform === 'win32' || process.getuid?.() === 0, 'permessi non applicabili');
  const { app, page } = await launchApp();
  const dir = mkdtempSync(join(tmpdir(), 'baa-bridge-ro-'));
  chmodSync(dir, 0o555);
  try {
    const err = await page.evaluate(
      async (p) => {
        try {
          await window.baa.writeFileAtomic(p, new Uint8Array([1]));
          return null;
        } catch (e) {
          const x = e as { code?: string; message: string };
          return { code: x.code, message: x.message };
        }
      },
      join(dir, 'a.baap'),
    );
    expect(err).not.toBeNull();
    expect(['EACCES', 'EPERM']).toContain(err?.code);
    expect(err?.message).toContain(dir);
  } finally {
    await app.close();
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appunti e recupero attraverso il bridge', async () => {
  const { page } = await launchApp();
  const r = await page.evaluate(async () => {
    window.baa.clipboardWriteText('a\tb');
    const text = await window.baa.clipboardReadText();
    const info = {
      originalPath: '/x/a.baap',
      projectName: 'Pressa',
      savedAt: '2026-10-18T10:00:00Z',
    };
    await window.baa.recoveryWrite('k1', new Uint8Array([4, 5]), info);
    const list = await window.baa.recoveryList();
    const data = Array.from(await window.baa.recoveryRead('k1'));
    await window.baa.recoveryDelete('k1');
    await window.baa.recoveryDelete('k1');
    const after = await window.baa.recoveryList();
    const bad = async (f: () => Promise<unknown>) => {
      try {
        await f();
        return null;
      } catch (e) {
        return (e as { code?: string }).code;
      }
    };
    return {
      text,
      list,
      data,
      after,
      badWrite: await bad(() => window.baa.recoveryWrite('../x', new Uint8Array(), info)),
      badRead: await bad(() => window.baa.recoveryRead('../x')),
      badDelete: await bad(() => window.baa.recoveryDelete('../x')),
      missing: await bad(() => window.baa.recoveryRead('nessuna')),
    };
  });
  expect(r.text).toBe('a\tb');
  expect(r.list).toEqual([
    {
      key: 'k1',
      info: { originalPath: '/x/a.baap', projectName: 'Pressa', savedAt: '2026-10-18T10:00:00Z' },
    },
  ]);
  expect(r.data).toEqual([4, 5]);
  expect(r.after).toEqual([]);
  expect([r.badWrite, r.badRead, r.badDelete]).toEqual([
    'INVALID_KEY',
    'INVALID_KEY',
    'INVALID_KEY',
  ]);
  expect(r.missing).toBe('ENOENT');
});

test('askQuestion mostra la finestra nativa con Sì/No e restituisce la scelta', async () => {
  const { app, page } = await launchApp();
  const ask = () =>
    page.evaluate(() =>
      window.baa.askQuestion({ title: 'Recupero', message: 'Ripristinare?', yes: 'Sì', no: 'No' }),
    );
  await stubMessageBox(app, 0);
  expect(await ask()).toBe(true);
  await stubMessageBox(app, 1);
  expect(await ask()).toBe(false);
  expect(await shownDialogs(app)).toEqual(['Ripristinare?']);
});

test("testOverrides restituisce l'intervallo di BAA_RECOVERY_MS", async () => {
  const a = await launchApp({ env: { BAA_RECOVERY_MS: '500' } });
  expect(await a.page.evaluate(() => window.baa.testOverrides())).toEqual({
    recoveryIntervalMs: 500,
  });
  await a.app.close();
  const b = await launchApp();
  expect(await b.page.evaluate(() => window.baa.testOverrides())).toEqual({});
  await b.app.close();
  const c = await launchApp({ env: { BAA_RECOVERY_MS: 'abc' } });
  expect(await c.page.evaluate(() => window.baa.testOverrides())).toEqual({});
});

test('un userData riusato con launchApp({ userData }) conserva i file di recupero', async () => {
  const a = await launchApp();
  await a.page.evaluate(() =>
    window.baa.recoveryWrite('k2', new Uint8Array([1]), {
      originalPath: '',
      projectName: 'P',
      savedAt: 's',
    }),
  );
  await a.app.close();
  const b = await launchApp({ userData: a.userData });
  expect((await b.page.evaluate(() => window.baa.recoveryList())).map((e) => e.key)).toEqual([
    'k2',
  ]);
});
