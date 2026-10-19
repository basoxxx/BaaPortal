import { describe, expect, it } from 'vitest';
import { FrameReader, S7Error, encodeTpkt, fromHex, hex } from '../src';

const bytes = (n: number, fill = 0xab) => new Uint8Array(n).fill(fill);

describe('TPKT', () => {
  it('encodeTpkt antepone l intestazione', () => {
    expect(hex(encodeTpkt(Uint8Array.of(1, 2, 3)))).toBe('03000007010203');
  });

  it('FrameReader: un frame a pezzi di 1 byte e tre frame in un solo blocco', () => {
    const f = encodeTpkt(bytes(5));
    const r = new FrameReader();
    const got: Uint8Array[] = [];
    for (const b of f) got.push(...r.push(Uint8Array.of(b)));
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual(bytes(5));

    const three = new Uint8Array([
      ...encodeTpkt(bytes(3, 1)),
      ...encodeTpkt(bytes(4, 2)),
      ...encodeTpkt(bytes(5, 3)),
    ]);
    const out = new FrameReader().push(three);
    expect(out.map((x) => [x.length, x[0]])).toEqual([
      [3, 1],
      [4, 2],
      [5, 3],
    ]);
  });

  it('FrameReader tiene i byte parziali per il push successivo', () => {
    const r = new FrameReader();
    const a = new Uint8Array([...encodeTpkt(bytes(3, 1)), ...encodeTpkt(bytes(3, 2)).slice(0, 5)]);
    expect(r.push(a)).toHaveLength(1);
    expect(r.push(encodeTpkt(bytes(3, 2)).slice(5))).toEqual([bytes(3, 2)]);
  });

  it('FrameReader rifiuta versione 2 e lunghezza 3 con S7Error PROTOCOL', () => {
    for (const h of ['02000007aabbcc', '03000003']) {
      try {
        new FrameReader().push(fromHex(h));
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(S7Error);
        expect((e as S7Error).code).toBe('PROTOCOL');
      }
    }
  });
});
