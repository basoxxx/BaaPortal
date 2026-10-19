import { readFileSync } from 'node:fs';
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
import { DIR, HAVE, files, tpkts } from './captures';

if (!HAVE) console.warn(`[realReadVar] catture assenti in ${DIR}: test saltato`);

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
