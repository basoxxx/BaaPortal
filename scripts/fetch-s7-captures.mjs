#!/usr/bin/env node
// Scarica le catture pubbliche di S7-300 elencate in packages/s7comm/test/captures/public.json
// in .cache/s7-captures/ (o in S7_CAPTURES_DIR), controllando lo SHA-256. Node puro, nessuna
// dipendenza; funziona su Windows e macOS. Un file che manca o ha un SHA diverso dà un avviso.
// Dopo 8 minuti in tutto (S7_CAPTURES_DEADLINE_MS) i file rimasti da scaricare si saltano con un avviso.
// Codice di uscita 0, salvo che tutti i file siano falliti (1).
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const listPath = join(root, 'packages', 's7comm', 'test', 'captures', 'public.json');
const destDir = process.env.S7_CAPTURES_DIR ?? join(root, '.cache', 's7-captures');
const ATTEMPTS = 3;
const TIMEOUT_MS = 60_000;
// Tetto al tempo totale: oltre, i file che restano si saltano con un avviso (la CI non resta appesa).
const DEADLINE_MS = Number(process.env.S7_CAPTURES_DEADLINE_MS ?? 8 * 60_000);
const deadline = Date.now() + DEADLINE_MS;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sha256OfFile(path) {
  try {
    return sha256(await readFile(path));
  } catch {
    return null;
  }
}

async function download(entry) {
  let last = 'errore sconosciuto';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (attempt > 1 && Date.now() >= deadline) break;
    try {
      const res = await fetch(entry.url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const got = sha256(buf);
      if (got === entry.sha256) return { buf };
      last = buf.subarray(0, 40).toString('latin1').startsWith('version https://git-lfs')
        ? 'risposta Git LFS (puntatore), non il file'
        : `SHA-256 diverso (${got})`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    if (attempt < ATTEMPTS && Date.now() < deadline) await sleep(1000 * 2 ** (attempt - 1));
  }
  return { error: last };
}

const list = JSON.parse(await readFile(listPath, 'utf8'));
let ok = 0;
let failed = 0;
for (const entry of list) {
  const parts = String(entry.file).split('/');
  if (isAbsolute(entry.file) || parts.some((p) => p === '' || p === '..' || p.includes('\\'))) {
    console.warn(`AVVISO ${entry.file}: percorso non valido nella lista, saltato`);
    failed++;
    continue;
  }
  if (!String(entry.url).startsWith('https://')) {
    console.warn(`AVVISO ${entry.file}: l'URL non è https, saltato`);
    failed++;
    continue;
  }
  const target = join(destDir, ...parts);
  if ((await sha256OfFile(target)) === entry.sha256) {
    console.log(`OK        ${entry.file} (già presente)`);
    ok++;
    continue;
  }
  if (Date.now() >= deadline) {
    console.warn(
      `AVVISO    ${entry.file}: tempo massimo (${DEADLINE_MS / 1000} s) esaurito, saltato`,
    );
    failed++;
    continue;
  }
  const r = await download(entry);
  if (r.error) {
    console.warn(`AVVISO    ${entry.file}: ${r.error} (${entry.url})`);
    failed++;
    continue;
  }
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.part`;
  await writeFile(tmp, r.buf);
  await rm(target, { force: true });
  await rename(tmp, target);
  console.log(`OK        ${entry.file} (scaricato, ${r.buf.length} byte)`);
  ok++;
}
console.log(
  `\nCatture S7: ${ok}/${list.length} a posto in ${destDir}${failed ? `, ${failed} non disponibili` : ''}.`,
);
process.exit(list.length > 0 && ok === 0 ? 1 : 0);
