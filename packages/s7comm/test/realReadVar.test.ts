import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decodeCotp,
  decodeReadRequest,
  decodeReadResponse,
  decodeS7,
  encodeReadRequest,
  encodeReadResponse,
  hex,
} from '../src';

// Catture reali pubbliche. Cartella: S7_CAPTURES_DIR, oppure .cache/s7-captures/ nella radice.
// Se mancano il test è saltato con un avviso (Task 5 collega il download in CI).
const DIR = process.env['S7_CAPTURES_DIR'] ?? resolve(__dirname, '../../../.cache/s7-captures');
const HAVE = existsSync(DIR);
if (!HAVE) console.warn(`[realReadVar] catture assenti in ${DIR}: test saltato`);

// ---- lettore pcap/pcapng minimale (verrà sostituito dal lettore vero del Task 5) ----

interface Pkt {
  link: number;
  data: Uint8Array;
}

function readPackets(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  const m = buf.readUInt32BE(0);
  if (m === 0xa1b2c3d4 || m === 0xd4c3b2a1 || m === 0xa1b23c4d || m === 0x4d3cb2a1) {
    const le = m === 0xd4c3b2a1 || m === 0x4d3cb2a1;
    const u32 = (o: number): number => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
    const link = u32(20);
    for (let o = 24; o + 16 <= buf.length;) {
      const incl = u32(o + 8);
      out.push({ link, data: buf.subarray(o + 16, o + 16 + incl) });
      o += 16 + incl;
    }
  } else if (m === 0x0a0d0d0a) {
    let le = true;
    const links: number[] = [];
    for (let o = 0; o + 12 <= buf.length;) {
      const type = le ? buf.readUInt32LE(o) : buf.readUInt32BE(o);
      if (type === 0x0a0d0d0a) le = buf.readUInt32LE(o + 8) === 0x1a2b3c4d;
      const len = le ? buf.readUInt32LE(o + 4) : buf.readUInt32BE(o + 4);
      const u16 = (p: number): number => (le ? buf.readUInt16LE(p) : buf.readUInt16BE(p));
      const u32 = (p: number): number => (le ? buf.readUInt32LE(p) : buf.readUInt32BE(p));
      if (type === 1) links.push(u16(o + 8));
      else if (type === 6) {
        const cap = u32(o + 20);
        out.push({ link: links[u32(o + 8)] ?? 1, data: buf.subarray(o + 28, o + 28 + cap) });
      } else if (type === 3) {
        out.push({ link: links[0] ?? 1, data: buf.subarray(o + 12, o + 8 + len - 4) });
      }
      if (len < 12) break;
      o += len;
    }
  }
  return out;
}

/** Ricostruisce i flussi TCP verso/da porta 102 e li spezza in TPKT. */
function tpkts(buf: Buffer): Uint8Array[] {
  interface Flow {
    next: number | null;
    buf: Buffer;
  }
  const flows = new Map<string, Flow>();
  const out: Uint8Array[] = [];
  for (const { link, data: p } of readPackets(buf)) {
    let ip: Buffer;
    const b = Buffer.from(p);
    if (link === 1) {
      let et = b.readUInt16BE(12);
      let o = 14;
      while (et === 0x8100 || et === 0x88a8) {
        et = b.readUInt16BE(o + 2);
        o += 4;
      }
      if (et !== 0x0800) continue;
      ip = b.subarray(o);
    } else if (link === 101 || link === 228) ip = b;
    else if (link === 0) ip = b.subarray(4);
    else if (link === 113) ip = b.subarray(16);
    else continue;
    if (ip.length < 20 || ip[0]! >> 4 !== 4 || ip[9] !== 6) continue;
    const ihl = (ip[0]! & 15) * 4;
    const tcp = ip.subarray(ihl, ip.readUInt16BE(2));
    if (tcp.length < 20) continue;
    const sp = tcp.readUInt16BE(0);
    const dp = tcp.readUInt16BE(2);
    if (sp !== 102 && dp !== 102) continue;
    const seq = tcp.readUInt32BE(4);
    const flags = tcp[13]!;
    const pl = tcp.subarray((tcp[12]! >> 4) * 4);
    const key = `${ip.subarray(12, 16).toString('hex')}:${sp}>${ip.subarray(16, 20).toString('hex')}:${dp}`;
    let f = flows.get(key);
    if (!f) flows.set(key, (f = { next: null, buf: Buffer.alloc(0) }));
    if (flags & 0x02) {
      f.next = (seq + 1) >>> 0;
      continue;
    }
    if (pl.length === 0) continue;
    if (f.next === null) f.next = seq;
    const diff = (seq - f.next) >>> 0;
    let add: Buffer | null = null;
    if (diff === 0) add = pl;
    else if (diff > 0x7fffffff) {
      const back = (f.next - seq) >>> 0; // ritrasmissione/sovrapposizione
      if (back < pl.length) add = pl.subarray(back);
    } else add = pl; // buco: si prosegue comunque
    if (!add) continue;
    f.next = (f.next + add.length) >>> 0;
    f.buf = Buffer.concat([f.buf, add]);
    while (f.buf.length >= 4) {
      if (f.buf[0] !== 3) {
        f.buf = Buffer.alloc(0);
        break;
      }
      const ln = f.buf.readUInt16BE(2);
      if (f.buf.length < ln) break;
      out.push(f.buf.subarray(0, ln));
      f.buf = f.buf.subarray(ln);
    }
  }
  return out;
}

function allS7any(param: Uint8Array): boolean {
  let o = 2;
  for (let i = 0; i < param[1]!; i++) {
    if (
      o + 12 > param.length ||
      param[o] !== 0x12 ||
      param[o + 1] !== 0x0a ||
      param[o + 2] !== 0x10
    )
      return false;
    o += 12;
  }
  return true;
}

function files(dir: string): string[] {
  const r: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) r.push(...files(p));
    else if (/\.pcap(ng)?$/.test(n)) r.push(p);
  }
  return r.sort();
}

describe.skipIf(!HAVE)('read var su catture reali: encode(decode(x)) identico', () => {
  it('ogni richiesta e risposta read var', () => {
    const stats: string[] = [];
    let req = 0;
    let res = 0;
    for (const f of files(DIR)) {
      let nReq = 0;
      let nRes = 0;
      let nOther = 0;
      for (const t of tpkts(readFileSync(f))) {
        let cotp;
        try {
          cotp = decodeCotp(t.subarray(4));
        } catch {
          continue;
        }
        if (cotp.type !== 'DT' || !cotp.eot) continue;
        let pdu;
        try {
          pdu = decodeS7(cotp.data);
        } catch {
          continue;
        }
        if (pdu.param.length < 2 || pdu.param[0] !== 0x04) continue;
        if (pdu.rosctr === 1) {
          if (!allS7any(pdu.param)) {
            nOther++; // sintassi diversa da S7ANY (es. S7-400 DBREAD 0xB0): fuori ambito
            continue;
          }
          expect(hex(encodeReadRequest(decodeReadRequest(pdu.param))), f).toBe(hex(pdu.param));
          nReq++;
        } else if (pdu.rosctr === 3) {
          const e = encodeReadResponse(decodeReadResponse(pdu.param, pdu.data));
          expect(hex(e.param), f).toBe(hex(pdu.param));
          expect(hex(e.data), f).toBe(hex(pdu.data));
          nRes++;
        }
      }
      req += nReq;
      res += nRes;
      stats.push(
        `${f.slice(DIR.length + 1)}: ${nReq} richieste, ${nRes} risposte, ${nOther} richieste non S7ANY saltate`,
      );
    }
    console.log(`[realReadVar]\n${stats.join('\n')}\nTOTALE: ${req} richieste, ${res} risposte`);
    expect(req + res).toBeGreaterThan(0);
  });
});
