import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildBlockFile,
  decodeCotp,
  decodeEndUpload,
  decodeEndUploadResponse,
  decodeS7,
  decodeStartUpload,
  decodeStartUploadResponse,
  decodeUploadRequest,
  decodeUploadResponse,
  encodeEndUpload,
  encodeEndUploadResponse,
  encodeStartUpload,
  encodeStartUploadResponse,
  encodeUpload,
  encodeUploadResponse,
  hex,
  parseBlockFile,
  parseBlockFileName,
  type S7Pdu,
} from '../src';
import { DIR, HAVE, files, tpkts } from './captures';

if (!HAVE) console.warn(`[realUpload] catture assenti in ${DIR}: test saltato`);

interface Stats {
  startReq: number;
  startRes: number;
  upReq: number;
  upRes: number;
  endReq: number;
  endRes: number;
  blocks: number;
  rebuilt: number;
  noFooter: number;
  rest: number;
  dlChunks: number;
  dlBlocks: number;
  dlRebuilt: number;
  mismatch: number;
}

const zero = (): Stats => ({
  startReq: 0,
  startRes: 0,
  upReq: 0,
  upRes: 0,
  endReq: 0,
  endRes: 0,
  blocks: 0,
  rebuilt: 0,
  noFooter: 0,
  rest: 0,
  dlChunks: 0,
  dlBlocks: 0,
  dlRebuilt: 0,
  mismatch: 0,
});

/** Ricompone i segmenti COTP DT (eot=0) di una PDU S7, nell'ordine di cattura. */
function pdus(buf: Buffer): S7Pdu[] {
  const out: S7Pdu[] = [];
  let acc: Uint8Array[] = [];
  for (const t of tpkts(buf)) {
    let c;
    try {
      c = decodeCotp(t.subarray(4));
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

const cat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};

/** Nome file di un job 0x1B (CPU → PG): 1b + 7 byte + len(1)=9 + nome. Solo per i test, non è un codec. */
function downloadJobName(param: Uint8Array): string | null {
  if (param.length !== 18 || param[0] !== 0x1b || param[8] !== 9) return null;
  return String.fromCharCode(...param.subarray(9, 18));
}

describe.skipIf(!HAVE)('upload su catture reali: encode(decode(x)) identico', () => {
  it('ogni PDU 0x1D/0x1E/0x1F e ogni blocco, per file', () => {
    const lines: string[] = [];
    const fails: string[] = [];
    const total = zero();
    for (const f of files(DIR)) {
      const s = zero();
      const name = f.slice(DIR.length + 1);
      const same = (what: string, got: Uint8Array, want: Uint8Array): void => {
        if (hex(got) !== hex(want)) {
          s.mismatch++;
          fails.push(`${name} ${what}\n  got  ${hex(got)}\n  want ${hex(want)}`);
        }
      };
      const check = (what: string, ok: boolean): void => {
        if (!ok) {
          s.mismatch++;
          fails.push(`${name} ${what}`);
        }
      };
      const guard = (what: string, fn: () => void): void => {
        try {
          fn();
        } catch (e) {
          s.mismatch++;
          fails.push(`${name} ${what}: ${String(e)}`);
        }
      };
      /** Controlli comuni su un blocco intero (upload o download). */
      const block = (what: string, fileName: string, bytes: Uint8Array): boolean => {
        let rebuilt = false;
        guard(what, () => {
          const want = parseBlockFileName(fileName);
          const b = parseBlockFile(bytes);
          check(`${what} magic`, bytes[0] === 0x70 && bytes[1] === 0x70);
          check(`${what} tipo ${b.header.type} <> ${want.type}`, b.header.type === want.type);
          check(
            `${what} numero ${b.header.number} <> ${want.number}`,
            b.header.number === want.number,
          );
          // relazioni di lunghezza osservate (vedi il commento in blockFile.ts)
          check(
            `${what} loadLength ${b.header.loadLength} <> ${bytes.length}`,
            b.header.loadLength === bytes.length,
          );
          check(
            `${what} rest ${b.rest.length} <> ssb+add ${b.header.ssbLength + b.header.addLength}`,
            b.rest.length === b.header.ssbLength + b.header.addLength,
          );
          check(`${what} avvisi: ${b.warnings.join('; ')}`, b.warnings.length === 0);
          if (b.rest.length > 0) s.rest++;
          if (b.footer === null) {
            s.noFooter++;
            return;
          }
          const again = buildBlockFile(b.header, b.mc7, b.footer, b.rest);
          same(`${what} buildBlockFile`, again, bytes);
          rebuilt = hex(again) === hex(bytes);
        });
        return rebuilt;
      };

      const names = new Map<number, string>(); // pduRef -> nome file della richiesta 0x1D / 0x1B
      let up: { fileName: string; chunks: Uint8Array[]; total: number | null } | null = null;
      let dl: { fileName: string; chunks: Uint8Array[] } | null = null;
      for (const pdu of pdus(readFileSync(f))) {
        if (pdu.rosctr === 7 || pdu.rosctr === 2) continue;
        const fn = pdu.param[0];
        const tag = `ref ${pdu.pduRef} fn ${fn?.toString(16)}`;
        const req = pdu.rosctr === 1;
        if (req && fn === 0x1b) {
          const n = downloadJobName(pdu.param);
          if (n) names.set(pdu.pduRef, n);
          continue;
        }
        if (!req && fn === 0x1b) {
          // solo per ricavare i blocchi scaricati: nessun codec di download
          s.dlChunks++;
          const d = pdu.data;
          const fileName = names.get(pdu.pduRef);
          if (!fileName || d.length < 4 || (d[0]! << 8) + d[1]! !== d.length - 4) {
            check(`${tag} chunk di download`, false);
            continue;
          }
          dl ??= { fileName, chunks: [] };
          dl.chunks.push(d.slice(4));
          if (pdu.param[1] === 0) {
            s.dlBlocks++;
            if (block(`download ${dl.fileName}`, dl.fileName, cat(dl.chunks))) s.dlRebuilt++;
            dl = null;
          }
          continue;
        }
        if (fn !== 0x1d && fn !== 0x1e && fn !== 0x1f) continue;
        if (req && fn === 0x1d) {
          s.startReq++;
          guard(tag + ' start req', () => {
            const r = decodeStartUpload(pdu.param);
            same(tag + ' start req', encodeStartUpload(r.fileName), pdu.param);
            check(tag + ' start req senza dati', pdu.data.length === 0);
            names.set(pdu.pduRef, r.fileName);
          });
        } else if (!req && fn === 0x1d) {
          s.startRes++;
          guard(tag + ' start res', () => {
            const r = decodeStartUploadResponse(pdu.param);
            same(
              tag + ' start res',
              encodeStartUploadResponse(r.uploadId, r.totalLength ?? 0, r),
              pdu.param,
            );
            check(tag + ' start res senza dati', pdu.data.length === 0);
            const fileName = names.get(pdu.pduRef);
            check(tag + ' start res senza richiesta', fileName !== undefined);
            up = { fileName: fileName ?? '_0A00000A', chunks: [], total: r.totalLength };
          });
        } else if (req && fn === 0x1e) {
          s.upReq++;
          guard(tag + ' upload req', () => {
            const r = decodeUploadRequest(pdu.param);
            same(tag + ' upload req', encodeUpload(r.uploadId), pdu.param);
          });
        } else if (!req && fn === 0x1e) {
          s.upRes++;
          guard(tag + ' upload res', () => {
            const r = decodeUploadResponse(pdu.param, pdu.data);
            const e = encodeUploadResponse(r.more, r.chunk, r.dataHeader, r.eou);
            same(tag + ' upload res param', e.param, pdu.param);
            same(tag + ' upload res dati', e.data, pdu.data);
            // anche con l'header dati predefinito (00 fb)
            const e2 = encodeUploadResponse(r.more, r.chunk);
            same(tag + ' upload res dati (header predefinito)', e2.data, pdu.data);
            check(tag + ' upload res senza sessione', up !== null);
            if (!up) return;
            up.chunks.push(r.chunk);
            if (!r.more) {
              const bytes = cat(up.chunks);
              s.blocks++;
              check(
                `upload ${up.fileName} lunghezza ${bytes.length} <> ${up.total}`,
                bytes.length === up.total,
              );
              if (block(`upload ${up.fileName}`, up.fileName, bytes)) s.rebuilt++;
              up = null;
            }
          });
        } else if (req && fn === 0x1f) {
          s.endReq++;
          guard(tag + ' end req', () => {
            const r = decodeEndUpload(pdu.param);
            same(tag + ' end req', encodeEndUpload(r.uploadId), pdu.param);
          });
        } else if (!req && fn === 0x1f) {
          s.endRes++;
          guard(tag + ' end res', () => {
            decodeEndUploadResponse(pdu.param);
            same(tag + ' end res', encodeEndUploadResponse(), pdu.param);
            check(tag + ' end res senza dati', pdu.data.length === 0);
          });
        }
      }
      const entries = Object.entries(s) as [keyof Stats, number][];
      lines.push(`${name}: ${entries.map(([k, v]) => `${k}=${v}`).join(' ')}`);
      for (const [k, v] of entries) total[k] += v;
    }
    const sum = Object.entries(total)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    console.log(
      `[realUpload]\n${lines.filter((l) => !/ startReq=0 .* dlChunks=0 /.test(l)).join('\n')}\nTOTALE: ${sum}`,
    );
    if (fails.length) console.log(fails.slice(0, 25).join('\n'));
    expect(total.mismatch).toBe(0);
    expect(total.startReq).toBeGreaterThan(0);
    expect(total.blocks).toBeGreaterThan(0);
    expect(total.dlBlocks).toBeGreaterThan(0);
  });
});
