import { describe, expect, it } from 'vitest';
import { S7Error, decodeSetup, encodeSetup, fromHex, hex } from '../src';

describe('setup communication', () => {
  it('setup communication reale di proto §17.2: richiesta e risposta, PDU 480 -> 240', () => {
    const req = fromHex('f0 00 0001 0001 01e0');
    const res = fromHex('f0 00 0001 0001 00f0');
    expect(decodeSetup(req)).toEqual({ amqCalling: 1, amqCalled: 1, pduLength: 480 });
    expect(decodeSetup(res)).toEqual({ amqCalling: 1, amqCalled: 1, pduLength: 240 });
    expect(hex(encodeSetup({ amqCalling: 1, amqCalled: 1, pduLength: 480 }))).toBe(hex(req));
    expect(hex(encodeSetup({ amqCalling: 1, amqCalled: 1, pduLength: 240 }))).toBe(hex(res));
  });

  it('PROTOCOL se la funzione non e 0xF0 o il parametro e troppo corto', () => {
    expect(() => decodeSetup(fromHex('04 00 0001 0001 01e0'))).toThrow(S7Error);
    expect(() => decodeSetup(fromHex('f0 00 0001'))).toThrow(S7Error);
  });

  it('valori fuori da 16 bit -> RangeError', () => {
    expect(() => encodeSetup({ amqCalling: 1, amqCalled: 1, pduLength: 70000 })).toThrow(
      RangeError,
    );
  });
});
