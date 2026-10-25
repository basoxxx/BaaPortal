import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as asar from '@electron/asar';
import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkDist, mergeMac } from '../../scripts/check-dist.mjs';

const V = '1.2.3';
const sha = (b: Buffer) => createHash('sha512').update(b).digest('base64');
let root: string;
let dist: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'baa-dist-'));
  dist = join(root, 'dist');
  mkdirSync(dist);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function makeAsar(resources: string, withUpdater = true, withUpdateYml = true) {
  const src = join(root, 'src-' + Math.random().toString(36).slice(2));
  mkdirSync(join(src, 'node_modules', 'builder-util-runtime'), { recursive: true });
  writeFileSync(join(src, 'node_modules', 'builder-util-runtime', 'package.json'), '{}');
  if (withUpdater) {
    mkdirSync(join(src, 'node_modules', 'electron-updater'), { recursive: true });
    writeFileSync(join(src, 'node_modules', 'electron-updater', 'package.json'), '{}');
  }
  mkdirSync(resources, { recursive: true });
  await asar.createPackage(src, join(resources, 'app.asar'));
  if (withUpdateYml) {
    writeFileSync(
      join(resources, 'app-update.yml'),
      'provider: github\nowner: basoxxx\nrepo: BaaPortal\n',
    );
  }
}

function artifact(name: string, content: string) {
  const buf = Buffer.from(content);
  writeFileSync(join(dist, name), buf);
  writeFileSync(join(dist, name + '.blockmap'), 'map');
  return { url: name, sha512: sha(buf), size: buf.length };
}

async function fakeWin(opts: { badSha?: boolean; updater?: boolean; updateYml?: boolean } = {}) {
  const f = artifact(`BaaPortal-Setup-${V}.exe`, 'win-exe');
  writeFileSync(
    join(dist, 'latest.yml'),
    yaml.dump({
      version: V,
      files: [opts.badSha ? { ...f, sha512: 'xxx' } : f],
      path: f.url,
      sha512: f.sha512,
    }),
  );
  await makeAsar(
    join(dist, 'win-unpacked', 'resources'),
    opts.updater ?? true,
    opts.updateYml ?? true,
  );
}

async function fakeMac(archs: ('arm64' | 'x64')[] = ['arm64', 'x64']) {
  const files = archs.map((a) => artifact(`BaaPortal-${V}-${a}.dmg`, 'dmg-' + a));
  writeFileSync(
    join(dist, 'latest-mac.yml'),
    yaml.dump({ version: V, files, path: files[0]!.url, sha512: files[0]!.sha512 }),
  );
  await makeAsar(join(dist, 'mac-arm64', 'BaaPortal.app', 'Contents', 'Resources'));
  await makeAsar(join(dist, 'mac', 'BaaPortal.app', 'Contents', 'Resources'));
}

describe('checkDist', () => {
  it('cartella Windows completa: nessun errore', async () => {
    await fakeWin();
    expect(await checkDist(dist, 'win32', V)).toEqual([]);
  });
  it('cartella macOS completa: nessun errore', async () => {
    await fakeMac();
    expect(await checkDist(dist, 'darwin', V)).toEqual([]);
  });
  it("latest.yml con sha512 diverso dall'exe: errore", async () => {
    await fakeWin({ badSha: true });
    const errs: string[] = await checkDist(dist, 'win32', V);
    expect(errs.some((e) => /sha512/.test(e))).toBe(true);
  });
  it('latest-mac.yml con il solo DMG arm64: errore «manca x64»', async () => {
    await fakeMac(['arm64']);
    const errs: string[] = await checkDist(dist, 'darwin', V);
    expect(errs.some((e) => /manca x64/.test(e))).toBe(true);
  });
  it('manca electron-updater in app.asar: errore', async () => {
    await fakeWin({ updater: false });
    const errs: string[] = await checkDist(dist, 'win32', V);
    expect(errs.some((e) => /electron-updater/.test(e))).toBe(true);
  });
  it('manca app-update.yml: errore', async () => {
    await fakeWin({ updateYml: false });
    const errs: string[] = await checkDist(dist, 'win32', V);
    expect(errs.some((e) => /app-update\.yml/.test(e))).toBe(true);
  });
});

describe('mergeMac', () => {
  it('due yml, uno per architettura: un file con entrambi', () => {
    const arm = artifact(`BaaPortal-${V}-arm64.dmg`, 'a');
    const x64 = artifact(`BaaPortal-${V}-x64.dmg`, 'b');
    writeFileSync(
      join(dist, 'latest-mac-arm64.yml'),
      yaml.dump({ version: V, files: [arm], path: arm.url, sha512: arm.sha512 }),
    );
    writeFileSync(
      join(dist, 'latest-mac-x64.yml'),
      yaml.dump({ version: V, files: [x64], path: x64.url, sha512: x64.sha512 }),
    );
    mergeMac(dist);
    const merged = yaml.load(readFileSync(join(dist, 'latest-mac.yml'), 'utf8')) as {
      version: string;
      path: string;
      sha512: string;
      files: { url: string }[];
    };
    expect(merged.version).toBe(V);
    expect(merged.files.map((f) => f.url)).toEqual([arm.url, x64.url]);
    expect(merged.path).toBe(arm.url);
    expect(merged.sha512).toBe(arm.sha512);
    expect(readdirSync(dist).filter((n) => /^latest-mac.*\.yml$/.test(n))).toEqual([
      'latest-mac.yml',
    ]);
  });
});
