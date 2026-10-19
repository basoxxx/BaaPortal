import { describe, expect, it } from 'vitest';
import {
  S7Error,
  decodeUserdata,
  encodeUserdata,
  fromHex,
  hex,
  reqBlockCounts,
  reqBlockInfo,
  reqContinue,
  reqReadClock,
  reqReadSzl,
} from '../src';
import * as V from './vectors';

const b = (s: string): Uint8Array => fromHex(s);

describe('userdata (ROSCTR 7, proto §6)', () => {
  it('richiesta SZL reale: param lungo 4 (totale 8), nessun campo di unità dati', () => {
    const d = decodeUserdata(b(V.S7IDENT_0011_REQ.param), b(V.S7IDENT_0011_REQ.data));
    expect(d.param).toEqual({
      method: 'request',
      type: 4,
      group: 4,
      subfunction: 1,
      sequence: 0,
    });
    expect(d.returnCode).toBe(0xff);
    expect(hex(d.payload)).toBe('00110000');
    const e = encodeUserdata(d.param, d.payload);
    expect(hex(e.param)).toBe(V.S7IDENT_0011_REQ.param);
    expect(hex(e.data)).toBe(V.S7IDENT_0011_REQ.data);
  });

  it('risposta frammentata reale: dataUnitRef 0xd5, last-data-unit 1, errore 0', () => {
    const d = decodeUserdata(b(V.SNAP7_001C_RES1.param), b(V.SNAP7_001C_RES1.data));
    expect(d.param).toEqual({
      method: 'response',
      type: 8,
      group: 4,
      subfunction: 1,
      sequence: 2,
      dataUnitRef: 0xd5,
      lastDataUnit: true,
      errorCode: 0,
    });
    expect(d.payload.length).toBe(0xd6);
    const e = encodeUserdata(d.param, d.payload, d.returnCode, d.transportSize);
    expect(hex(e.param)).toBe(V.SNAP7_001C_RES1.param);
    expect(hex(e.data)).toBe(V.SNAP7_001C_RES1.data);
  });

  it('richiesta di continuazione reale: method 0x12, type 4, return 0x0a, payload vuoto', () => {
    const d = decodeUserdata(b(V.SNAP7_001C_NEXT.param), b(V.SNAP7_001C_NEXT.data));
    expect(d.param).toMatchObject({
      method: 'response',
      type: 4,
      sequence: 2,
      lastDataUnit: false,
    });
    expect(d.returnCode).toBe(0x0a);
    expect(d.transportSize).toBe(0);
    expect(d.payload.length).toBe(0);
    const e = reqContinue(4, 1, 2);
    expect(hex(e.param)).toBe(V.SNAP7_001C_NEXT.param);
    expect(hex(e.data)).toBe(V.SNAP7_001C_NEXT.data);
  });

  it("risposta d'errore reale (0xd209) con return 0x0a e payload vuoto", () => {
    const d = decodeUserdata(b(V.SNAP7_BLOCKINFO_ERR.param), b(V.SNAP7_BLOCKINFO_ERR.data));
    expect(d.param.errorCode).toBe(0xd209);
    expect(d.returnCode).toBe(0x0a);
    const e = encodeUserdata(d.param, d.payload, d.returnCode, d.transportSize);
    expect(hex(e.param)).toBe(V.SNAP7_BLOCKINFO_ERR.param);
    expect(hex(e.data)).toBe(V.SNAP7_BLOCKINFO_ERR.data);
  });

  it('i costruttori di richieste di sola lettura danno i byte delle richieste reali', () => {
    const cases: [{ param: Uint8Array; data: Uint8Array }, { param: string; data: string }][] = [
      [reqReadSzl(0x0011, 0), V.S7IDENT_0011_REQ],
      [reqReadSzl(0x001c, 0), V.SNAP7_001C_REQ],
      [reqBlockCounts(), V.SNAP7_COUNTS_REQ],
      [reqBlockInfo('DB', 0, 'A'), V.SNAP7_BLOCKINFO_REQ],
      [reqReadClock(), V.SNAP7_CLOCK_REQ],
    ];
    for (const [got, want] of cases) {
      expect(hex(got.param)).toBe(want.param);
      expect(hex(got.data)).toBe(want.data);
    }
  });

  it('non codifica il set clock (né altre funzioni che modificano), in nessuna forma', () => {
    for (const sub of [2, 4]) {
      expect(() =>
        encodeUserdata(
          { method: 'request', group: 7, subfunction: sub, sequence: 0 },
          new Uint8Array(10),
        ),
      ).toThrow(RangeError);
    }
  });

  it('input malformati danno S7Error PROTOCOL', () => {
    const bad: [string, string][] = [
      ['00011204114401', 'ff09000400110000'], // param corto
      ['0002120411440100', 'ff09000400110000'], // head sbagliato
      ['0001120511440100', 'ff09000400110000'], // param length 5
      ['0001120411440100', 'ff090004001100'], // dati troncati
      ['0001120411440100', 'ff09000200110000'], // lunghezza incoerente
      ['0001120411440100', 'ff09'], // dati < 4 byte
      ['0001120411440100', 'ff09000400110000aa'], // byte in più
      ['0001120311440100', 'ff09000400110000'], // method sconosciuto
    ];
    for (const [p, d] of bad) {
      let err: unknown;
      try {
        decodeUserdata(b(p), b(d));
      } catch (e) {
        err = e;
      }
      expect(err, p + d).toBeInstanceOf(S7Error);
      expect((err as S7Error).code).toBe('PROTOCOL');
    }
  });

  it('senza parte dati: hasData false e round trip', () => {
    const p = b('000112081284010000000000');
    const d = decodeUserdata(p, new Uint8Array(0));
    expect(d.hasData).toBe(false);
    const e = encodeUserdata(d.param, null);
    expect(hex(e.param)).toBe(hex(p));
    expect(e.data.length).toBe(0);
  });
});
