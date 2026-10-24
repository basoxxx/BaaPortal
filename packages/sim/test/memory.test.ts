import { describe, expect, it } from 'vitest';
import { SimError, SimMemory, memorySizesFor, stwToWord, wordToStw } from '../src';

describe('memoria della CPU simulata', () => {
  it('memorySizesFor 315-2 PN/DP → I/Q 2048, M 2048', () => {
    const s = memorySizesFor('cpu-315-2-pn-dp');
    expect(s.inputs).toBe(2048);
    expect(s.outputs).toBe(2048);
    expect(s.flags).toBe(2048);
    expect(s.localBytes).toBeGreaterThan(0);
    // CPU sconosciuta: valori di una 315-2 PN/DP
    expect(memorySizesFor('cpu-che-non-esiste')).toEqual(s);
  });

  it('M oltre la fine → SimError AREA_LUNGHEZZA', () => {
    const mem = new SimMemory({ inputs: 8, outputs: 8, flags: 16, localBytes: 32 });
    expect(mem.bytes('M', null, 14, 2)).toHaveLength(2);
    expect(() => mem.bytes('M', null, 15, 2)).toThrowError(SimError);
    try {
      mem.bytes('M', null, 16, 1);
    } catch (e) {
      expect((e as SimError).code).toBe('AREA_LUNGHEZZA');
    }
  });

  it('DB non caricato → SimError DB_NON_CARICATO', () => {
    const mem = new SimMemory({ inputs: 8, outputs: 8, flags: 16, localBytes: 32 });
    expect(() => mem.bytes('DB', 7, 0, 1)).toThrowError(/DB_NON_CARICATO/);
  });

  it('stwToWord/wordToStw: BR=bit 8, /FC=bit 0, andata e ritorno su tutti i 512 valori', () => {
    // Manuale AWL S7-300/400, «Parola di stato»: bit 0 /ER (/FC) … bit 8 BR.
    expect(stwToWord({ ...wordToStw(0), br: true })).toBe(0x100);
    expect(stwToWord({ ...wordToStw(0), fc: true })).toBe(0x001);
    for (let w = 0; w < 512; w++) expect(stwToWord(wordToStw(w))).toBe(w);
  });
});
