import { expect, test } from '@playwright/test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './helpers';

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
