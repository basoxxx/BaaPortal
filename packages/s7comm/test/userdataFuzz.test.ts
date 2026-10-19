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
  decodeBlockTimestamp,
  decodeSzlRequest,
  decodeUserdata,
  diagFrom,
  identityFrom,
  modeFrom,
  parseSzl,
  protectionFrom,
} from '../src';

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('fuzz dei decoder userdata', () => {
  it('5000 buffer casuali: solo S7Error o RangeError', () => {
    const rnd = mulberry32(0x7ead);
    const buf = (max: number): Uint8Array => {
      const b = new Uint8Array(Math.floor(rnd() * max));
      for (let i = 0; i < b.length; i++) b[i] = Math.floor(rnd() * 256);
      return b;
    };
    const run = (f: () => unknown): void => {
      try {
        f();
      } catch (e) {
        expect(e instanceof S7Error || e instanceof RangeError, String(e)).toBe(true);
      }
    };
    for (let n = 0; n < 5000; n++) {
      const a = buf(120);
      const p = buf(14);
      if (p.length > 4 && n % 2 === 0) {
        p.set([0, 1, 0x12, n % 4 === 0 ? 4 : 8, 0x11 + (n % 3)], 0);
      }
      const d = buf(40);
      if (d.length > 3 && n % 3 !== 0) {
        d[1] = 9;
        d[2] = 0;
        d[3] = d.length - 4;
      }
      run(() => decodeUserdata(p, d));
      run(() => decodeSzlRequest(a.subarray(0, n % 7)));
      run(() => decodeBlockCounts(a));
      run(() => decodeBlockListOfType([a, a.subarray(0, n % 9)]));
      run(() => decodeBlockListOfTypeRequest(a.subarray(0, n % 4)));
      run(() => decodeBlockInfoRequest(a.subarray(0, n % 10)));
      run(() => decodeBcdDateTime(a.subarray(0, 8 + (n % 3))));
      run(() => decodeBlockTimestamp(a.subarray(0, 6)));
      const info = new Uint8Array(78);
      info.set(a.subarray(0, 78));
      if (n % 2 === 0) info[11] = 0x08 + (n % 8);
      run(() => decodeBlockInfo(info));
      // SZL: intestazione plausibile + byte casuali
      const h = new Uint8Array(8 + a.length);
      h.set(a, 8);
      h[0] = 0;
      h[1] = [0x11, 0x1c, 0x24, 0x31, 0x32, 0xa0][n % 6]!;
      h[2] = 0;
      h[3] = 1 + (n % 5);
      h[4] = 0;
      h[5] = (n % 41) + 1;
      h[6] = n % 5 === 0 ? 0xff : 0;
      h[7] = n % 5 === 0 ? 0xff : n % 4;
      run(() => {
        const l = parseSzl([h, a.subarray(0, n % 50)]);
        for (const f of [modeFrom, commFrom, protectionFrom, diagFrom, identityFrom]) {
          run(() => f(l));
        }
        run(() => identityFrom(l, l));
      });
    }
  });
});
