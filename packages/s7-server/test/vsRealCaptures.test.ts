import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decodeBlockInfo,
  decodeBlockInfoRequest,
  decodeBlockListOfType,
  decodeBlockListOfTypeRequest,
  decodeCotp,
  decodeReadRequest,
  decodeReadResponse,
  decodeS7,
  decodeSetup,
  decodeStartUpload,
  decodeStartUploadResponse,
  decodeSzlRequest,
  decodeUploadResponse,
  decodeUserdata,
  dissect,
  encodeCotp,
  encodeEndUpload,
  encodeUpload,
  encodeS7,
  parseBlockFile,
  parseBlockFileName,
  readPcap,
  type BlockListEntry,
  type BlockType,
  type CaptureStream,
  type DissectKind,
  type S7Pdu,
} from '@baaportal/s7comm';
import { FakeCpu, compareShape, errorOf } from '../src';
import { TestPeer, blockFile } from './helpers';
// aiuti di test già usati da s7comm per trovare le catture
import { allCaptures } from '../../s7comm/test/captures';

const READ_KINDS = new Set<DissectKind>([
  'setup',
  'readVar',
  'szl',
  'blockList',
  'blockInfo',
  'clock',
  'upload',
]);

interface Exchange {
  /** Indice (nella connessione) dell'ultimo frame della richiesta. */
  frame: number;
  kind: DissectKind;
  req: S7Pdu;
  resp: S7Pdu | undefined;
}

/** Ricompone le PDU S7 (anche su più DT) di una connessione, con l'indice del loro ultimo frame. */
function pdusOf(stream: CaptureStream): { frame: number; dir: 'tx' | 'rx'; pdu: S7Pdu }[] {
  const out: { frame: number; dir: 'tx' | 'rx'; pdu: S7Pdu }[] = [];
  const parts = { tx: [] as Uint8Array[], rx: [] as Uint8Array[] };
  stream.frames.forEach((f, i) => {
    try {
      const c = decodeCotp(f.bytes);
      if (c.type !== 'DT') return;
      parts[f.dir].push(c.data);
      if (!c.eot) return;
      const bytes = parts[f.dir].splice(0);
      const whole = new Uint8Array(bytes.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of bytes) {
        whole.set(p, at);
        at += p.length;
      }
      out.push({ frame: i, dir: f.dir, pdu: decodeS7(whole) });
    } catch {
      parts[f.dir].length = 0;
    }
  });
  return out;
}

function kindOf(pdu: S7Pdu): DissectKind {
  return dissect(encodeCotp({ type: 'DT', eot: true, data: encodeS7(pdu) })).kind;
}

/** Richieste S7 di una connessione che non sono letture (scritture, controllo, download...). */
function notReads(stream: CaptureStream): number {
  return pdusOf(stream).filter(
    ({ dir, pdu }) =>
      dir === 'tx' && (pdu.rosctr === 1 || pdu.rosctr === 7) && !READ_KINDS.has(kindOf(pdu)),
  ).length;
}

function exchangesOf(stream: CaptureStream): Exchange[] {
  const out: Exchange[] = [];
  const open = new Map<number, Exchange>();
  for (const { frame, dir, pdu } of pdusOf(stream)) {
    if (dir === 'tx') {
      if (pdu.rosctr !== 1 && pdu.rosctr !== 7) continue;
      const kind = kindOf(pdu);
      if (!READ_KINDS.has(kind)) continue;
      const x: Exchange = { frame, kind, req: pdu, resp: undefined };
      open.set(pdu.pduRef, x);
      out.push(x);
    } else {
      const x = open.get(pdu.pduRef);
      if (x && !x.resp && pdu.rosctr !== 1) {
        x.resp = pdu;
        open.delete(pdu.pduRef);
      }
    }
  }
  return out;
}

const ascii = (b: Uint8Array): string => String.fromCharCode(...b).trim();

/** Una CPU come quella della cattura: ordine, PDU, memoria e blocchi che la cattura mostra. */
function configure(xs: Exchange[]): FakeCpu {
  let pduLength = 240;
  let orderNumber: string | undefined;
  const sizes = { inputBytes: 2048, outputBytes: 2048, mBytes: 2048, timers: 256, counters: 256 };
  const dbSize = new Map<number, number>();
  const blocks = new Map<
    string,
    { type: BlockType; number: number; entry?: BlockListEntry; mc7: number; file?: Uint8Array }
  >();
  const touch = (type: BlockType, number: number) => {
    const k = `${type}:${number}`;
    let b = blocks.get(k);
    if (!b) blocks.set(k, (b = { type, number, mc7: 8 }));
    return b;
  };

  let list: { type: BlockType; frags: Uint8Array[] } | undefined;
  let up: { type: BlockType; number: number; total: number; chunks: Uint8Array[] } | undefined;
  for (const x of xs) {
    // i blocchi chiesti esistono nella finta anche se là la CPU vera li ha rifiutati
    try {
      if (x.kind === 'blockInfo') {
        const q = decodeBlockInfoRequest(decodeUserdata(x.req.param, x.req.data).payload);
        touch(q.type, q.number);
      } else if (x.kind === 'upload' && x.req.param[0] === 0x1d) {
        const n = parseBlockFileName(decodeStartUpload(x.req.param).fileName);
        touch(n.type, n.number);
      }
    } catch {
      // richiesta non leggibile: la salta anche il confronto
    }
    if (!x.resp || errorOf(x.resp) !== undefined) {
      continue;
    }
    try {
      if (x.kind === 'setup') {
        pduLength = Math.max(40, decodeSetup(x.resp.param).pduLength);
      } else if (x.kind === 'readVar') {
        const items = decodeReadRequest(x.req.param);
        const res = decodeReadResponse(x.resp.param, x.resp.data);
        items.forEach((it, i) => {
          if (!res[i]?.ok) return;
          const len =
            it.size === 'BIT'
              ? Math.ceil((it.bit ?? 0) / 8) + Math.ceil(it.count / 8)
              : (res[i] as { data: Uint8Array }).data.length;
          const end = it.start + len;
          if (it.area === 'DB' || it.area === 'DI')
            dbSize.set(it.db, Math.max(dbSize.get(it.db) ?? 0, end));
          else if (it.area === 'I') sizes.inputBytes = Math.max(sizes.inputBytes, end);
          else if (it.area === 'Q') sizes.outputBytes = Math.max(sizes.outputBytes, end);
          else if (it.area === 'M') sizes.mBytes = Math.max(sizes.mBytes, end);
          else if (it.area === 'T')
            sizes.timers = Math.min(2048, Math.max(sizes.timers, it.start + it.count));
          else if (it.area === 'C')
            sizes.counters = Math.min(2048, Math.max(sizes.counters, it.start + it.count));
        });
      } else if (x.kind === 'szl') {
        const u = decodeUserdata(x.req.param, x.req.data);
        if (u.param.dataUnitRef === undefined && u.payload.length === 4) {
          const r = decodeSzlRequest(u.payload);
          const ud = decodeUserdata(x.resp.param, x.resp.data);
          if ((r.id & 0xff) === 0x11 && r.id >> 8 <= 1 && ud.payload.length >= 8 + 22) {
            const idx = (ud.payload[8]! << 8) | ud.payload[9]!;
            if (idx === 1 || idx === 6) orderNumber ??= ascii(ud.payload.subarray(10, 30));
          }
        }
      } else if (x.kind === 'blockList') {
        const u = decodeUserdata(x.req.param, x.req.data);
        const r = decodeUserdata(x.resp.param, x.resp.data);
        if (u.param.subfunction === 2) {
          if (u.param.dataUnitRef === undefined)
            list = { type: decodeBlockListOfTypeRequest(u.payload), frags: [] };
          if (list) {
            list.frags.push(r.payload);
            if (!r.param.lastDataUnit) {
              for (const e of decodeBlockListOfType(list.frags))
                touch(list.type, e.number).entry = e;
              list = undefined;
            }
          }
        }
      } else if (x.kind === 'blockInfo') {
        const u = decodeUserdata(x.req.param, x.req.data);
        const r = decodeUserdata(x.resp.param, x.resp.data);
        const q = decodeBlockInfoRequest(u.payload);
        const info = decodeBlockInfo(r.payload);
        const b = touch(q.type, q.number);
        b.mc7 = Math.max(b.mc7, info.mc7Length ?? 0);
      } else if (x.kind === 'upload') {
        const fn = x.req.param[0];
        if (fn === 0x1d) {
          const n = parseBlockFileName(decodeStartUpload(x.req.param).fileName);
          up = {
            type: n.type,
            number: n.number,
            total: decodeStartUploadResponse(x.resp.param).totalLength ?? 0,
            chunks: [],
          };
        } else if (fn === 0x1e && up) {
          const r = decodeUploadResponse(x.resp.param, x.resp.data);
          up.chunks.push(r.chunk);
          if (!r.more) {
            const b = touch(up.type, up.number);
            const file = new Uint8Array(up.chunks.reduce((n, c) => n + c.length, 0));
            let at = 0;
            for (const c of up.chunks) {
              file.set(c, at);
              at += c.length;
            }
            try {
              parseBlockFile(file);
              b.file = file;
            } catch {
              b.mc7 = Math.max(b.mc7, up.total);
            }
            up = undefined;
          }
        }
      }
    } catch {
      // una richiesta che il codec non legge: la salta il confronto, qui non serve
    }
  }
  const cpu = new FakeCpu({ pduLength, orderNumber, sizes });
  for (const [n, size] of dbSize) touch('DB', n).mc7 = Math.max(touch('DB', n).mc7, size);
  for (const b of blocks.values()) {
    if (b.file) cpu.addBlock(b.file);
    else
      cpu.addBlock(
        blockFile(
          b.type,
          b.number,
          new Uint8Array(Math.min(b.mc7, 60000)),
          b.entry?.language ?? 1,
          b.entry?.flags ?? 0x01,
        ),
      );
  }
  return cpu;
}

interface Tally {
  compared: number;
  stateErrors: number;
  notReads: number;
  skipped: Map<string, number>;
  kinds: Map<string, number>;
  codes: Map<string, number>;
  diffs: string[];
}

const bump = (m: Map<string, number>, k: string): void => void m.set(k, (m.get(k) ?? 0) + 1);

async function replay(name: string, stream: CaptureStream): Promise<Tally> {
  const t: Tally = {
    compared: 0,
    stateErrors: 0,
    notReads: 0,
    skipped: new Map(),
    kinds: new Map(),
    codes: new Map(),
    diffs: [],
  };
  t.notReads = notReads(stream);
  const xs = exchangesOf(stream);
  const cpu = configure(xs);
  const peer = new TestPeer(cpu);
  await peer.connect();
  const lastFake = new Map<string, S7Pdu>();
  let fakeUploadId: number | undefined;
  for (const x of xs) {
    const skip = (why: string): void => bump(t.skipped, `${x.kind}: ${why}`);
    if (!x.resp) {
      skip('senza risposta nella cattura');
      continue;
    }
    let req = x.req;
    let continuation = false;
    let key = '';
    if (x.kind === 'readVar') {
      try {
        decodeReadRequest(req.param);
      } catch {
        skip('indirizzamento non S7ANY (simbolico o S7-400)');
        continue;
      }
    } else if (req.rosctr === 7) {
      let u;
      try {
        u = decodeUserdata(req.param, req.data);
      } catch {
        skip('userdata non decodificabile');
        continue;
      }
      key = `${u.param.group}/${u.param.subfunction}`;
      if (u.param.dataUnitRef !== undefined) {
        continuation = true;
        const last = lastFake.get(key);
        const lu = last ? decodeUserdata(last.param, last.data) : undefined;
        if (!lu || !lu.param.lastDataUnit) {
          skip('continuazione, ma la finta ha già finito');
          continue;
        }
        const param = req.param.slice();
        param[7] = lu.param.sequence;
        req = { ...req, param };
      } else if (x.kind === 'szl') {
        const r = decodeSzlRequest(u.payload);
        void r;
      }
    } else if (x.kind === 'upload') {
      const fn = req.param[0];
      if (fn === 0x1e || fn === 0x1f) {
        if (fakeUploadId === undefined) {
          skip('upload senza start confrontato');
          continue;
        }
        req = {
          ...req,
          param: fn === 0x1e ? encodeUpload(fakeUploadId) : encodeEndUpload(fakeUploadId),
        };
      }
    }
    const fake = await peer.send({
      rosctr: req.rosctr,
      param: req.param,
      data: req.data,
      pduRef: req.pduRef,
    });
    if (!fake) {
      t.diffs.push(`${name} frame ${x.frame}: la finta non ha risposto (${x.kind})`);
      continue;
    }
    if (req.rosctr === 7) lastFake.set(key, fake);
    if (x.kind === 'upload' && req.param[0] === 0x1d && fake.rosctr === 3) {
      fakeUploadId = decodeStartUploadResponse(fake.param).uploadId;
    }
    // SZL che la finta non ha: non è una differenza di forma, si conta a parte
    if (
      x.kind === 'szl' &&
      !continuation &&
      errorOf(x.resp) === undefined &&
      errorOf(fake) !== undefined
    ) {
      const r = decodeSzlRequest(decodeUserdata(x.req.param, x.req.data).payload);
      skip(`SZL 0x${r.id.toString(16).padStart(4, '0')}/${r.index} non implementata nella finta`);
      continue;
    }
    const realErr = errorOf(x.resp);
    if (realErr) {
      bump(t.codes, `${x.kind}: reale ${realErr} / finta ${errorOf(fake) ?? 'ok'}`);
    }
    const d = compareShape(x.resp, fake, { continuation, allowStateErrors: true });
    t.compared++;
    bump(t.kinds, x.kind);
    if (realErr && errorOf(fake) === undefined) t.stateErrors++;
    for (const m of d) t.diffs.push(`${name} frame ${x.frame} (${whatIs(x)}): ${m}`);
  }
  peer.close();
  return t;
}

function whatIs(x: Exchange): string {
  try {
    if (x.kind === 'szl') {
      const u = decodeUserdata(x.req.param, x.req.data);
      if (u.param.dataUnitRef !== undefined) return 'szl continuazione';
      const r = decodeSzlRequest(u.payload);
      return `szl 0x${r.id.toString(16)}/${r.index}`;
    }
  } catch {
    // descrizione generica
  }
  return x.kind;
}

const report: string[] = [];

describe('finta CPU contro risposte di CPU vere', () => {
  const caps = allCaptures();
  it('ci sono catture', () => {
    expect(caps.length).toBeGreaterThan(0);
  });
  for (const cap of caps) {
    it(`${cap.name}: stessa forma`, { timeout: 120_000 }, async () => {
      const streams = readPcap(readFileSync(cap.path));
      const total: Tally = {
        compared: 0,
        stateErrors: 0,
        notReads: 0,
        skipped: new Map(),
        kinds: new Map(),
        codes: new Map(),
        diffs: [],
      };
      for (const [i, s] of streams.entries()) {
        const t = await replay(`${cap.name}#${i}`, s);
        total.compared += t.compared;
        total.stateErrors += t.stateErrors;
        total.notReads += t.notReads;
        for (const [k, v] of t.skipped) total.skipped.set(k, (total.skipped.get(k) ?? 0) + v);
        for (const [k, v] of t.kinds) total.kinds.set(k, (total.kinds.get(k) ?? 0) + v);
        for (const [k, v] of t.codes) total.codes.set(k, (total.codes.get(k) ?? 0) + v);
        total.diffs.push(...t.diffs);
      }
      const j = (m: Map<string, number>): string => JSON.stringify(Object.fromEntries(m));
      report.push(
        `REPORT ${cap.name}\tcompared=${total.compared}\tstateErrors=${total.stateErrors}\tnotReads=${total.notReads}\tkinds=${j(total.kinds)}\tskipped=${j(total.skipped)}\tcodes=${j(total.codes)}`,
      );
      expect(total.diffs.slice(0, 25)).toEqual([]);
    });
  }
  it('rapporto', () => {
    expect(report.length).toBeGreaterThan(0);
    if (process.env['S7_VS_REPORT'])
      writeFileSync(process.env['S7_VS_REPORT'], report.join('\n') + '\n');
  });
});
