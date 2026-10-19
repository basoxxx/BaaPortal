import { describe, expect, it } from 'vitest';
import { S7Error, decodeCotp, encodeCotp, fromHex, hex } from '../src';

// Proto §17.1, senza l intestazione TPKT.
const CR = '11e0 0000 000f 00 c1020100 c2020102 c0010a';
const CC = '11d0 000f 0003 00 c0010a c1020100 c2020102';

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('COTP', () => {
  it('CR e CC reali di proto §17.1 si decodificano e si ricodificano identici', () => {
    for (const h of [CR, CC]) {
      const raw = fromHex(h);
      const pdu = decodeCotp(raw);
      expect(pdu).toMatchObject({ srcTsap: 0x0100, dstTsap: 0x0102, tpduSize: 0x0a });
      expect(hex(encodeCotp(pdu))).toBe(hex(raw));
    }
    expect(decodeCotp(fromHex(CR))).toMatchObject({ type: 'CR', dstRef: 0, srcRef: 0x000f });
    expect(decodeCotp(fromHex(CC))).toMatchObject({ type: 'CC', dstRef: 0x000f, srcRef: 3 });
  });

  it('DT porta il bit EOT e i dati', () => {
    expect(decodeCotp(fromHex('02f080aabb'))).toEqual({
      type: 'DT',
      eot: true,
      data: Uint8Array.of(0xaa, 0xbb),
    });
    expect(decodeCotp(fromHex('02f000aa'))).toMatchObject({ type: 'DT', eot: false });
    expect(hex(encodeCotp({ type: 'DT', eot: true, data: Uint8Array.of(1) }))).toBe('02f08001');
  });

  it('DR ed ER si ricodificano identici', () => {
    for (const h of ['06800001000203', '0470000105']) {
      expect(hex(encodeCotp(decodeCotp(fromHex(h))))).toBe(h);
    }
  });

  it('parametri sconosciuti saltati; parametro troncato e tipo ignoto -> PROTOCOL', () => {
    const p = decodeCotp(fromHex('0ee0 0000 0001 00 c1020100 99020000'));
    expect(p).toMatchObject({ type: 'CR', srcTsap: 0x0100 });
    expect(() => decodeCotp(fromHex('08e0 0000 0001 00 c105'))).toThrow(S7Error);
    expect(() => decodeCotp(fromHex('02 e1'))).toThrow(S7Error);
    expect(() => decodeCotp(fromHex('02 10 00'))).toThrow(S7Error);
    expect(() => decodeCotp(new Uint8Array(0))).toThrow(S7Error);
  });

  it('decodeCotp su 200 sequenze casuali non lancia altro che S7Error', () => {
    const rnd = mulberry32(0x5eed);
    for (let n = 0; n < 200; n++) {
      const len = Math.floor(rnd() * 24);
      const b = new Uint8Array(len);
      for (let i = 0; i < len; i++) b[i] = Math.floor(rnd() * 256);
      if (len > 1 && n % 2 === 0) b[1] = [0xe0, 0xd0, 0xf0, 0x80, 0x70][n % 5]!;
      try {
        decodeCotp(b);
      } catch (e) {
        expect(e).toBeInstanceOf(S7Error);
      }
    }
  });
});
