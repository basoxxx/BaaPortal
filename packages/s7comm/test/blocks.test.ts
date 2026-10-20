import { describe, expect, it } from 'vitest';
import {
  S7Error,
  decodeBlockCounts,
  decodeBlockInfo,
  decodeBlockInfoRequest,
  decodeBlockListOfType,
  decodeBlockListOfTypeRequest,
  decodeUserdata,
  encodeBlockCounts,
  encodeBlockInfo,
  encodeBlockInfoRequest,
  encodeBlockListOfType,
  encodeBlockListOfTypeRequest,
  fromHex,
  hex,
  type BlockInfo,
} from '../src';
import * as V from './vectors';

describe('funzioni blocco (proto §8)', () => {
  it("conteggi reali (cisa/snap7.pcap) e codifica nell'ordine della CPU", () => {
    const { payload } = decodeUserdata(
      fromHex(V.SNAP7_COUNTS_RES.param),
      fromHex(V.SNAP7_COUNTS_RES.data),
    );
    expect(decodeBlockCounts(payload)).toEqual({
      OB: 1,
      FB: 1,
      FC: 0,
      DB: 2,
      SDB: 8,
      SFC: 77,
      SFB: 15,
    });
    expect(hex(encodeBlockCounts(decodeBlockCounts(payload)))).toBe(hex(payload));
  });

  it('conteggi: tipo sconosciuto ignorato, lunghezza non multipla di 4 -> PROTOCOL', () => {
    expect(decodeBlockCounts(fromHex('3039 0007 3038 0001')).OB).toBe(1);
    expect(() => decodeBlockCounts(fromHex('3038 00'))).toThrow(S7Error);
  });

  it('lista blocchi per tipo in due pezzi e ricomposizione', () => {
    const list = Array.from({ length: 30 }, (_, i) => ({
      number: i + 1,
      flags: 0x42,
      language: 1,
    }));
    const frags = encodeBlockListOfType(list, 50); // 12 record da 4 byte per pezzo
    expect(frags.map((f) => f.length)).toEqual([48, 48, 24]);
    expect(decodeBlockListOfType(frags)).toEqual(list);
    const two = encodeBlockListOfType(list.slice(0, 20), 50);
    expect(two.length).toBe(2);
    expect(hex(two[0]!.subarray(0, 4))).toBe('00014201');
    expect(encodeBlockListOfType([], 50).map(hex)).toEqual(['']);
  });

  it('lista per tipo: lunghezza non multipla di 4 -> PROTOCOL', () => {
    expect(() => decodeBlockListOfType([fromHex('0001420100')])).toThrow(S7Error);
  });

  it('payload delle richieste: tipo, e info blocco con numero e lettera', () => {
    expect(hex(encodeBlockListOfTypeRequest('DB'))).toBe('3041');
    expect(decodeBlockListOfTypeRequest(fromHex('3041'))).toBe('DB');
    expect(hex(encodeBlockInfoRequest('DB', 1, 'B'))).toBe('3041303030303142');
    expect(decodeBlockInfoRequest(fromHex('3041303030303142'))).toEqual({
      type: 'DB',
      number: 1,
      filesystem: 'B',
    });
    expect(() => decodeBlockInfoRequest(fromHex('3041303030303142ff'))).toThrow(S7Error);
    expect(() => decodeBlockListOfTypeRequest(fromHex('3039'))).toThrow(S7Error);
  });

  const DB1: BlockInfo = {
    type: 'DB',
    number: 1,
    language: 5,
    flags: 1,
    loadLength: 0x1f4,
    security: 0,
    codeTime: { year: 2014, month: 8, day: 20, hour: 11, minute: 0, second: 0, ms: 0, weekday: 4 },
    interfaceTime: {
      year: 2014,
      month: 8,
      day: 20,
      hour: 11,
      minute: 0,
      second: 0,
      ms: 0,
      weekday: 4,
    },
    ssbLength: 0x1c,
    addLength: 0,
    localDataLength: 0,
    mc7Length: 400,
    author: 'TWI',
    family: 'TestHMI',
    name: 'DATADB',
    version: '0.1',
    checksum: 0xc0df,
  };

  it('get block info DB1: tipo, numero, lunghezze, autore (round trip a 78 byte)', () => {
    const bytes = encodeBlockInfo(DB1);
    expect(bytes.length).toBe(78);
    expect(hex(bytes.subarray(6, 12))).toBe('70700101050a');
    const d = decodeBlockInfo(bytes);
    expect(d).toMatchObject({
      type: 'DB',
      number: 1,
      language: 5,
      mc7Length: 400,
      author: 'TWI',
      family: 'TestHMI',
      name: 'DATADB',
      version: '0.1',
    });
    expect(d.codeTime?.year).toBe(2014);
    expect(hex(encodeBlockInfo(d))).toBe(hex(bytes));
  });

  it('versione dai nibble: 0x11 -> "1.1"', () => {
    const bytes = encodeBlockInfo({ ...DB1, version: '1.1' });
    expect(bytes[66]).toBe(0x11);
    expect(decodeBlockInfo(bytes).version).toBe('1.1');
  });

  it('block info di 70 byte: decodifica i campi che entrano e conserva i byte', () => {
    const full = encodeBlockInfo(DB1);
    const part = full.slice(0, 70);
    const d = decodeBlockInfo(part);
    expect(d).toMatchObject({
      type: 'DB',
      typeCode: 0x0a,
      number: 1,
      mc7Length: 400,
      author: 'TWI',
      name: 'DATADB',
      version: '0.1',
      checksum: 0xc0df,
    });
    expect(d.codeTime?.year).toBe(2014);
    expect(hex(encodeBlockInfo(d))).toBe(hex(part));
    const tiny = decodeBlockInfo(full.slice(0, 14));
    expect(tiny.number).toBe(1);
    expect(tiny.loadLength).toBeUndefined();
    expect(tiny.author).toBeUndefined();
    expect(decodeBlockInfo(new Uint8Array(0)).typeCode).toBeUndefined();
  });

  it('sottotipo sconosciuto: type undefined, typeCode numerico, round trip', () => {
    const bytes = encodeBlockInfo(DB1);
    bytes[11] = 0x33;
    const d = decodeBlockInfo(bytes);
    expect(d.type).toBeUndefined();
    expect(d.typeCode).toBe(0x33);
    expect(hex(encodeBlockInfo(d))).toBe(hex(bytes));
  });

  it('timestamp non valido: codeTime undefined, byte grezzi conservati', () => {
    const bytes = encodeBlockInfo(DB1);
    bytes.set([0x05, 0x26, 0x5c, 0x00, 0x00, 0x01], 22); // ms = un giorno
    const d = decodeBlockInfo(bytes);
    expect(d.codeTime).toBeUndefined();
    expect(d.interfaceTime?.year).toBe(2014);
    expect(hex(encodeBlockInfo(d))).toBe(hex(bytes));
  });
});
