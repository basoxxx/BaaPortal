import { describe, expect, it } from 'vitest';
import {
  decodeBStack,
  decodeIStack,
  decodeLStack,
  decodeTisReply,
  fromHex,
  hex,
  reqStack,
} from '../src';

const TIME = '1408201205310304'; // 2014-08-20 12:05:31.030
const entry = (type: number, num: number, ret: number): string =>
  type.toString(16).padStart(4, '0') +
  num.toString(16).padStart(4, '0') +
  ret.toString(16).padStart(4, '0') +
  '0a0b' +
  '00010002' +
  '00000000';
const ob1 = entry(0x08, 1, 0x20) + '01' + '000000' + TIME;
const fc10 = entry(0x0c, 10, 0x08);

describe('stack (proto §18.6)', () => {
  it('decodeBStack: OB1 + FC10 → 2 voci, OB1 con priorità 1', () => {
    const r = decodeBStack(fromHex(ob1 + fc10));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.entries).toHaveLength(2);
    expect(r.value.entries[0]).toMatchObject({
      blockType: 'OB',
      number: 1,
      returnAddress: 0x20,
      db1: { type: 0x0a, number: 1 },
      db2: { type: 0x0b, number: 2 },
      ob: { priority: 1, time: { year: 2014, month: 8, day: 20 } },
    });
    expect(r.value.entries[1]).toMatchObject({ blockType: 'FC', number: 10 });
    expect(r.value.rest).toBeUndefined();
  });

  it('la lunghezza dichiarata 4 byte più corta non cambia le voci', () => {
    const body = fromHex(ob1 + fc10);
    const tisLen = body.length - 4;
    const data = fromHex(
      'ff09' +
        (4 + 4 + tisLen).toString(16).padStart(4, '0') +
        '0004' +
        tisLen.toString(16).padStart(4, '0') +
        '01000001' +
        hex(body),
    );
    const reply = decodeTisReply(fromHex('000112081281040100000000'), data);
    const r = decodeBStack(reply.tisData!);
    expect(r.ok && r.value.entries).toHaveLength(2);
  });

  it('10 byte in più → voci intere più rest in esadecimale', () => {
    const r = decodeBStack(fromHex(ob1 + fc10 + '00112233445566778899'));
    expect(r.ok && r.value.entries).toHaveLength(2);
    if (r.ok) expect(r.value.rest).toBe('00112233445566778899');
  });

  it('una voce OB incompleta finisce in rest', () => {
    const r = decodeBStack(fromHex(fc10 + ob1.slice(0, 40)));
    if (!r.ok) throw new Error('atteso ok');
    expect(r.value.entries).toHaveLength(1);
    expect(r.value.rest).toBe(ob1.slice(0, 40));
  });

  const istack = (): string =>
    '0008' +
    '0001' +
    '0022' + // blocco in cui si riprende OB1 @0x22
    '0a0b' +
    '0001' +
    '0002' +
    '00000000' +
    '11111111' +
    '22222222' +
    '33333333' +
    '44444444' +
    '55555555' +
    '66666666' +
    '0000' +
    '0106' +
    '000c' +
    '000a' +
    '0010' + // interrotto FC10 @0x10
    '000000000000' +
    '000000000000000000000000' +
    TIME;

  it('decodeIStack: 76 byte → STW, ACCU1, blocco interrotto', () => {
    const bytes = fromHex(istack().replace(/\s/g, ''));
    expect(bytes.length).toBe(76);
    const r = decodeIStack(bytes);
    if (!r.ok) throw new Error(r.why);
    expect(r.value).toMatchObject({
      stw: 0x0106,
      accu1: 0x11111111,
      ar2: 0x66666666,
      resume: { blockType: 'OB', number: 1, address: 0x22 },
      interrupted: { blockType: 'FC', number: 10, address: 0x10 },
      db1: { type: 0x0a, number: 1 },
    });
    expect(r.value.time?.year).toBe(2014);
  });

  it("decodeIStack: 40 byte → ok:false con l'esadecimale; più lungo → resto in hex", () => {
    const short = new Uint8Array(40).fill(1);
    expect(decodeIStack(short)).toMatchObject({ ok: false, hex: hex(short) });
    const long = fromHex(istack().replace(/\s/g, '') + 'ab');
    const r = decodeIStack(long);
    expect(r.ok && r.value.rest).toBe('ab');
  });

  it('decodeLStack: blocco, dati locali, priorità e ora', () => {
    const bytes = fromHex('0008' + '0001' + '0004' + '0004' + 'deadbeef' + '01000000' + TIME);
    const r = decodeLStack(bytes);
    if (!r.ok) throw new Error(r.why);
    expect(r.value).toMatchObject({ address: 4, priority: 1 });
    expect(hex(r.value.local)).toBe('deadbeef');
    expect(decodeLStack(bytes.slice(0, 10))).toMatchObject({ ok: false });
  });

  it('reqStack: dati 00 00 e, per LSTACK, priorità e profondità', () => {
    expect(hex(reqStack('BSTACK').data.slice(-2))).toBe('0000');
    expect(reqStack('BSTACK').param[6]).toBe(4);
    expect(reqStack('ISTACK').param[6]).toBe(3);
    const l = reqStack('LSTACK', { priority: 1, depth: 2 });
    expect(l.param[6]).toBe(5);
    expect(hex(l.data.slice(-2))).toBe('0102');
  });
});
