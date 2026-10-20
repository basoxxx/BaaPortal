import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readPcap } from '../src';

/**
 * Aiuti di test per le catture reali.
 *
 * - cisagov (BSD-3) sta nel repository: i test su di esse girano sempre, CI compresa.
 * - Le altre sono scaricate da `scripts/fetch-s7-captures.mjs` in `.cache/s7-captures/`
 *   (oppure nella cartella di `S7_CAPTURES_DIR`). Se mancano, i test che le usano le saltano.
 */
export const CISAGOV_DIR = resolve(__dirname, 'captures/cisagov');
export const CACHE_DIR =
  process.env['S7_CAPTURES_DIR'] ?? resolve(__dirname, '../../../.cache/s7-captures');

export interface CaptureFile {
  /** Percorso assoluto. */
  path: string;
  /** Nome breve per i messaggi: `cisagov/snap7.pcap`, `icspcap/...`. */
  name: string;
}

const PCAP_RE = /\.pcap(ng)?$/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (PCAP_RE.test(n)) out.push(p);
  }
  return out.sort();
}

/** Le catture del repository (sempre presenti). */
export function bundledCaptures(): CaptureFile[] {
  return walk(CISAGOV_DIR).map((path) => ({
    path,
    name: `cisagov/${path.slice(CISAGOV_DIR.length + 1)}`,
  }));
}

/** Le catture scaricate. Le copie di cisagov nella stessa cartella non si contano due volte. */
export function downloadedCaptures(): CaptureFile[] {
  if (!existsSync(CACHE_DIR)) return [];
  return walk(CACHE_DIR)
    .map((path) => ({ path, name: path.slice(CACHE_DIR.length + 1).replace(/\\/g, '/') }))
    .filter((c) => !/^(cisa|cisagov)\//.test(c.name));
}

/** Tutte le catture disponibili: prima quelle del repository. */
export function allCaptures(): CaptureFile[] {
  return [...bundledCaptures(), ...downloadedCaptures()];
}

interface PublicEntry {
  file: string;
  url: string;
  sha256: string;
  license: string;
}

/** Catture elencate in public.json e non presenti nella cartella di cache. */
export function missingCaptures(): string[] {
  const list = JSON.parse(
    readFileSync(resolve(__dirname, 'captures/public.json'), 'utf8'),
  ) as PublicEntry[];
  return list.map((e) => e.file).filter((f) => !existsSync(join(CACHE_DIR, ...f.split('/'))));
}

/** Tutti i frame (payload TPKT, senza header) di una cattura, flusso dopo flusso. */
export function framesOf(path: string): Uint8Array[] {
  return readPcap(readFileSync(path)).flatMap((s) => s.frames.map((f) => f.bytes));
}
