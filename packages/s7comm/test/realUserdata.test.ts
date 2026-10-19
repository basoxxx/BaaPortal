import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  S7Error,
  commFrom,
  decodeBcdDateTime,
  decodeBlockCounts,
  decodeBlockInfo,
  decodeBlockInfoRequest,
  decodeBlockListOfType,
  decodeBlockListOfTypeRequest,
  decodeCotp,
  decodeS7,
  decodeSzlRequest,
  decodeUserdata,
  diagFrom,
  encodeBcdDateTime,
  encodeBlockCounts,
  encodeBlockInfo,
  encodeBlockInfoRequest,
  encodeBlockListOfType,
  encodeBlockListOfTypeRequest,
  encodeSzl,
  encodeSzlRequest,
  encodeUserdata,
  hex,
  identityFrom,
  modeFrom,
  parseSzl,
  protectionFrom,
  type SzlList,
} from '../src';
import { DIR, HAVE, files, tpkts } from './captures';

if (!HAVE) console.warn(`[realUserdata] catture assenti in ${DIR}: test saltato`);

interface Stats {
  pdus7: number;
  noHead: number;
  generic: number;
  setClock: number;
  szlReq: number;
  szlFrag: number;
  szlLists: number;
  typedSzl: number;
  counts: number;
  listReq: number;
  listFrag: number;
  listSeq: number;
  infoReq: number;
  info: number;
  clock: number;
  mismatch: number;
}

const zero = (): Stats => ({
  pdus7: 0,
  noHead: 0,
  generic: 0,
  setClock: 0,
  szlReq: 0,
  szlFrag: 0,
  szlLists: 0,
  typedSzl: 0,
  counts: 0,
  listReq: 0,
  listFrag: 0,
  listSeq: 0,
  infoReq: 0,
  info: 0,
  clock: 0,
  mismatch: 0,
});

describe.skipIf(!HAVE)('userdata su catture reali: encode(decode(x)) identico', () => {
  it('ogni PDU ROSCTR 7 coperta, per file', () => {
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
      const guard = (what: string, fn: () => void): void => {
        try {
          fn();
        } catch (e) {
          s.mismatch++;
          fails.push(`${name} ${what}: ${String(e)}`);
        }
      };
      // frammenti aperti per (gruppo, sottofunzione), risposta dopo risposta
      const open = new Map<string, { frags: Uint8Array[]; seq: number }>();
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
        if (pdu.rosctr !== 7) continue;
        s.pdus7++;
        let d;
        try {
          d = decodeUserdata(pdu.param, pdu.data);
        } catch (e) {
          if (!(e instanceof S7Error)) throw e;
          s.noHead++; // non è userdata con testa 00 01 12 (altre funzioni)
          continue;
        }
        const { param: up } = d;
        const isSetClock =
          up.method === 'request' &&
          up.group === 7 &&
          (up.subfunction === 2 || up.subfunction === 4);
        if (isSetClock) {
          s.setClock++; // il codificatore rifiuta di proposito di scriverla
        } else {
          s.generic++;
          guard('generico', () => {
            const e = encodeUserdata(
              d.param,
              d.hasData ? d.payload : null,
              d.returnCode,
              d.transportSize,
            );
            same('generico param', e.param, pdu.param);
            same('generico dati', e.data, pdu.data);
          });
        }
        const g = up.group;
        const sub = up.subfunction;
        const isReq = up.type === 4 && d.payload.length > 0;
        const ok = d.hasData && d.returnCode === 0xff;
        const key = `${g}/${sub}`;
        const tag = `g${g}/${sub} seq${up.sequence}`;
        if (g === 4 && sub === 1) {
          if (isReq && up.method === 'request') {
            s.szlReq++;
            guard(tag + ' richiesta SZL', () => {
              const r = decodeSzlRequest(d.payload);
              same(tag + ' richiesta SZL', encodeSzlRequest(r.id, r.index), d.payload);
            });
          } else if (up.type === 8 && ok) {
            s.szlFrag++;
            const cur = open.get(key) ?? { frags: [], seq: up.sequence };
            cur.frags.push(d.payload);
            if (up.lastDataUnit) {
              open.set(key, cur);
            } else {
              open.delete(key);
              guard(tag + ' lista SZL', () => {
                const list = parseSzl(cur.frags);
                s.szlLists++;
                const frags = encodeSzl(list, Math.max(cur.frags[0]!.length, 9));
                same(
                  tag + ' frammenti SZL ' + cur.frags.length,
                  Uint8Array.from(frags.flatMap((x) => [...x, 0xee])),
                  Uint8Array.from(cur.frags.flatMap((x) => [...x, 0xee])),
                );
                typed(list, s, guard);
              });
            }
          }
        } else if (g === 3 && sub === 1 && up.type === 8 && ok) {
          s.counts++;
          guard(tag + ' conteggi', () =>
            same(tag + ' conteggi', encodeBlockCounts(decodeBlockCounts(d.payload)), d.payload),
          );
        } else if (g === 3 && sub === 2) {
          if (isReq && up.method === 'request') {
            s.listReq++;
            guard(tag + ' richiesta lista', () =>
              same(
                tag + ' richiesta lista',
                encodeBlockListOfTypeRequest(decodeBlockListOfTypeRequest(d.payload)),
                d.payload,
              ),
            );
          } else if (up.type === 8 && ok) {
            s.listFrag++;
            const cur = open.get(key) ?? { frags: [], seq: up.sequence };
            cur.frags.push(d.payload);
            if (up.lastDataUnit) {
              open.set(key, cur);
            } else {
              open.delete(key);
              s.listSeq++;
              guard(tag + ' lista per tipo', () => {
                const list = decodeBlockListOfType(cur.frags);
                const frags = encodeBlockListOfType(list, Math.max(cur.frags[0]!.length, 4));
                same(
                  tag + ' lista per tipo ' + cur.frags.length,
                  Uint8Array.from(frags.flatMap((x) => [...x, 0xee])),
                  Uint8Array.from(cur.frags.flatMap((x) => [...x, 0xee])),
                );
              });
            }
          }
        } else if (g === 3 && sub === 3) {
          if (isReq && up.method === 'request') {
            s.infoReq++;
            guard(tag + ' richiesta info', () => {
              const r = decodeBlockInfoRequest(d.payload);
              same(
                tag + ' richiesta info',
                encodeBlockInfoRequest(r.type, r.number, r.filesystem),
                d.payload,
              );
            });
          } else if (up.type === 8 && ok) {
            s.info++;
            guard(tag + ' block info', () => {
              const bi = decodeBlockInfo(d.payload);
              same(tag + ' block info', encodeBlockInfo(bi), d.payload);
              // anche i timestamp calcolati (senza i byte grezzi) devono dare quelli del filo
              const calc = {
                ...bi,
                raw: { ...bi.raw, codeTime: undefined, interfaceTime: undefined },
              };
              same(tag + ' block info (timestamp calcolati)', encodeBlockInfo(calc), d.payload);
            });
          }
        } else if (g === 7 && (sub === 1 || sub === 3) && up.type === 8 && ok) {
          s.clock++;
          guard(tag + ' orologio', () =>
            same(tag + ' orologio', encodeBcdDateTime(decodeBcdDateTime(d.payload)), d.payload),
          );
        }
      }
      const entries = Object.entries(s) as [keyof Stats, number][];
      lines.push(`${name}: ${entries.map(([k, v]) => `${k}=${v}`).join(' ')}`);
      for (const [k, v] of entries) total[k] += v;
    }
    const sum = Object.entries(total)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    console.log(`[realUserdata]\n${lines.join('\n')}\nTOTALE: ${sum}`);
    if (fails.length) console.log(fails.slice(0, 25).join('\n'));
    expect(total.mismatch).toBe(0);
    expect(total.generic).toBeGreaterThan(0);
  });
});

/** Fa passare ogni lista reale dai parser tipizzati: nessuna deve lanciare. */
function typed(list: SzlList, s: Stats, guard: (what: string, fn: () => void) => void): void {
  const id = list.id & 0xff;
  const base = list.id & 0x0fff;
  const w = `SZL ${list.id.toString(16)}/${list.index.toString(16)}`;
  const run = (fn: () => void): void => {
    s.typedSzl++;
    guard(w, fn);
  };
  if (id === 0x11 && list.records.length > 0 && list.id === 0x0011) run(() => identityFrom(list));
  if (base === 0x424)
    run(() =>
      expect(['RUN', 'STOP', 'STARTUP', 'HOLD', 'DEFECT', 'UNKNOWN']).toContain(modeFrom(list)),
    );
  if (base === 0x131 && list.index === 1) run(() => commFrom(list));
  if (id === 0x32 && list.index === 4) run(() => protectionFrom(list));
  if (base === 0x0a0 && list.records.length > 0) run(() => diagFrom(list));
}
