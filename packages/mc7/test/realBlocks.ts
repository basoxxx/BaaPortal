import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { decodeCotp, decodeS7, type S7Pdu } from '@baaportal/s7comm';
import { allCaptures, framesOf } from '../../s7comm/test/captures';

/**
 * Blocchi reali per i test del compilatore MC7.
 *
 * - Dalle catture pubbliche: upload (0x1d/0x1e) e download (0x1b) estratti con @baaportal/s7comm.
 *   La cattura cisagov del repository c'è sempre; le altre vengono da `.cache/s7-captures/`.
 * - Da `.cache/mc7-blocks/` (scaricati da `scripts/fetch-s7-captures.mjs`, elenco in
 *   `blocks.json`): blocchi di DotNetSiemens e rz-libmc7, solo dati di prova, mai committati.
 */
export interface RealBlock {
  name: string;
  bytes: Uint8Array;
  source: string;
}

interface ListEntry {
  file: string;
  sha256: string;
}
const LIST = JSON.parse(readFileSync(resolve(__dirname, 'blocks.json'), 'utf8')) as ListEntry[];

const MC7_DIR = process.env['MC7_BLOCKS_DIR'] ?? resolve(__dirname, '../../../.cache/mc7-blocks');

const TYPE_NAMES: Record<number, string> = {
  0x08: 'OB',
  0x0a: 'DB',
  0x0b: 'SDB',
  0x0c: 'FC',
  0x0d: 'SFC',
  0x0e: 'FB',
  0x0f: 'SFB',
};

function pdusOf(path: string): S7Pdu[] {
  const out: S7Pdu[] = [];
  let acc: Uint8Array[] = [];
  for (const t of framesOf(path)) {
    let c;
    try {
      c = decodeCotp(t);
    } catch {
      continue;
    }
    if (c.type !== 'DT') continue;
    acc.push(c.data);
    if (!c.eot) continue;
    const all = new Uint8Array(acc.reduce((n, x) => n + x.length, 0));
    let o = 0;
    for (const x of acc) {
      all.set(x, o);
      o += x.length;
    }
    acc = [];
    try {
      out.push(decodeS7(all));
    } catch {
      /* non S7 */
    }
  }
  return out;
}

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};

/** Blocchi (upload e download) di una cattura. Solo estrazione: nessun codec qui. */
function blocksOfCapture(path: string): Uint8Array[] {
  const blocks: Uint8Array[] = [];
  let up: Uint8Array[] | null = null;
  let dl: Uint8Array[] = [];
  for (const pdu of pdusOf(path)) {
    if (pdu.rosctr === 7 || pdu.rosctr === 2) continue;
    const fn = pdu.param[0];
    const res = pdu.rosctr !== 1;
    if (fn === 0x1d && res) up = [];
    else if (fn === 0x1e && res && up) {
      // risposta di upload: param[1] = "ci sono altri frammenti"; dati = len(2) + 00fb + blocco
      const d = pdu.data;
      if (d.length >= 4 && (d[0]! << 8) + d[1]! === d.length - 4) up.push(d.slice(4));
      if (pdu.param[1] === 0) {
        blocks.push(concat(up));
        up = null;
      }
    } else if (fn === 0x1b && res) {
      const d = pdu.data;
      if (d.length >= 4 && (d[0]! << 8) + d[1]! === d.length - 4) {
        dl.push(d.slice(4));
        if (pdu.param[1] === 0) {
          blocks.push(concat(dl));
          dl = [];
        }
      }
    }
  }
  return blocks.filter((b) => b.length >= 72 && b[0] === 0x70 && b[1] === 0x70);
}

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

function describe(b: Uint8Array): string {
  const kind = TYPE_NAMES[b[5]!] ?? `T${b[5]!.toString(16)}`;
  return `${kind}${(b[6]! << 8) | b[7]!}`;
}

let cache: RealBlock[] | undefined;
let warned = false;

/** Tutti i blocchi reali disponibili, senza doppioni (stessi byte). Avvisa una volta se ne mancano. */
export function realBlocks(): RealBlock[] {
  if (cache) return cache;
  const seen = new Set<string>();
  const out: RealBlock[] = [];
  const add = (name: string, bytes: Uint8Array, source: string): void => {
    const h = sha(bytes);
    if (seen.has(h)) return;
    seen.add(h);
    out.push({ name, bytes, source });
  };
  for (const cap of allCaptures()) {
    for (const b of blocksOfCapture(cap.path)) add(`${describe(b)} (${cap.name})`, b, cap.name);
  }
  const fromCaptures = out.length;
  let thirdParty = 0;
  const bad: string[] = [];
  // Solo i file elencati in blocks.json, col loro SHA-256: un file in cache con un SHA diverso
  // (o non più in elenco, come i blocchi protetti know-how) non conta.
  for (const e of LIST) {
    const path = join(MC7_DIR, ...e.file.split('/'));
    if (!existsSync(path)) continue;
    const bytes = new Uint8Array(readFileSync(path));
    if (sha(bytes) !== e.sha256) {
      bad.push(e.file);
      continue;
    }
    add(e.file.replace(/\.bin$/, '').replace(/^.*\//, ''), bytes, e.file);
    thirdParty++;
  }
  if (bad.length > 0) {
    console.warn(
      `[mc7] blocchi in cache con SHA-256 diverso, ignorati: ${bad.join(', ')} ` +
        `(node scripts/fetch-s7-captures.mjs li riscarica)`,
    );
  }
  if (!warned && (thirdParty < LIST.length || fromCaptures < 12)) {
    warned = true;
    console.warn(
      `[mc7] blocchi reali: ${out.length} su ${12 + LIST.length} (catture ${fromCaptures}/12, terzi ${thirdParty}/${LIST.length}). ` +
        `Per averli tutti: node scripts/fetch-s7-captures.mjs`,
    );
  }
  cache = out;
  return out;
}
