import { describe, expect, it } from 'vitest';
import {
  S7Error,
  commFrom,
  decodeSzlRequest,
  decodeUserdata,
  diagFrom,
  encodeSzl,
  encodeSzlRequest,
  fromHex,
  hex,
  identityFrom,
  modeFrom,
  parseSzl,
  protectionFrom,
  type SzlList,
} from '../src';
import * as V from './vectors';

const payloadOf = (v: V.UdVec): Uint8Array =>
  decodeUserdata(fromHex(v.param), fromHex(v.data)).payload;

function list(id: number, index: number, recs: string[]): SzlList {
  const records = recs.map((r) => fromHex(r));
  return { id, index, recordLength: records[0]!.length, records };
}

describe('SZL (proto §7)', () => {
  it('SZL 0x0011 reale di proto §17.5: ordine "6ES7 315-2EH14-0AB0"', () => {
    const l = parseSzl([payloadOf(V.S7IDENT_0011_RES)]);
    expect(l).toMatchObject({ id: 0x0011, index: 0, recordLength: 28 });
    expect(l.records.length).toBe(4);
    const id = identityFrom(l);
    expect(id.orderNumber).toBe('6ES7 315-2EH14-0AB0');
    expect(id.version).toBe('V3.2.6');
  });

  it('SZL 0x001C in due pezzi di proto §17.6 si ricompone con tutti i record', () => {
    const p1 = payloadOf(V.SNAP7_001C_RES1);
    const p2 = payloadOf(V.SNAP7_001C_RES2);
    const l = parseSzl([p1, p2]);
    expect(l).toMatchObject({ id: 0x001c, recordLength: 34 });
    expect(l.records.length).toBe(10);
    expect(l.records.map((r) => r[1])).toEqual([1, 2, 3, 4, 5, 7, 8, 9, 10, 11]);
    const id = identityFrom(parseSzl([payloadOf(V.SNAP7_0011_RES)]), l);
    expect(id.asName).toBe('S7300/ET200M station_1');
    expect(id.moduleName).toBe('PLC_1');
    expect(id.serialNumber).toBe('S C-B1U393142011');
    expect(id.copyright).toBe('Original Siemens Equipment');
    expect(id.mmcSerial).toBe('MMC 4A1AC019');
    // l'encoder produce gli stessi pezzi di una CPU reale (PDU 240 -> 214 byte per pezzo)
    const frags = encodeSzl(l, p1.length);
    expect(frags.map(hex)).toEqual([hex(p1), hex(p2)]);
  });

  it('un solo pezzo se sta in maxPayload', () => {
    const l = parseSzl([payloadOf(V.S7IDENT_0011_RES)]);
    const f = encodeSzl(l, 214);
    expect(f.length).toBe(1);
    expect(hex(f[0]!)).toBe(hex(payloadOf(V.S7IDENT_0011_RES)));
  });

  it('N_DR 0xFFFF: il conteggio si ricalcola dai byte, e si conserva per il round trip', () => {
    const p = fromHex('0011 0000 0004 ffff 0001aaaa 0002bbbb');
    const l = parseSzl([p]);
    expect(l.records.length).toBe(2);
    expect(hex(encodeSzl(l, 100)[0]!)).toBe(hex(p));
  });

  it('record finale incompleto -> PROTOCOL', () => {
    const p = fromHex('0011 0000 0004 ffff 0001aaaa 0002bb');
    expect(() => parseSzl([p])).toThrow(S7Error);
  });

  it('meno byte di quelli dichiarati da N_DR -> PROTOCOL; nessun frammento -> PROTOCOL', () => {
    expect(() => parseSzl([fromHex('0011 0000 0004 0003 0001aaaa')])).toThrow(S7Error);
    expect(() => parseSzl([])).toThrow(S7Error);
    expect(() => parseSzl([fromHex('0011 0000 0004')])).toThrow(S7Error);
  });

  it('richiesta SZL: payload id + index in andata e ritorno', () => {
    expect(hex(encodeSzlRequest(0x0132, 4))).toBe('01320004');
    expect(decodeSzlRequest(fromHex('01320004'))).toEqual({ id: 0x0132, index: 4 });
    expect(() => decodeSzlRequest(fromHex('013200'))).toThrow(S7Error);
  });

  it('modeFrom: byte di modo 0x08 -> RUN, 0x04 -> STOP, altro -> UNKNOWN', () => {
    const mk = (bzu: number): SzlList =>
      list(0x0424, 0, [`5144ff${bzu.toString(16).padStart(2, '0')}00000000${'00'.repeat(12)}`]);
    expect(modeFrom(mk(0x08))).toBe('RUN');
    expect(modeFrom(mk(0x04))).toBe('STOP');
    expect(modeFrom(mk(0x00))).toBe('UNKNOWN');
    expect(modeFrom(mk(0x0f))).toBe('UNKNOWN');
    expect(modeFrom(mk(0x05))).toBe('STARTUP');
    expect(modeFrom(mk(0x0a))).toBe('HOLD');
    expect(modeFrom(mk(0x0d))).toBe('DEFECT');
    expect(modeFrom(mk(0x48))).toBe('RUN'); // da STOP a RUN: conta il nibble basso
  });

  it('modeFrom su 0x0424 reali di cisa: RUN', () => {
    expect(modeFrom(parseSzl([payloadOf(V.SNAP7_0424_RES)]))).toBe('RUN');
    expect(modeFrom(parseSzl([payloadOf(V.S7IDENT_0424_RES)]))).toBe('RUN');
  });

  it('protectionFrom: esempio del documento (selettore RUN-P)', () => {
    const l = list(0x0232, 4, [
      '0004 0001 0003 0003 0002 0000'.replace(/ /g, '') + '00'.repeat(28),
    ]);
    expect(protectionFrom(l)).toEqual({
      switchLevel: 1,
      paramLevel: 3,
      validLevel: 3,
      modeSwitch: 'RUN-P',
    });
    const l2 = list(0x0232, 4, [
      '0004 0001 0000 0001 0003 0000'.replace(/ /g, '') + '00'.repeat(28),
    ]);
    expect(protectionFrom(l2).modeSwitch).toBe('STOP');
    const l3 = list(0x0232, 4, [
      '0004 0001 0000 0001 0009 0000'.replace(/ /g, '') + '00'.repeat(28),
    ]);
    expect(protectionFrom(l3).modeSwitch).toBe('UNKNOWN');
  });

  it('commFrom su 0x0131 reale di cisa/snap7.pcap: PDU 240, 16 connessioni', () => {
    expect(commFrom(parseSzl([payloadOf(V.SNAP7_0131_RES)]))).toEqual({
      maxPdu: 240,
      maxConnections: 16,
    });
  });

  it('diagFrom: id evento, info grezza e ora', () => {
    const rec = '4302' + '00112233445566778899' + '24100421242500 05'.replace(/ /g, '');
    const entries = diagFrom(list(0x00a0, 0, [rec, rec]));
    expect(entries.length).toBe(2);
    expect(entries[0]!.eventId).toBe(0x4302);
    expect(hex(entries[0]!.info)).toBe('00112233445566778899');
    expect(entries[0]!.time).toMatchObject({ year: 2024, month: 10, day: 4, hour: 21 });
  });

  it('un parser tipizzato con la lista sbagliata lancia RangeError (errore del programmatore)', () => {
    expect(() => modeFrom(list(0x0011, 0, ['00'.repeat(20)]))).toThrow(RangeError);
    expect(() => commFrom(list(0x0011, 1, ['00'.repeat(20)]))).toThrow(RangeError);
    expect(() => protectionFrom(list(0x0011, 4, ['00'.repeat(20)]))).toThrow(RangeError);
    expect(() => diagFrom(list(0x0011, 0, ['00'.repeat(20)]))).toThrow(RangeError);
    expect(() => identityFrom(list(0x001c, 0, ['00'.repeat(34)]))).toThrow(RangeError);
    expect(() =>
      identityFrom(list(0x0011, 0, ['00'.repeat(28)]), list(0x0011, 0, ['00'.repeat(28)])),
    ).toThrow(RangeError);
  });

  it("diagFrom: un'ora tutta a zero o con weekday > 7 in mezzo non fa perdere la lista", () => {
    const ok = '4302' + '00112233445566778899' + '2410042124250005';
    const zero = '4303' + 'aabbccddeeff00112233' + '0000000000000000';
    const wd = '4304' + '00000000000000000000' + '2410042124250009';
    const e = diagFrom(list(0x00a0, 0, [ok, zero, wd, ok]));
    expect(e.map((x) => x.eventId)).toEqual([0x4302, 0x4303, 0x4304, 0x4302]);
    expect(e[1]!.time).toBeUndefined();
    expect(hex(e[1]!.rawTime!)).toBe('0000000000000000');
    expect(hex(e[1]!.info)).toBe('aabbccddeeff00112233');
    expect(e[2]!.time).toBeUndefined();
    expect(hex(e[2]!.rawTime!)).toBe('2410042124250009');
    expect(e[3]!.time).toMatchObject({ year: 2024 });
    expect(e[0]!.rawTime).toBeUndefined();
  });

  it('diagFrom: record più corto del layout decodifica i campi che entrano', () => {
    const e = diagFrom(list(0x00a0, 0, ['4302001122']));
    expect(e).toHaveLength(1);
    expect(e[0]!.eventId).toBe(0x4302);
    expect(hex(e[0]!.info)).toBe('001122');
    expect(e[0]!.time).toBeUndefined();
  });

  it('identityFrom: 0x0011 senza index 1 -> orderNumber vuoto, senza lanciare', () => {
    const rec6 = '0006' + '20'.repeat(20) + '00c0' + '0001' + '0000';
    const id = identityFrom(list(0x0011, 0, [rec6]));
    expect(id.orderNumber).toBe('');
    expect(id.version).toBeUndefined();
  });

  it('identityFrom: record più corto del layout -> campi che entrano, il resto undefined', () => {
    const short = '0001' + hex(new TextEncoder().encode('6ES7 315-2EH14'));
    const id = identityFrom(list(0x0011, 0, [short]));
    expect(id.orderNumber).toBe('6ES7 315-2EH14');
    expect(id.version).toBeUndefined();
  });

  it('identityFrom: 0x001C con soli 2 indici su 6, e record cortissimi', () => {
    const l11 = parseSzl([payloadOf(V.S7IDENT_0011_RES)]);
    const str = (i: number, s: string): string =>
      i.toString(16).padStart(4, '0') + hex(new TextEncoder().encode(s)).padEnd(64, '0');
    const l1c = list(0x001c, 0, [str(1, 'AS1'), str(2, 'MOD')]);
    const id = identityFrom(l11, l1c);
    expect(id).toMatchObject({ asName: 'AS1', moduleName: 'MOD' });
    expect(id.serialNumber).toBeUndefined();
    expect(id.mmcSerial).toBeUndefined();
    expect(id.copyright).toBeUndefined();
    expect(id.plantId).toBeUndefined();
    expect(() => identityFrom(l11, list(0x001c, 0, ['00']))).not.toThrow();
  });

  it('modeFrom: record troppo corto o nessun record -> UNKNOWN', () => {
    expect(modeFrom(list(0x0424, 0, ['5144ff']))).toBe('UNKNOWN');
    expect(modeFrom({ id: 0x0424, index: 0, recordLength: 20, records: [] })).toBe('UNKNOWN');
  });

  it('protectionFrom e commFrom: risultato parziale con campi opzionali', () => {
    const p = protectionFrom(list(0x0232, 4, ['0004000100020003']));
    expect(p).toEqual({ switchLevel: 1, paramLevel: 2, validLevel: 3 });
    expect(protectionFrom(list(0x0232, 4, ['0004']))).toEqual({});
    expect(protectionFrom({ id: 0x0232, index: 4, recordLength: 40, records: [] })).toEqual({});
    expect(commFrom(list(0x0131, 1, ['000100f0']))).toEqual({ maxPdu: 240 });
    expect(commFrom(list(0x0131, 1, ['0001']))).toEqual({});
    expect(commFrom(list(0x0131, 2, ['0002' + '00'.repeat(38)]))).toEqual({});
  });
});

describe('SZL solo intestazione (estratto 0x0F)', () => {
  it('0x0F1C: N_DR dichiarato senza record, round trip', () => {
    const p = fromHex('0f1c 0000 0022 000a');
    const l = parseSzl([p]);
    expect(l.records.length).toBe(0);
    expect(l.declaredCount).toBe(10);
    expect(hex(encodeSzl(l, 214)[0]!)).toBe(hex(p));
  });
});
