import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collect,
  decodeBlockInfoRequest,
  decodeCotp,
  decodeS7,
  decodeUserdata,
  dissect,
  encodeCotp,
  encodeS7,
  kitZip,
  parseBlockFile,
  readKitZip,
  type CapturedFrame,
  type DissectKind,
  type KitSummary,
  type S7Pdu,
} from '@baaportal/s7comm';
import { FakeCpu, compareShape, errorOf } from '../src';
import { TestPeer } from './helpers';
import { cpuWithBlocks, memoryFactory } from './kitRig';

// Registro privato: gli zip dei kit raccolti su CPU vere stanno in <repo>/fixtures-private/kit/
// (cartella ignorata da git). Senza zip i test su quelle cartelle risultano saltati.
const DIR = join(import.meta.dirname, '../../../fixtures-private/kit');
const realZips = existsSync(DIR)
  ? readdirSync(DIR)
      .filter((f) => f.toLowerCase().endsWith('.zip'))
      .sort()
  : [];

const ROUNDTRIP = new Set<DissectKind>([
  'setup',
  'readVar',
  'szl',
  'blockList',
  'blockInfo',
  'clock',
  'upload',
]);

/** Ricompone le PDU S7 complete (anche su più DT) di una sola direzione, con l'indice del frame. */
function pdus(frames: CapturedFrame[]): { i: number; dir: 'tx' | 'rx'; pdu: S7Pdu }[] {
  const out: { i: number; dir: 'tx' | 'rx'; pdu: S7Pdu }[] = [];
  const parts = { tx: [] as Uint8Array[], rx: [] as Uint8Array[] };
  frames.forEach((f, i) => {
    try {
      const c = decodeCotp(f.bytes);
      if (c.type === 'CR') {
        parts.tx.length = 0;
        parts.rx.length = 0;
      }
      if (c.type !== 'DT') return;
      parts[f.dir].push(c.data);
      if (!c.eot) return;
      const chunks = parts[f.dir].splice(0);
      const whole = new Uint8Array(chunks.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of chunks) {
        whole.set(p, at);
        at += p.length;
      }
      out.push({ i, dir: f.dir, pdu: decodeS7(whole) });
    } catch {
      parts[f.dir].length = 0;
    }
  });
  return out;
}

function checkZip(bytes: Uint8Array, label: string): void {
  const z = readKitZip(bytes);
  expect(z.frames.length, `${label}: frame`).toBeGreaterThan(0);

  // 1. ogni frame si ricodifica identico (allowlist) oppure se ne legge l'intestazione
  for (const [i, f] of z.frames.entries()) {
    const d = dissect(f.bytes);
    expect(d.kind, `${label}: frame ${i} malformato: ${d.error ?? ''}`).not.toBe('malformed');
    if (d.cotp) expect(encodeCotp(d.cotp), `${label}: frame ${i} COTP`).toEqual(f.bytes);
    if (d.s7 && ROUNDTRIP.has(d.kind)) {
      const back = encodeCotp({ type: 'DT', eot: true, data: encodeS7(d.s7) });
      expect(back, `${label}: frame ${i} (${d.kind}) non si ricodifica identico`).toEqual(f.bytes);
    }
  }

  // 2. ogni blocco si legge; gli avvisi si riportano
  const notes: string[] = [];
  for (const [name, bytes] of Object.entries(z.blocks)) {
    const p = parseBlockFile(bytes);
    for (const w of p.warnings ?? []) notes.push(`${label}: ${name}: ${w}`);
  }
  if (notes.length > 0) console.warn(`avvisi di parseBlockFile:\n${notes.join('\n')}`);
  expect(z.summary.refusedCount).toBe(0);
}

/** Una finta configurata come lo zip: numero d'ordine, PDU e blocchi caricati. */
function fakeLike(summary: KitSummary, blocks: Record<string, Uint8Array>): FakeCpu {
  const cpu = new FakeCpu({
    orderNumber: summary.identity?.orderNumber || undefined,
    pduLength: summary.pduLength && summary.pduLength >= 40 ? summary.pduLength : undefined,
  });
  for (const b of Object.values(blocks)) cpu.addBlock(b);
  return cpu;
}

/** Ripete le richieste di lettura del registro alla finta e confronta la forma delle risposte. */
async function replayShapes(bytes: Uint8Array, label: string): Promise<number> {
  const z = readKitZip(bytes);
  const cpu = fakeLike(z.summary, z.blocks);
  const peer = new TestPeer(cpu);
  await peer.connect();
  const all = pdus(z.frames);
  const open = new Map<number, S7Pdu>();
  const lastFake = new Map<string, S7Pdu>();
  let fakeUploadId: number | undefined;
  let compared = 0;
  const diffs: string[] = [];
  for (const { i, dir, pdu } of all) {
    if (dir === 'tx') {
      if (pdu.rosctr === 1 || pdu.rosctr === 7) open.set(pdu.pduRef, pdu);
      continue;
    }
    const req = open.get(pdu.pduRef);
    if (!req || pdu.rosctr === 1) continue;
    open.delete(pdu.pduRef);
    const kind = dissect(encodeCotp({ type: 'DT', eot: true, data: encodeS7(req) })).kind;
    if (!ROUNDTRIP.has(kind) || kind === 'readVar') continue;
    let sent = req;
    let continuation = false;
    let key = '';
    if (req.rosctr === 7) {
      const u = decodeUserdata(req.param, req.data);
      key = `${u.param.group}/${u.param.subfunction}`;
      if (u.param.dataUnitRef !== undefined) {
        continuation = true;
        const last = lastFake.get(key);
        const lu = last && decodeUserdata(last.param, last.data);
        if (!lu || !lu.param.lastDataUnit) continue;
        const param = req.param.slice();
        param[7] = lu.param.sequence;
        sent = { ...req, param };
      }
    } else if (kind === 'upload') {
      const fn = req.param[0];
      if (fn === 0x1e || fn === 0x1f) continue; // solo lo start si confronta
    }
    if (kind === 'blockInfo') {
      // l'info di un blocco non caricato nello zip: la finta non lo ha
      try {
        const q = decodeBlockInfoRequest(decodeUserdata(req.param, req.data).payload);
        if (!cpu.block(q.type, q.number)) continue;
      } catch {
        continue;
      }
    }
    const fake = await peer.send({
      rosctr: sent.rosctr,
      param: sent.param,
      data: sent.data,
      pduRef: sent.pduRef,
    });
    if (!fake) {
      diffs.push(`${label} frame ${i}: la finta non ha risposto (${kind})`);
      continue;
    }
    if (req.rosctr === 7) lastFake.set(key, fake);
    void fakeUploadId;
    // SZL che la finta non ha: non è una differenza di forma
    if (
      kind === 'szl' &&
      !continuation &&
      errorOf(pdu) === undefined &&
      errorOf(fake) !== undefined
    )
      continue;
    // upload: il blocco deve esserci nella finta, altrimenti non c'è nulla da confrontare
    if (kind === 'upload' && errorOf(fake) !== undefined && errorOf(pdu) === undefined) continue;
    compared++;
    for (const m of compareShape(pdu, fake, {
      continuation,
      allowStateErrors: true,
      request: sent,
    })) {
      diffs.push(`${label} frame ${i} (${kind}): ${m}`);
    }
  }
  peer.close();
  expect(diffs.slice(0, 25)).toEqual([]);
  return compared;
}

if (realZips.length === 0) {
  console.warn(
    'fixtures-private/kit/ non ha zip: la regressione sui kit veri è saltata (resta quella sullo zip generato dalla finta).',
  );
}

describe.skipIf(realZips.length === 0)('regressione privata sui kit raccolti', () => {
  it.skipIf(realZips.length > 0)('ci sono zip in fixtures-private/kit/', () => undefined);
  for (const name of realZips) {
    const bytes = (): Uint8Array => new Uint8Array(readFileSync(join(DIR, name)));
    it(`${name}: frame, blocchi e avvisi`, () => checkZip(bytes(), name));
    it(`${name}: le risposte vere hanno la stessa forma della finta`, async () => {
      expect(await replayShapes(bytes(), name)).toBeGreaterThan(0);
    });
  }
});

describe('stessa regressione su uno zip generato dalla finta (mai vuota)', () => {
  it('scritto in una cartella temporanea, riletto dal disco, controllato come uno vero', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'baa-kit-'));
    try {
      const cpu = cpuWithBlocks();
      const r = await collect(
        {
          host: 'fake',
          includeBlocks: true,
          minIntervalMs: 0,
          timeoutMs: 2000,
          transport: memoryFactory(() => cpu),
        },
        () => undefined,
      );
      const file = join(dir, 'finto.zip');
      writeFileSync(file, kitZip(r));
      const bytes = new Uint8Array(readFileSync(file));
      checkZip(bytes, 'finto.zip');
      expect(Object.keys(readKitZip(bytes).blocks)).toHaveLength(5);
      expect(await replayShapes(bytes, 'finto.zip')).toBeGreaterThan(20);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
