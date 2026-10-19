import { describe, expect, it } from 'vitest';
import {
  S7Error,
  decodeReadRequest,
  decodeS7,
  encodeReadRequest,
  encodeS7,
  errorName,
  fromHex,
  hex,
  itemReturnName,
} from '../src';

// Parte S7 (dopo TPKT+COTP DT) dei vettori di proto §17.2-§17.4.
const VECTORS: Record<string, string> = {
  'setup REQ 17.2': '32 01 0000 0200 0008 0000  f0 00 0001 0001 01e0',
  'setup RES 17.2': '32 03 0000 0200 0008 0000 0000  f0 00 0001 0001 00f0',
  'read REQ 17.3':
    '32 01 0000 0100 001a 0000 04 02 12 0a 10 02 0010 0001 84 000000 12 0a 10 02 0010 0000 83 000000',
  'read REQ 17.4':
    '32 01 0000 0300 003e 0000 04 05 12 0a 10 02 0006 0000 81 000000 12 0a 10 02 0006 0000 83 000000 ' +
    '12 0a 10 02 0006 0000 83 000030 12 0a 10 02 0036 0000 83 000020 12 0a 10 02 0004 0000 83 000020',
  'read RES 17.3 (1 item, 64 byte)': `32 03 0000 0000 0002 0044 0000 04 01 ff 04 0200 ${'ab'.repeat(64)}`,
  userdata: '32 07 0000 0500 0008 0004 00 01 12 04 11 44 01 00 ff 09 00 00',
};

describe('header S7', () => {
  it('encodeS7(decodeS7(x)) === x per ogni vettore di proto §17', () => {
    for (const [name, h] of Object.entries(VECTORS)) {
      const raw = fromHex(h);
      const pdu = decodeS7(raw);
      expect(hex(encodeS7(pdu)), name).toBe(hex(raw));
    }
  });

  it('i campi del setup RES reale: ROSCTR 3, header da 12 byte, error 0', () => {
    const p = decodeS7(fromHex(VECTORS['setup RES 17.2']!));
    expect(p.rosctr).toBe(3);
    expect(p.pduRef).toBe(0x0200);
    expect(p.errorClass).toBe(0);
    expect(p.errorCode).toBe(0);
    expect(p.param.length).toBe(8);
    expect(p.data.length).toBe(0);
  });

  it('header da 10 byte per 1 e 7, da 12 per 2 e 3', () => {
    const mk = (r: 1 | 2 | 3 | 7): number =>
      encodeS7({
        rosctr: r,
        pduRef: 1,
        errorClass: 0xd2,
        errorCode: 0x09,
        param: new Uint8Array(0),
        data: new Uint8Array(0),
      }).length;
    expect(mk(1)).toBe(10);
    expect(mk(7)).toBe(10);
    expect(mk(2)).toBe(12);
    expect(mk(3)).toBe(12);
    const ack = decodeS7(fromHex('32 02 0000 0001 0000 0000 d2 0c'));
    expect(ack.errorClass).toBe(0xd2);
    expect(ack.errorCode).toBe(0x0c);
  });

  it('PROTOCOL su protocol id errato, ROSCTR ignoto, lunghezze incoerenti, byte in coda', () => {
    const bad = (h: string): void => {
      try {
        decodeS7(fromHex(h));
        throw new Error('non ha lanciato');
      } catch (e) {
        expect(e).toBeInstanceOf(S7Error);
        expect((e as S7Error).code).toBe('PROTOCOL');
      }
    };
    bad('33 01 0000 0001 0000 0000');
    bad('32 09 0000 0001 0000 0000');
    bad('32 01 0000 0001 0005 0000 00'); // param dichiarato 5, presente 1
    bad('32 01 0000 0001 0000 0000 ff'); // byte in coda
    bad('32 01 0000 0001'); // troppo corto
    bad('32 03 0000 0001 0000 0000'); // ack-data senza i 2 byte di errore
  });

  it('encodeS7: pduRef o lunghezze fuori da 16 bit -> RangeError', () => {
    const base = {
      rosctr: 1 as const,
      pduRef: 1,
      errorClass: 0,
      errorCode: 0,
      param: new Uint8Array(0),
      data: new Uint8Array(0),
    };
    expect(() => encodeS7({ ...base, pduRef: 0x10000 })).toThrow(RangeError);
    expect(() => encodeS7({ ...base, param: new Uint8Array(0x10000) })).toThrow(RangeError);
    expect(() => encodeS7({ ...base, data: new Uint8Array(0x10000) })).toThrow(RangeError);
    expect(encodeS7({ ...base, pduRef: 0xffff }).length).toBe(10);
  });

  it('errorName copre la tabella §3.3 e dà "sconosciuto" altrimenti', () => {
    expect(errorName(0x00, 0x00)).toMatch(/nessun errore/);
    expect(errorName(0xd2, 0x09)).toMatch(/non trovato/);
    expect(errorName(0x81, 0x04)).toMatch(/non implementato/);
    expect(errorName(0x85, 0x00)).toMatch(/frame/);
    expect(errorName(0xd0, 0xa1)).toMatch(/protezione/);
    expect(errorName(0xd2, 0x0c)).not.toMatch(/sconosciuto/); // dentro D205-D20C
    expect(errorName(0xd4, 0x02)).not.toMatch(/sconosciuto/);
    expect(errorName(0xef, 0x02)).not.toMatch(/sconosciuto/);
    expect(errorName(0x12, 0x34)).toBe('sconosciuto (0x1234)');
  });

  it('itemReturnName copre proto §5.6', () => {
    expect(itemReturnName(0xff)).toMatch(/successo/);
    expect(itemReturnName(0x0a)).toMatch(/non disponibile/);
    expect(itemReturnName(0x05)).toMatch(/indirizzo/);
    expect(itemReturnName(0x03)).toMatch(/non consentito/);
    expect(itemReturnName(0x42)).toBe('sconosciuto (0x42)');
  });

  it('il modulo non sa codificare una write var (0x05)', () => {
    const wr = fromHex('05 01 12 0a 10 02 0001 0001 84 000000');
    expect(() => decodeReadRequest(wr)).toThrow(S7Error);
    expect(typeof encodeReadRequest).toBe('function');
  });
});
