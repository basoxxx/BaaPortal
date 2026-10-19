import { describe, expect, it } from 'vitest';
import {
  S7Error,
  blockFileName,
  decodeEndUpload,
  decodeEndUploadResponse,
  decodeStartUpload,
  decodeStartUploadResponse,
  decodeUploadRequest,
  decodeUploadResponse,
  encodeEndUpload,
  encodeEndUploadResponse,
  encodeStartUpload,
  encodeStartUploadResponse,
  encodeUpload,
  encodeUploadResponse,
  fromHex,
  hex,
  parseBlockFileName,
} from '../src';
import { SNAP7_UPLOAD } from './vectors';

describe('nome file del blocco (proto §9.1)', () => {
  it('blockFileName: "_" + tipo ASCII + numero a 5 cifre + filesystem', () => {
    expect(blockFileName('DB', 1, 'A')).toBe('_0A00001A');
    expect(blockFileName('SDB', 0, 'A')).toBe('_0B00000A');
    expect(blockFileName('OB', 0, 'A')).toBe('_0800000A');
    expect(blockFileName('SFB', 99999, 'P')).toBe('_0F99999P');
  });
  it('blockFileName rifiuta numero e filesystem fuori campo', () => {
    expect(() => blockFileName('DB', -1, 'A')).toThrow(RangeError);
    expect(() => blockFileName('DB', 100000, 'A')).toThrow(RangeError);
    expect(() => blockFileName('DB', 1.5, 'A')).toThrow(RangeError);
    expect(() => blockFileName('DB', 1, 'X' as 'A')).toThrow(RangeError);
  });
  it("parseBlockFileName è l'inverso", () => {
    expect(parseBlockFileName('_0A00001A')).toEqual({ type: 'DB', number: 1, filesystem: 'A' });
    expect(parseBlockFileName('_0B00000A')).toEqual({ type: 'SDB', number: 0, filesystem: 'A' });
    expect(() => parseBlockFileName('0A00001A')).toThrow(S7Error);
    expect(() => parseBlockFileName('_0Z00001A')).toThrow(S7Error);
    expect(() => parseBlockFileName('_0A0001A')).toThrow(S7Error);
  });
});

describe('sequenza reale di proto §17.8 (cisa/snap7.pcap)', () => {
  const v = SNAP7_UPLOAD;
  it('start upload: richiesta e risposta (id 7, lunghezza 216)', () => {
    expect(hex(encodeStartUpload('_0B00000A'))).toBe(v.startReq);
    expect(decodeStartUpload(fromHex(v.startReq))).toMatchObject({ fileName: '_0B00000A' });
    const r = decodeStartUploadResponse(fromHex(v.startRes));
    expect(r.uploadId).toBe(7);
    expect(r.totalLength).toBe(216);
    expect(r.lengthString).toBe('0000216');
    expect(hex(encodeStartUploadResponse(7, 216))).toBe(v.startRes);
  });
  it('upload: richiesta e risposta (EoU 0, 216 byte di blocco, header dati 00 fb)', () => {
    expect(hex(encodeUpload(7))).toBe(v.upReq);
    expect(decodeUploadRequest(fromHex(v.upReq))).toEqual({ uploadId: 7 });
    const res = decodeUploadResponse(fromHex(v.upResParam), fromHex(v.upResData));
    expect(res.more).toBe(false);
    expect(res.chunk.length).toBe(216);
    expect(hex(res.chunk.subarray(0, 2))).toBe('7070');
    const e = encodeUploadResponse(res.more, res.chunk);
    expect(hex(e.param)).toBe(v.upResParam);
    expect(hex(e.data)).toBe(v.upResData);
    expect(hex(e.data.subarray(0, 4))).toBe('00d800fb');
  });
  it('end upload: richiesta e risposta di un solo byte', () => {
    expect(hex(encodeEndUpload(7))).toBe(v.endReq);
    expect(decodeEndUpload(fromHex(v.endReq))).toEqual({ uploadId: 7 });
    expect(hex(encodeEndUploadResponse())).toBe(v.endRes);
    expect(() => decodeEndUploadResponse(fromHex(v.endRes))).not.toThrow();
  });
});

describe('start upload', () => {
  it('encodeStartUpload rifiuta nomi non di 9 caratteri del formato _TTNNNNNF', () => {
    expect(() => encodeStartUpload('_0A0001A')).toThrow(RangeError);
    expect(() => encodeStartUpload('0A00001AB')).toThrow(RangeError);
  });
  it('decodeStartUploadResponse: lunghezza assente o non numerica dà null, senza lanciare', () => {
    // solo testa, senza stringa lunghezza
    const head = fromHex('1d0001000000000a');
    expect(decodeStartUploadResponse(head)).toMatchObject({ uploadId: 10, totalLength: null });
    // stringa vuota
    expect(decodeStartUploadResponse(fromHex('1d0001000000000a00')).totalLength).toBeNull();
    // stringa strana: resta grezza per il round trip
    const odd = fromHex('1d0001000000000a03' + hex(Uint8Array.from([0x78, 0x79, 0x7a])));
    const r = decodeStartUploadResponse(odd);
    expect(r.totalLength).toBeNull();
    expect(r.lengthString).toBe('xyz');
    expect(hex(encodeStartUploadResponse(r.uploadId, 0, { ...r }))).toBe(hex(odd));
    // con byte non ASCII
    expect(decodeStartUploadResponse(fromHex('1d0001000000000a02ffff')).totalLength).toBeNull();
  });
  it('encodeStartUploadResponse con lunghezza lunga e opzioni grezze', () => {
    const p = encodeStartUploadResponse(1, 12345678);
    expect(decodeStartUploadResponse(p).totalLength).toBe(12345678);
  });
  it('param troncati o di altra funzione: S7Error PROTOCOL', () => {
    expect(() => decodeStartUploadResponse(fromHex('1d00'))).toThrow(S7Error);
    expect(() => decodeStartUploadResponse(fromHex('1e0001000000000a'))).toThrow(S7Error);
    expect(() => decodeStartUploadResponse(fromHex('1d0001000000000a05aa'))).toThrow(S7Error);
    expect(() => decodeStartUpload(fromHex('1d00'))).toThrow(S7Error);
    expect(() => decodeUploadRequest(fromHex('1e00'))).toThrow(S7Error);
    expect(() => decodeEndUpload(fromHex('1e00000000000007'))).toThrow(S7Error);
  });
});

describe('upload', () => {
  it('un blocco in più pezzi: EoU 1 poi 0', () => {
    const a = encodeUploadResponse(true, Uint8Array.of(1, 2, 3));
    expect(hex(a.param)).toBe('1e01');
    expect(decodeUploadResponse(a.param, a.data)).toMatchObject({ more: true });
    const b = encodeUploadResponse(false, new Uint8Array(0));
    expect(decodeUploadResponse(b.param, b.data)).toMatchObject({ more: false });
    expect(decodeUploadResponse(b.param, b.data).chunk.length).toBe(0);
  });
  it("conserva i byte ignoti dell'header dati", () => {
    const d = fromHex('0003aa77010203');
    const r = decodeUploadResponse(fromHex('1e00'), d);
    expect(hex(r.dataHeader)).toBe('aa77');
    expect(hex(encodeUploadResponse(false, r.chunk, r.dataHeader).data)).toBe(hex(d));
  });
  it('lunghezza incoerente, EoU strano o dati troppo corti: S7Error', () => {
    expect(() => decodeUploadResponse(fromHex('1e00'), fromHex('000500fb0102'))).toThrow(S7Error);
    expect(() => decodeUploadResponse(fromHex('1e02'), fromHex('000100fb01'))).toThrow(S7Error);
    expect(() => decodeUploadResponse(fromHex('1e00'), fromHex('00'))).toThrow(S7Error);
    expect(() => decodeUploadResponse(fromHex('1e'), fromHex('000100fb01'))).toThrow(S7Error);
  });
  it('encode rifiuta id e chunk fuori campo', () => {
    expect(() => encodeUpload(-1)).toThrow(RangeError);
    expect(() => encodeUpload(2 ** 32)).toThrow(RangeError);
    expect(() => encodeUploadResponse(true, new Uint8Array(0x10000))).toThrow(RangeError);
  });
});
