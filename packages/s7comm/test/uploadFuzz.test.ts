import { describe, expect, it } from 'vitest';
import {
  S7Error,
  decodeEndUpload,
  decodeEndUploadResponse,
  decodeStartUpload,
  decodeStartUploadResponse,
  decodeUploadRequest,
  decodeUploadResponse,
  parseBlockFile,
  parseBlockFileName,
} from '../src';

/** mulberry32: PRNG con seme, i casi sono ripetibili. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HEADS = [0x1d, 0x1e, 0x1f, 0x7070 >> 8];

describe('fuzz: upload e formato blocco', () => {
  it('5000 buffer casuali: solo S7Error o RangeError', () => {
    const rnd = prng(0x5eed1d);
    const bytes = (n: number): Uint8Array => {
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i++) b[i] = Math.floor(rnd() * 256);
      return b;
    };
    const fns: ((p: Uint8Array, d: Uint8Array) => unknown)[] = [
      (p) => decodeStartUpload(p),
      (p) => decodeStartUploadResponse(p),
      (p) => decodeUploadRequest(p),
      (p, d) => decodeUploadResponse(p, d),
      (p) => decodeEndUpload(p),
      (p) => decodeEndUploadResponse(p),
      (p) => parseBlockFile(p),
      (p) => parseBlockFileName(String.fromCharCode(...p.subarray(0, 12))),
    ];
    let ok = 0;
    for (let i = 0; i < 5000; i++) {
      const p = bytes(Math.floor(rnd() * 80));
      const d = bytes(Math.floor(rnd() * 60));
      if (i % 2 === 0 && p.length > 0) p[0] = HEADS[Math.floor(rnd() * HEADS.length)]!;
      if (i % 4 === 0 && p.length > 1) p[1] = 0x70; // "pp"
      for (const f of fns) {
        try {
          f(p, d);
          ok++;
        } catch (e) {
          expect(e instanceof S7Error || e instanceof RangeError).toBe(true);
        }
      }
    }
    expect(ok).toBeGreaterThan(0);
  });
});
