import { describe, expect, it } from 'vitest';
import {
  S7Error,
  decodeBcdDateTime,
  decodeBlockTimestamp,
  decodeUserdata,
  encodeBcdDateTime,
  encodeBlockTimestamp,
  fromHex,
  hex,
} from '../src';
import * as V from './vectors';

describe('ora BCD (proto §12.1)', () => {
  it('risposta clock reale (cisa/snap7.pcap) in andata e ritorno', () => {
    const { payload } = decodeUserdata(
      fromHex(V.SNAP7_CLOCK_RES.param),
      fromHex(V.SNAP7_CLOCK_RES.data),
    );
    const t = decodeBcdDateTime(payload);
    expect(t).toEqual({
      year: 2016,
      month: 2,
      day: 8,
      hour: 14,
      minute: 51,
      second: 37,
      ms: 916,
      weekday: 2,
    });
    expect(hex(encodeBcdDateTime(t))).toBe(hex(payload));
  });

  it('esempio del documento: 2014-08-20 11:59:43.912 weekday 4', () => {
    const raw = fromHex('00 19 14 08 20 11 59 43 91 24');
    expect(decodeBcdDateTime(raw)).toMatchObject({
      year: 2014,
      month: 8,
      day: 20,
      ms: 912,
      weekday: 4,
    });
    expect(hex(encodeBcdDateTime(decodeBcdDateTime(raw)))).toBe(hex(raw));
  });

  it('anni: 90-99 sono 199x, 00-89 sono 20xx', () => {
    expect(decodeBcdDateTime(fromHex('00 19 99 12 31 23 59 59 00 07')).year).toBe(1999);
    expect(decodeBcdDateTime(fromHex('00 19 90 01 01 00 00 00 00 01')).year).toBe(1990);
    expect(decodeBcdDateTime(fromHex('00 19 89 01 01 00 00 00 00 01')).year).toBe(2089);
    expect(decodeBcdDateTime(fromHex('00 19 00 01 01 00 00 00 00 01')).year).toBe(2000);
  });

  it('forma corta a 8 byte (buffer diagnostico)', () => {
    const t = decodeBcdDateTime(fromHex('24 10 04 21 24 25 00 05'));
    expect(t).toMatchObject({
      year: 2024,
      month: 10,
      day: 4,
      hour: 21,
      minute: 24,
      second: 25,
      ms: 0,
      weekday: 5,
    });
  });

  it('campi fuori intervallo o non BCD danno S7Error PROTOCOL', () => {
    const bad = [
      '00 19 14 13 20 11 59 43 91 24', // mese 13
      '00 19 14 00 20 11 59 43 91 24', // mese 0
      '00 19 14 08 32 11 59 43 91 24', // giorno 32
      '00 19 14 08 00 11 59 43 91 24', // giorno 0
      '00 19 14 08 20 24 59 43 91 24', // ora 24
      '00 19 14 08 20 11 60 43 91 24', // minuto 60
      '00 19 14 08 20 11 59 60 91 24', // secondo 60
      '00 19 1a 08 20 11 59 43 91 24', // cifra non BCD
      '00 19 14 08 20 11 59 43 9a 24', // ms non BCD
      '00 19 14 08 20 11 59 43 91 28', // weekday 8
      '00 19 14 08 20 11 59 43 91', // 9 byte
    ];
    for (const h of bad) {
      let err: unknown;
      try {
        decodeBcdDateTime(fromHex(h));
      } catch (e) {
        err = e;
      }
      expect(err, h).toBeInstanceOf(S7Error);
      expect((err as S7Error).code).toBe('PROTOCOL');
    }
  });

  it('encode rifiuta campi non validi con S7Error PROTOCOL', () => {
    const t = { year: 2014, month: 13, day: 1, hour: 0, minute: 0, second: 0, ms: 0 };
    expect(() => encodeBcdDateTime(t)).toThrow(S7Error);
    expect(() => encodeBcdDateTime({ ...t, month: 1, year: 2090 })).toThrow(S7Error);
  });

  it('timestamp di blocco a 6 byte: ms dalla mezzanotte + giorni dal 1984-01-01', () => {
    // 0x02914760 ms = 11:00:... ; 0x2bb5 giorni
    const raw = fromHex('02 91 47 60 2b b5');
    const t = decodeBlockTimestamp(raw);
    expect(t.year).toBe(2014);
    expect(hex(encodeBlockTimestamp(t))).toBe(hex(raw));
    expect(decodeBlockTimestamp(new Uint8Array(6))).toMatchObject({
      year: 1984,
      month: 1,
      day: 1,
      hour: 0,
    });
    expect(() => decodeBlockTimestamp(fromHex('05 26 5c 00 00 00'))).toThrow(S7Error); // 86400000 ms
    expect(() => decodeBlockTimestamp(new Uint8Array(5))).toThrow(S7Error);
  });

  it('encodeBlockTimestamp valida ms e intervallo di date', () => {
    const t = { year: 2014, month: 8, day: 20, hour: 11, minute: 0, second: 0, ms: 0 };
    expect(() => encodeBlockTimestamp(t)).not.toThrow();
    expect(() => encodeBlockTimestamp({ ...t, hour: 24 })).toThrow(S7Error);
    expect(() => encodeBlockTimestamp({ ...t, ms: 1000 })).toThrow(S7Error);
    expect(() => encodeBlockTimestamp({ ...t, minute: -1 })).toThrow(S7Error);
    expect(() => encodeBlockTimestamp({ ...t, year: 1983 })).toThrow(S7Error);
    expect(() => encodeBlockTimestamp({ ...t, year: 2200 })).toThrow(S7Error);
    expect(() => encodeBlockTimestamp({ ...t, month: 2, day: 31 })).toThrow(S7Error);
    expect(() => encodeBlockTimestamp({ ...t, month: 13 })).toThrow(S7Error);
    expect(() => encodeBlockTimestamp({ ...t, day: 1.5 })).toThrow(S7Error);
  });
});
