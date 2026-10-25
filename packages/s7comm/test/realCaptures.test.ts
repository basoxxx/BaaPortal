import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  S7Error,
  commFrom,
  decodeBcdDateTime,
  decodeBlockCounts,
  decodeBlockInfo,
  decodeBlockInfoRequest,
  decodeBlockListOfTypeRequest,
  decodeDownloadBlockAck,
  decodeDownloadBlockJob,
  decodeDownloadEnded,
  decodePlcControlRequest,
  decodeRequestDownload,
  decodeWriteRequest,
  decodeWriteResponse,
  decodeCotp,
  decodeEndUpload,
  decodeEndUploadResponse,
  decodeReadRequest,
  decodeReadResponse,
  decodeS7,
  decodeSetup,
  decodeStartUpload,
  decodeStartUploadResponse,
  decodeSzlRequest,
  decodeUploadRequest,
  decodeUploadResponse,
  decodeUserdata,
  dissect,
  encodeBcdDateTime,
  encodeBlockCounts,
  encodeBlockInfo,
  encodeBlockInfoRequest,
  encodeBlockListOfTypeRequest,
  encodeCompressMemory,
  encodeControlResponse,
  encodeCopyRamToRom,
  encodeDownloadBlockAck,
  encodeDownloadBlockJob,
  encodeDownloadEnded,
  encodeInsertBlock,
  encodePlcStop,
  encodeRequestDownload,
  encodeWarmRestart,
  encodeWriteRequest,
  encodeWriteResponse,
  encodeCotp,
  encodeEndUpload,
  encodeEndUploadResponse,
  encodeReadRequest,
  encodeReadResponse,
  encodeS7,
  encodeSetup,
  encodeStartUpload,
  encodeStartUploadResponse,
  encodeSzlRequest,
  encodeUpload,
  encodeUploadResponse,
  encodeUserdata,
  hex,
  identityFrom,
  parseBlockFile,
  parseBlockFileName,
  parseSzl,
  readPcap,
  type SzlList,
} from '../src';
import { CACHE_DIR, CISAGOV_DIR, allCaptures, missingCaptures } from './captures';

const missing = missingCaptures();
if (missing.length > 0) {
  console.warn(
    `[realCaptures] ${missing.length} catture pubbliche assenti (node scripts/fetch-s7-captures.mjs): ${missing.join(', ')}`,
  );
}
// Le assenti risultano saltate, con il nome del file.
if (missing.length > 0) {
  it.skip(`catture pubbliche assenti, saltate: ${missing.join(', ')}`, () => {
    /* saltato */
  });
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

const cat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};

interface Stats {
  frames: number;
  connect: number;
  setup: number;
  readVar: number;
  szl: number;
  blockList: number;
  blockInfo: number;
  clock: number;
  upload: number;
  other: number;
  malformed: number;
  /** Frame "malformed" spiegati: coda di una PDU S7 spezzata in più DT, o S7comm-plus. */
  explained: number;
  /** PDU S7comm-plus (protocol id 0x72): fuori ambito. */
  s7plus: number;
  /** PDU S7 decodificate solo come header (scritture, controllo, download, cyclic, S7-400...). */
  headerOnly: number;
  typed: number;
  /** CR/CC/DR il cui codificatore canonico ordina o omette parametri diversamente dal filo. */
  cotpReordered: number;
  mismatch: number;
}

const zero = (): Stats => ({
  frames: 0,
  connect: 0,
  setup: 0,
  readVar: 0,
  szl: 0,
  blockList: 0,
  blockInfo: 0,
  clock: 0,
  upload: 0,
  other: 0,
  malformed: 0,
  explained: 0,
  s7plus: 0,
  headerOnly: 0,
  typed: 0,
  cotpReordered: 0,
  mismatch: 0,
});

const KINDS = [
  'connect',
  'setup',
  'readVar',
  'szl',
  'blockList',
  'blockInfo',
  'clock',
  'upload',
  'other',
  'malformed',
] as const;

describe('catture reali: ogni frame passa da dissect e dai codec tipizzati', () => {
  it('encode(decode(x)) identico per ogni frame di ogni cattura disponibile', () => {
    const lines: string[] = [];
    const fails: string[] = [];
    const total = zero();
    const caps = allCaptures();
    expect(caps.map((c) => c.name)).toContain('cisagov/snap7.pcap');
    expect(caps.map((c) => c.name)).toContain('cisagov/s7ident.pcap');
    for (const cap of caps) {
      const s = zero();
      const fail = (what: string, extra = ''): void => {
        s.mismatch++;
        fails.push(`${cap.name} ${what}${extra}`);
      };
      const same = (what: string, got: Uint8Array, want: Uint8Array): void => {
        if (hex(got) !== hex(want)) fail(what, `\n  got  ${hex(got)}\n  want ${hex(want)}`);
      };
      const guard = (what: string, fn: () => void): void => {
        try {
          fn();
        } catch (e) {
          fail(what, `: ${String(e)}`);
        }
      };

      const streams = readPcap(readFileSync(cap.path));
      streams.forEach((st, si) => {
        const pending: Record<'tx' | 'rx', Uint8Array[]> = { tx: [], rx: [] };
        st.frames.forEach((fr, fi) => {
          const at = `flusso ${si} frame ${fi} (${fr.dir})`;
          s.frames++;
          const d = dissect(fr.bytes);
          s[d.kind as keyof Stats] += 1;
          let cotp;
          try {
            cotp = decodeCotp(fr.bytes);
          } catch (e) {
            fail(at + ' COTP', `: ${String(e)}`);
            return;
          }
          if (cotp.type === 'DT') {
            same(at + ' COTP', encodeCotp(cotp), fr.bytes);
          } else if (hex(encodeCotp(cotp)) !== hex(fr.bytes)) {
            // CR/CC/DR: il codificatore scrive i parametri in ordine canonico e solo quelli che
            // conosce (le CPU e i client li ordinano a modo loro, S7-1200 aggiunge il TSAP
            // "SIMATIC-ROOT-ES"): i byte possono differire, il significato no.
            s.cotpReordered++;
            expect(decodeCotp(encodeCotp(cotp)), at).toEqual(cotp);
          }
          if (d.kind === 'connect') {
            expect(['CR', 'CC', 'DR']).toContain(cotp.type);
            return;
          }
          if (cotp.type !== 'DT') {
            if (d.kind !== 'other') fail(at + ` dissect ${d.kind} su COTP ${cotp.type}`);
            return;
          }
          const wasMid = pending[fr.dir].length > 0;
          pending[fr.dir].push(cotp.data);
          if (!cotp.eot) {
            if (d.kind !== 'other') fail(at + ` DT non finale classificato ${d.kind}`);
            return;
          }
          const whole = cat(pending[fr.dir]);
          pending[fr.dir] = [];

          let pdu;
          try {
            pdu = decodeS7(whole);
          } catch (e) {
            if (!(e instanceof S7Error)) throw e;
            if (whole[0] === 0x72) s.s7plus++;
            else fail(at + ' S7', `: ${e.message}`);
            if (d.kind !== 'malformed') fail(at + ` dissect ${d.kind} su S7 non decodificabile`);
            else s.explained++;
            return;
          }
          if (d.kind === 'malformed') {
            // Coda di una PDU spezzata: dissect vede solo l'ultimo segmento.
            if (wasMid) s.explained++;
            else fail(at + ' dissect malformed su PDU valida', `: ${d.error}`);
          }
          same(at + ' S7', encodeS7(pdu), whole);
          if (!wasMid && d.s7) same(at + ' dissect S7', encodeS7(d.s7), whole);

          // ---- codec tipizzati ----
          const req = pdu.rosctr === 1;
          const fn = pdu.param[0];
          const tag = `${at} rosctr ${pdu.rosctr} fn ${fn?.toString(16)}`;
          let covered = false;
          const t = (what: string, f: () => void): void => {
            covered = true;
            s.typed++;
            guard(`${tag} ${what}`, f);
          };
          if ((pdu.rosctr === 1 || pdu.rosctr === 3) && fn === 0xf0 && pdu.param.length === 8) {
            t('setup', () => same('setup', encodeSetup(decodeSetup(pdu.param)), pdu.param));
          } else if (
            (pdu.rosctr === 1 || pdu.rosctr === 3) &&
            fn === 0x04 &&
            pdu.param.length >= 2
          ) {
            if (req && allS7any(pdu.param)) {
              t('read var req', () =>
                same('read var req', encodeReadRequest(decodeReadRequest(pdu.param)), pdu.param),
              );
            } else if (pdu.rosctr === 3) {
              t('read var res', () => {
                const e = encodeReadResponse(decodeReadResponse(pdu.param, pdu.data));
                same('read var res param', e.param, pdu.param);
                same('read var res dati', e.data, pdu.data);
              });
            }
          } else if (pdu.rosctr === 7) {
            let u;
            try {
              u = decodeUserdata(pdu.param, pdu.data);
            } catch (e) {
              if (!(e instanceof S7Error)) throw e;
            }
            if (u) {
              const { param: up } = u;
              const key = `${up.group}/${up.subfunction}`;
              const inScope =
                up.method === 'request'
                  ? ['4/1', '3/1', '3/2', '3/3', '7/1', '7/3'].includes(key)
                  : ![1, 2, 5].includes(up.group) &&
                    !(up.group === 7 && [2, 4].includes(up.subfunction));
              const ud = u;
              if (inScope) {
                t('userdata generico', () => {
                  const e = encodeUserdata(
                    ud.param,
                    ud.hasData ? ud.payload : null,
                    ud.returnCode,
                    ud.transportSize,
                  );
                  same('userdata param', e.param, pdu.param);
                  same('userdata dati', e.data, pdu.data);
                });
                const ok = u.hasData && u.returnCode === 0xff;
                if (up.method === 'request' && u.payload.length > 0) {
                  if (key === '4/1')
                    t('SZL req', () => {
                      const r = decodeSzlRequest(ud.payload);
                      same('SZL req', encodeSzlRequest(r.id, r.index), ud.payload);
                    });
                  if (key === '3/2')
                    t('lista blocchi req', () =>
                      same(
                        'lista blocchi req',
                        encodeBlockListOfTypeRequest(decodeBlockListOfTypeRequest(ud.payload)),
                        ud.payload,
                      ),
                    );
                  if (key === '3/3')
                    t('info blocco req', () => {
                      const r = decodeBlockInfoRequest(ud.payload);
                      same(
                        'info blocco req',
                        encodeBlockInfoRequest(r.type, r.number, r.filesystem),
                        ud.payload,
                      );
                    });
                } else if (up.type === 8 && ok) {
                  if (key === '3/1')
                    t('conteggi', () =>
                      same(
                        'conteggi',
                        encodeBlockCounts(decodeBlockCounts(ud.payload)),
                        ud.payload,
                      ),
                    );
                  if (key === '3/3')
                    t('info blocco', () =>
                      same('info blocco', encodeBlockInfo(decodeBlockInfo(ud.payload)), ud.payload),
                    );
                  if (key === '7/1' || key === '7/3')
                    t('orologio', () =>
                      same(
                        'orologio',
                        encodeBcdDateTime(decodeBcdDateTime(ud.payload)),
                        ud.payload,
                      ),
                    );
                }
                covered = true;
              } else {
                // fuori dall'allowlist del kit: il codificatore deve rifiutarla
                t('fuori allowlist', () =>
                  expect(() => encodeUserdata(ud.param, ud.payload, ud.returnCode)).toThrow(
                    RangeError,
                  ),
                );
                s.headerOnly++;
              }
            }
          } else if (fn === 0x1d || fn === 0x1e || fn === 0x1f) {
            if (req && fn === 0x1d)
              t('start upload req', () =>
                same(
                  'start upload req',
                  encodeStartUpload(decodeStartUpload(pdu.param).fileName),
                  pdu.param,
                ),
              );
            else if (!req && fn === 0x1d)
              t('start upload res', () => {
                const r = decodeStartUploadResponse(pdu.param);
                same(
                  'start upload res',
                  encodeStartUploadResponse(r.uploadId, r.totalLength ?? 0, r),
                  pdu.param,
                );
              });
            else if (req && fn === 0x1e)
              t('upload req', () =>
                same(
                  'upload req',
                  encodeUpload(decodeUploadRequest(pdu.param).uploadId),
                  pdu.param,
                ),
              );
            else if (!req && fn === 0x1e)
              t('upload res', () => {
                const r = decodeUploadResponse(pdu.param, pdu.data);
                const e = encodeUploadResponse(r.more, r.chunk, r.dataHeader, r.eou);
                same('upload res param', e.param, pdu.param);
                same('upload res dati', e.data, pdu.data);
              });
            else if (req && fn === 0x1f)
              t('end upload req', () =>
                same(
                  'end upload req',
                  encodeEndUpload(decodeEndUpload(pdu.param).uploadId),
                  pdu.param,
                ),
              );
            else if (!req && fn === 0x1f)
              t('end upload res', () => {
                decodeEndUploadResponse(pdu.param);
                same('end upload res', encodeEndUploadResponse(), pdu.param);
              });
          }
          if (!covered) s.headerOnly++; // scritture, controllo, download, cyclic, S7-400...
        });
      });

      lines.push(
        `${cap.name.padEnd(52)} frame=${String(s.frames).padStart(5)} ` +
          KINDS.map((k) => `${k}=${s[k]}`).join(' ') +
          ` s7plus=${s.s7plus} spiegati=${s.explained} soloHeader=${s.headerOnly} tipizzati=${s.typed} cotpOrdine=${s.cotpReordered} errori=${s.mismatch}`,
      );
      for (const k of Object.keys(total) as (keyof Stats)[]) total[k] += s[k];

      // S7comm-plus solo nelle catture di S7-1200 (fuori ambito)
      if (s.s7plus > 0) expect(cap.name, 'S7comm-plus').toMatch(/1200/i);
    }
    console.log(
      `[realCaptures] ${caps.length} catture\n${lines.join('\n')}\nTOTALE: frame=${total.frames} ` +
        KINDS.map((k) => `${k}=${total[k]}`).join(' ') +
        ` s7plus=${total.s7plus} spiegati=${total.explained} soloHeader=${total.headerOnly} tipizzati=${total.typed} cotpOrdine=${total.cotpReordered} errori=${total.mismatch}`,
    );
    if (fails.length) console.log(fails.slice(0, 25).join('\n'));
    expect(total.mismatch).toBe(0);
    // ogni 'malformed' deve avere una spiegazione (coda di PDU spezzata o S7comm-plus)
    expect(total.malformed).toBe(total.explained);
    expect(total.frames).toBeGreaterThan(80);
    expect(total.typed).toBeGreaterThan(50);
  });
});

describe('snap7.pcap (CPU reale 315-2PN/DP, sempre eseguito)', () => {
  it('PDU 240, CPU 315-2EH14, 16 connessioni, blocchi caricati con magic pp', () => {
    const streams = readPcap(readFileSync(join(CISAGOV_DIR, 'snap7.pcap')));
    expect(streams).toHaveLength(1);
    let negotiated: number | undefined;
    const lists: SzlList[] = [];
    let frags: Uint8Array[] = [];
    const names = new Map<number, string>();
    let up: { fileName: string; chunks: Uint8Array[] } | null = null;
    const blocks: { fileName: string; bytes: Uint8Array }[] = [];
    for (const fr of streams[0]!.frames) {
      const d = dissect(fr.bytes);
      const pdu = d.s7;
      if (!pdu) continue;
      if (d.kind === 'setup' && pdu.rosctr === 3) negotiated = decodeSetup(pdu.param).pduLength;
      if (d.kind === 'szl' && pdu.rosctr === 7) {
        const u = decodeUserdata(pdu.param, pdu.data);
        if (u.param.type === 8 && u.hasData && u.returnCode === 0xff) {
          frags.push(u.payload);
          if (!u.param.lastDataUnit) {
            lists.push(parseSzl(frags));
            frags = [];
          }
        }
      }
      if (d.kind === 'upload') {
        if (pdu.rosctr === 1 && pdu.param[0] === 0x1d) {
          names.set(pdu.pduRef, decodeStartUpload(pdu.param).fileName);
        } else if (pdu.rosctr === 3 && pdu.param[0] === 0x1d) {
          const fileName = names.get(pdu.pduRef);
          if (fileName && decodeStartUploadResponse(pdu.param).totalLength !== null) {
            up = { fileName, chunks: [] };
          }
        } else if (pdu.rosctr === 3 && pdu.param[0] === 0x1e && up) {
          const r = decodeUploadResponse(pdu.param, pdu.data);
          up.chunks.push(r.chunk);
          if (!r.more) {
            blocks.push({ fileName: up.fileName, bytes: cat(up.chunks) });
            up = null;
          }
        }
      }
    }
    expect(negotiated).toBe(240);
    const s0011 = lists.find((l) => l.id === 0x0011);
    expect(s0011).toBeDefined();
    expect(identityFrom(s0011!).orderNumber).toBe('6ES7 315-2EH14-0AB0');
    const s0131 = lists.find((l) => l.id === 0x0131 && l.index === 1);
    expect(s0131).toBeDefined();
    expect(commFrom(s0131!).maxConnections).toBe(16);
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) {
      expect(b.bytes[0], b.fileName).toBe(0x70); // 'p'
      expect(b.bytes[1], b.fileName).toBe(0x70);
      const want = parseBlockFileName(b.fileName);
      const got = parseBlockFile(b.bytes).header;
      expect(got.type, b.fileName).toBe(want.type);
      expect(got.number, b.fileName).toBe(want.number);
    }
  });
});

// ---- scrittura, controllo e download su byte veri -------------------------------------------

/** Le PDU S7 intere (anche su più DT) di tutte le connessioni, con il verso. */
function s7Pdus(path: string): { dir: 'tx' | 'rx'; whole: Uint8Array }[] {
  const out: { dir: 'tx' | 'rx'; whole: Uint8Array }[] = [];
  for (const st of readPcap(readFileSync(path))) {
    const pending: Record<'tx' | 'rx', Uint8Array[]> = { tx: [], rx: [] };
    for (const fr of st.frames) {
      let c;
      try {
        c = decodeCotp(fr.bytes);
      } catch {
        continue;
      }
      if (c.type !== 'DT') continue;
      pending[fr.dir].push(c.data);
      if (c.eot) out.push({ dir: fr.dir, whole: cat(pending[fr.dir].splice(0)) });
    }
  }
  return out;
}

const ascii = (b: Uint8Array): string => String.fromCharCode(...b);

describe('snap7.pcap (sempre eseguito): write var, stop e riavvii', () => {
  const pdus = s7Pdus(join(CISAGOV_DIR, 'snap7.pcap'))
    .map((x) => {
      try {
        return { dir: x.dir, whole: x.whole, pdu: decodeS7(x.whole) };
      } catch {
        return undefined;
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== undefined);

  it('ogni write var (richiesta e risposta): encodeS7(decodeS7) e i codec ricostruiscono i byte', () => {
    let reqs = 0;
    let ress = 0;
    for (const { dir, whole, pdu } of pdus) {
      if (pdu.param[0] !== 0x05) continue;
      expect(hex(encodeS7(pdu))).toBe(hex(whole));
      if (pdu.rosctr === 1 && dir === 'tx') {
        const items = decodeWriteRequest(pdu.param, pdu.data);
        const e = encodeWriteRequest(items);
        expect(hex(e.param)).toBe(hex(pdu.param));
        expect(hex(e.data)).toBe(hex(pdu.data));
        reqs++;
      } else if (pdu.rosctr === 3) {
        const rs = decodeWriteResponse(pdu.param, pdu.data);
        const e = encodeWriteResponse(rs.map((r) => r.returnCode));
        expect(hex(e.param)).toBe(hex(pdu.param));
        expect(hex(e.data)).toBe(hex(pdu.data));
        ress++;
      }
    }
    expect(reqs).toBeGreaterThanOrEqual(2);
    expect(ress).toBe(reqs);
  });

  it('PLC stop, cold restart, _MODU e _GARB: giro identico; i codec ricostruiscono stop, _MODU, _GARB e rifiutano il cold restart', () => {
    let stop = 0;
    let cold = 0;
    let other = 0;
    let acks = 0;
    for (const { dir, whole, pdu } of pdus) {
      const fn = pdu.param[0];
      if (fn !== 0x28 && fn !== 0x29) continue;
      expect(hex(encodeS7(pdu))).toBe(hex(whole));
      if (dir === 'rx') {
        expect(hex(encodeControlResponse(fn, 0))).toBe(hex(pdu.param));
        acks++;
        continue;
      }
      const req = decodePlcControlRequest(pdu.param);
      if (fn === 0x29) {
        expect(req.service).toBe('P_PROGRAM');
        expect(hex(encodePlcStop())).toBe(hex(pdu.param));
        stop++;
      } else if (ascii(pdu.param.subarray(-9)) === 'P_PROGRAM') {
        // cold restart: argomento "C " (0x4320); fuori dall'allowlist, e il warm restart no
        expect(pdu.param.subarray(8, 12)).toEqual(Uint8Array.of(0, 2, 0x43, 0x20));
        expect(req.service).toBeUndefined();
        expect(hex(encodeWarmRestart())).not.toBe(hex(pdu.param));
        cold++;
      } else {
        // _MODU e _GARB: ora ammessi, e ricodificati byte per byte come la cattura
        expect(['_MODU', '_GARB']).toContain(req.service);
        expect(hex(req.service === '_MODU' ? encodeCopyRamToRom() : encodeCompressMemory())).toBe(
          hex(pdu.param),
        );
        other++;
      }
    }
    expect(stop).toBe(1);
    expect(cold).toBe(1);
    expect(other).toBe(2);
    expect(acks).toBe(4);
  });
});

const DOWNLOAD = 's7comm_downloading_block_db1.pcap';
describe.skipIf(!existsSync(join(CACHE_DIR, DOWNLOAD)))(
  `${DOWNLOAD} (cattura scaricata: 0x1A/0x1B/0x1C/_INSE)`,
  () => {
    it('la sequenza si decodifica e si ricodifica identica; i numeri veri sono 500/400', () => {
      const pdus = s7Pdus(join(CACHE_DIR, DOWNLOAD)).map((x) => ({
        dir: x.dir,
        whole: x.whole,
        pdu: decodeS7(x.whole),
      }));
      const seq = pdus.filter((x) => [0x1a, 0x1b, 0x1c, 0x28].includes(x.pdu.param[0]!));
      // 1A req+ack, 3 x (1B job + ack), 1C job + ack, _INSE req + ack
      expect(seq.map((x) => `${x.pdu.rosctr}:${x.pdu.param[0]!.toString(16)}`)).toEqual([
        '1:1a',
        '3:1a',
        '1:1b',
        '3:1b',
        '1:1b',
        '3:1b',
        '1:1b',
        '3:1b',
        '1:1c',
        '3:1c',
        '1:28',
        '3:28',
      ]);
      const chunks: Uint8Array[] = [];
      const eos: boolean[] = [];
      for (const { dir, whole, pdu } of seq) {
        expect(hex(encodeS7(pdu))).toBe(hex(whole));
        const fn = pdu.param[0];
        if (fn === 0x1a && pdu.rosctr === 1) {
          const r = decodeRequestDownload(pdu.param);
          expect(r).toEqual({ type: 'DB', number: 1, fs: 'P', loadLength: 500, mc7Length: 400 });
          expect(
            hex(encodeRequestDownload(r.type, r.number, r.fs, r.loadLength, r.mc7Length)),
          ).toBe(hex(pdu.param));
        } else if (fn === 0x1a) {
          expect(hex(pdu.param)).toBe('1a');
        } else if (fn === 0x1b && pdu.rosctr === 1) {
          expect(dir).toBe('rx'); // la CPU manda il job
          const r = decodeDownloadBlockJob(pdu.param);
          expect(hex(encodeDownloadBlockJob(r.type, r.number, r.fs))).toBe(hex(pdu.param));
        } else if (fn === 0x1b) {
          expect(dir).toBe('tx');
          const a = decodeDownloadBlockAck(pdu.param, pdu.data);
          const e = encodeDownloadBlockAck(a.eos, a.chunk);
          expect(hex(e.param)).toBe(hex(pdu.param));
          expect(hex(e.data)).toBe(hex(pdu.data));
          chunks.push(a.chunk);
          eos.push(a.eos);
        } else if (fn === 0x1c && pdu.rosctr === 1) {
          const r = decodeDownloadEnded(pdu.param);
          expect(hex(encodeDownloadEnded(r.type, r.number, r.fs))).toBe(hex(pdu.param));
        } else if (fn === 0x1c) {
          expect(hex(pdu.param)).toBe('1c');
        } else if (pdu.rosctr === 1) {
          const r = decodePlcControlRequest(pdu.param);
          expect(r).toEqual({ function: 0x28, service: '_INSE', block: { type: 'DB', number: 1 } });
          expect(hex(encodeInsertBlock('DB', 1, 'P'))).toBe(hex(pdu.param));
        } else {
          expect(hex(encodeControlResponse(0x28, 0))).toBe(hex(pdu.param));
        }
      }
      // fette 222 + 222 + 56 = 500 byte = load memory dichiarata; EoS 1,1,0
      expect(chunks.map((c) => c.length)).toEqual([222, 222, 56]);
      expect(eos).toEqual([true, true, false]);
      const file = cat(chunks);
      expect(file).toHaveLength(500);
      const h = parseBlockFile(file).header;
      expect(h).toMatchObject({ type: 'DB', number: 1, mc7Length: 400 });
    });
  },
);

const LIBNODAVE = 's7comm_varservice_libnodavedemo.pcap';
describe.skipIf(!existsSync(join(CACHE_DIR, LIBNODAVE)))(
  `${LIBNODAVE} (cattura scaricata: write var di libnodave)`,
  () => {
    it('ogni write var: giro identico e codec che ricostruiscono i byte', () => {
      let n = 0;
      for (const x of s7Pdus(join(CACHE_DIR, LIBNODAVE))) {
        let pdu;
        try {
          pdu = decodeS7(x.whole);
        } catch {
          continue;
        }
        if (pdu.param[0] !== 0x05) continue;
        expect(hex(encodeS7(pdu))).toBe(hex(x.whole));
        if (pdu.rosctr === 1) {
          const e = encodeWriteRequest(decodeWriteRequest(pdu.param, pdu.data));
          expect(hex(e.param)).toBe(hex(pdu.param));
          expect(hex(e.data)).toBe(hex(pdu.data));
          n++;
        } else {
          const e = encodeWriteResponse(
            decodeWriteResponse(pdu.param, pdu.data).map((r) => r.returnCode),
          );
          expect(hex(e.param)).toBe(hex(pdu.param));
          expect(hex(e.data)).toBe(hex(pdu.data));
        }
      }
      expect(n).toBeGreaterThanOrEqual(4);
    });
  },
);
