import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { prereleaseBuild } from '../../src/main/update/buildChannel';

const desktop = resolve(__dirname, '../..');
const read = (...p: string[]) => readFileSync(resolve(desktop, ...p), 'utf8');

describe('prereleaseBuild', () => {
  it("è false solo per la stringa esatta 'false'", () => {
    expect(prereleaseBuild('false')).toBe(false);
    for (const v of [undefined, '', 'true', 'False', 'altro'])
      expect(prereleaseBuild(v)).toBe(true);
  });
});

describe('configurazione di rilascio', () => {
  const builder = yaml.load(read('electron-builder.yml')) as {
    publish: unknown;
    nsis: { artifactName: string };
    mac: { artifactName: string };
  };

  it('electron-builder.yml ha publish github con owner basoxxx e repo BaaPortal', () => {
    expect(builder.publish).toEqual({ provider: 'github', owner: 'basoxxx', repo: 'BaaPortal' });
  });
  it('electron-builder.yml: artifactName Windows e Mac invariati', () => {
    expect(builder.nsis.artifactName).toBe('${productName}-Setup-${version}.${ext}');
    expect(builder.mac.artifactName).toBe('${productName}-${version}-${arch}.${ext}');
  });
  it('package.json del desktop: electron-updater in dependencies, nessun @baaportal/* in dependencies', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.dependencies['electron-updater']).toMatch(/^\^6/);
    expect(Object.keys(pkg.dependencies).filter((n) => n.startsWith('@baaportal/'))).toEqual([]);
  });
  it('script dist: contiene --publish never', () => {
    expect(JSON.parse(read('package.json')).scripts.dist).toContain('--publish never');
  });
  it('electron.vite.config.ts: define di __BAA_PRERELEASE_BUILD__', () => {
    const cfg = read('electron.vite.config.ts');
    expect(cfg).toContain('__BAA_PRERELEASE_BUILD__');
    expect(cfg).toContain('prereleaseBuild(process.env.BAAPORTAL_PRERELEASE)');
  });
  it('release.yml: imposta BAAPORTAL_PRERELEASE da github.event.release.prerelease e da gh release view', () => {
    const rel = read('../../.github/workflows/release.yml');
    expect(rel).toContain('BAAPORTAL_PRERELEASE');
    expect(rel).toContain('github.event.release.prerelease');
    expect(rel).toContain('gh release view');
    expect(rel).toContain('isPrerelease');
    expect(rel).toContain('--repo "$GITHUB_REPOSITORY"');
    expect(rel).toContain('exit 1');
  });
  it('release.yml: il tag è confrontato con la versione del pacchetto prima di npm run dist', () => {
    const rel = read('../../.github/workflows/release.yml');
    const cmp = rel.indexOf('"v$version"');
    expect(rel).toContain('apps/desktop/package.json');
    expect(cmp).toBeGreaterThan(-1);
    expect(cmp).toBeLessThan(rel.indexOf('npm run dist'));
  });
  it("release.yml: carica exe, dmg, latest*.yml e blockmap, e lancia check-dist prima dell'upload", () => {
    const rel = read('../../.github/workflows/release.yml');
    for (const g of ['*.exe', '*.dmg', 'latest*.yml', '*.blockmap'])
      expect(rel).toContain(`apps/desktop/dist/${g}`);
    const check = rel.indexOf('apps/desktop/scripts/check-dist.mjs');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(rel.indexOf('gh release upload'));
  });
  it('ci.yml: lancia check-dist dopo npm run dist e salva latest*.yml', () => {
    const ci = read('../../.github/workflows/ci.yml');
    expect(ci.indexOf('check-dist.mjs')).toBeGreaterThan(ci.indexOf('npm run dist'));
    expect(ci).toContain('apps/desktop/dist/latest*.yml');
  });
});
