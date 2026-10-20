import { describe, expect, it } from 'vitest';
import { blockChecksum, readBlockFile } from '../src';
import { realBlocks } from './realBlocks';

const hexBytes = (s: string): Uint8Array =>
  Uint8Array.from(s.split(/\s+/).map((h) => parseInt(h, 16)));

describe('CRC del blocco (mc7 §1.7, vettori §5.4)', () => {
  it('vettori documentati', () => {
    expect(blockChecksum(0x0e, hexBytes('65 00'))).toBe(0xd513);
    expect(blockChecksum(0x0c, hexBytes('c0 00 c1 00 c3 00 c4 00 c5 00 d8 80 65 00'))).toBe(0x7822);
    expect(blockChecksum(0x0a, hexBytes('00 00'))).toBe(0x196a);
  });

  it('rifiuta valori fuori intervallo', () => {
    expect(() => blockChecksum(256, new Uint8Array(0))).toThrow(RangeError);
    expect(() => blockChecksum(8, new Uint8Array(0x10000))).toThrow(RangeError);
  });

  // mc7 §1.7: DB4/DB13/DB121 hanno dati cambiati dopo il download; gli altri DB caricati da
  // strumenti senza checksum portano 0000. Tutti gli altri blocchi corrispondono.
  const CHANGED = new Set(['DB4', 'DB13', 'DB121']);
  const ZERO = new Set(['DB1806', 'DB3001', 'DB3002', 'DB3003', 'DB3004', 'DB3005', 'DB310']);

  it('tutti i blocchi reali disponibili: corrispondenza o eccezione documentata', () => {
    let matches = 0;
    let changed = 0;
    let zero = 0;
    for (const b of realBlocks()) {
      const f = readBlockFile(b.bytes);
      const got = blockChecksum(f.header.kindCode, f.mc7);
      if (CHANGED.has(b.name)) {
        expect(got, b.name).not.toBe(f.footer.checksum);
        expect(f.footer.checksum, b.name).not.toBe(0);
        changed++;
      } else if (ZERO.has(b.name)) {
        expect(f.footer.checksum, b.name).toBe(0);
        expect(got, b.name).not.toBe(0);
        zero++;
      } else {
        expect(got, b.name).toBe(f.footer.checksum);
        matches++;
      }
    }
    console.log(`[crc] corrispondenze ${matches}, dati cambiati ${changed}, a zero ${zero}`);
    expect(matches).toBeGreaterThanOrEqual(1); // almeno le catture del repository (SDB0)
    if (realBlocks().length === 31) {
      expect([matches, changed, zero]).toEqual([21, 3, 7]);
    }
  });
});
