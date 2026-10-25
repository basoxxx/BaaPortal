// Controlla la cartella dist dopo `npm run dist`: i file di aggiornamento devono coincidere con gli
// installatori e l'app impacchettata deve contenere electron-updater. Uso: node check-dist.mjs [--merge-mac]
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import asar from '@electron/asar';
import yaml from 'js-yaml';

const OWNER = 'basoxxx';
const REPO = 'BaaPortal';
const ASAR_NEEDS = [
  '/node_modules/electron-updater/package.json',
  '/node_modules/builder-util-runtime/package.json',
];

function readYml(file, errors) {
  if (!existsSync(file)) {
    errors.push(`manca ${file}`);
    return null;
  }
  try {
    return yaml.load(readFileSync(file, 'utf8'));
  } catch (e) {
    errors.push(`${file} non è leggibile: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
    return null;
  }
}

// sha512 in base64 letto a blocchi (gli installatori pesano decine di MB), in modo sincrono.
function sha512Of(file) {
  const hash = createHash('sha512');
  const buf = Buffer.alloc(1 << 20);
  const fd = openSync(file, 'r');
  try {
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) hash.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hash.digest('base64');
}

function checkApp(resources, label, errors) {
  const asarFile = join(resources, 'app.asar');
  if (!existsSync(asarFile)) {
    errors.push(`${label}: manca app.asar`);
  } else {
    const entries = new Set(asar.listPackage(asarFile).map((p) => p.replaceAll('\\', '/')));
    for (const need of ASAR_NEEDS) {
      if (!entries.has(need)) errors.push(`${label}: app.asar non contiene ${need.split('/')[2]}`);
    }
  }
  const updFile = join(resources, 'app-update.yml');
  if (!existsSync(updFile)) {
    errors.push(`${label}: manca app-update.yml`);
    return;
  }
  const upd = yaml.load(readFileSync(updFile, 'utf8')) ?? {};
  if (upd.owner !== OWNER || upd.repo !== REPO) {
    errors.push(`${label}: app-update.yml non punta a ${OWNER}/${REPO}`);
  }
}

// Controlla un file di release, il suo blockmap (se richiesto) e la voce corrispondente di `files`.
function checkFile(dir, name, files, errors, blockmap = true) {
  const file = join(dir, name);
  if (!existsSync(file)) {
    errors.push(`manca ${name}`);
    return;
  }
  if (blockmap && !existsSync(`${file}.blockmap`)) errors.push(`manca ${name}.blockmap`);
  const entry = files.find((f) => f.url === name);
  if (!entry) {
    errors.push(`${name} non è elencato nei file di aggiornamento`);
    return;
  }
  const sha512 = sha512Of(file);
  if (entry.sha512 !== sha512)
    errors.push(`${name}: sha512 diverso da quello del file di aggiornamento`);
  if (entry.size !== statSync(file).size)
    errors.push(`${name}: size diversa da quella del file di aggiornamento`);
}

export function checkDist(dir, platform, version) {
  const errors = [];
  if (platform === 'win32') {
    checkApp(join(dir, 'win-unpacked', 'resources'), 'win-unpacked', errors);
    const latest = readYml(join(dir, 'latest.yml'), errors);
    if (latest) {
      if (latest.version !== version)
        errors.push(`latest.yml: version ${latest.version}, attesa ${version}`);
      checkFile(dir, `BaaPortal-Setup-${version}.exe`, latest.files ?? [], errors);
    }
  } else {
    checkApp(join(dir, 'mac-arm64', 'BaaPortal.app', 'Contents', 'Resources'), 'mac-arm64', errors);
    checkApp(join(dir, 'mac', 'BaaPortal.app', 'Contents', 'Resources'), 'mac', errors);
    const ymls = readdirSync(dir).filter((n) => /^latest-mac.*\.yml$/.test(n));
    if (ymls.length > 1) errors.push(`più di un latest-mac*.yml: ${ymls.join(', ')}`);
    const latest = readYml(join(dir, 'latest-mac.yml'), errors);
    if (latest) {
      if (latest.version !== version)
        errors.push(`latest-mac.yml: version ${latest.version}, attesa ${version}`);
      const files = latest.files ?? [];
      for (const arch of ['arm64', 'x64']) {
        const name = `BaaPortal-${version}-${arch}.dmg`;
        if (!files.some((f) => f.url === name))
          errors.push(`latest-mac.yml: manca ${arch} (${name})`);
        checkFile(dir, name, files, errors);
      }
    }
  }
  return errors;
}

// Ripiego mai servito: electron-builder oggi scrive già un solo latest-mac.yml con entrambe le
// architetture. Unisce i latest-mac*.yml (uno per architettura) in un solo latest-mac.yml: path e sha512 di primo
// livello dal file arm64.
export function mergeMac(dir) {
  const names = readdirSync(dir)
    .filter((n) => /^latest-mac.*\.yml$/.test(n))
    .sort(
      (a, b) => Number(b.includes('arm64')) - Number(a.includes('arm64')) || a.localeCompare(b),
    );
  if (names.length === 0) throw new Error('nessun latest-mac*.yml da unire');
  const docs = names.map((n) => yaml.load(readFileSync(join(dir, n), 'utf8')));
  const merged = { ...docs[0], files: docs.flatMap((d) => d.files ?? []) };
  for (const n of names) rmSync(join(dir, n));
  writeFileSync(join(dir, 'latest-mac.yml'), yaml.dump(merged, { lineWidth: -1 }));
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dist = join(desktop, 'dist');
  const version = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8')).version;
  const platform = process.platform === 'win32' ? 'win32' : 'darwin';
  if (process.argv.includes('--merge-mac')) mergeMac(dist);
  const errors = checkDist(dist, platform, version);
  if (errors.length > 0) {
    for (const e of errors) console.error(`check-dist: ${e}`);
    process.exit(1);
  }
  console.log(`check-dist: ok (${platform}, ${version})`);
}
