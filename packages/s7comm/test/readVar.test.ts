import { describe, expect, it } from 'vitest';
import {
  S7Error,
  decodeReadRequest,
  decodeReadResponse,
  encodeReadRequest,
  encodeReadResponse,
  fromHex,
  hex,
  type ItemResult,
  type ReadItem,
} from '../src';

const rnd = (n: number, seed: number): Uint8Array =>
  Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) & 0xff);

describe('read var', () => {
  it('read var a 2 item di proto §17.3 e la risposta a 5 item reale di §17.4', () => {
    const p173 = fromHex('04 02 12 0a 10 02 0010 0001 84 000000 12 0a 10 02 0010 0000 83 000000');
    const items = decodeReadRequest(p173);
    expect(items).toEqual([
      { area: 'DB', db: 1, start: 0, size: 'BYTE', count: 16 },
      { area: 'M', db: 0, start: 0, size: 'BYTE', count: 16 },
    ]);
    expect(hex(encodeReadRequest(items))).toBe(hex(p173));

    const p174 = fromHex(
      '04 05 12 0a 10 02 0006 0000 81 000000 12 0a 10 02 0006 0000 83 000000 12 0a 10 02 0006 0000 83 000030 ' +
        '12 0a 10 02 0036 0000 83 000020 12 0a 10 02 0004 0000 83 000020',
    );
    const it4 = decodeReadRequest(p174);
    expect(it4.map((i) => [i.area, i.start, i.count])).toEqual([
      ['I', 0, 6],
      ['M', 0, 6],
      ['M', 6, 6],
      ['M', 4, 54],
      ['M', 4, 4],
    ]);
    expect(hex(encodeReadRequest(it4))).toBe(hex(p174));

    // risposta reale: lunghezze in bit 0x30, 0x1B0, 0x20
    const bodies = [rnd(6, 1), rnd(6, 2), rnd(6, 3), rnd(54, 4), rnd(4, 5)];
    const dataHex =
      'ff04 0030 ' +
      hex(bodies[0]!) +
      'ff04 0030 ' +
      hex(bodies[1]!) +
      'ff04 0030 ' +
      hex(bodies[2]!) +
      'ff04 01b0 ' +
      hex(bodies[3]!) +
      'ff04 0020 ' +
      hex(bodies[4]!);
    const res = decodeReadResponse(fromHex('04 05'), fromHex(dataHex));
    expect(res.length).toBe(5);
    res.forEach((r, i) => {
      expect(r.ok).toBe(true);
      if (r.ok) expect(hex(r.data)).toBe(hex(bodies[i]!));
    });
    const enc = encodeReadResponse(res);
    expect(hex(enc.param)).toBe('0405');
    expect(hex(enc.data)).toBe(dataHex.replace(/\s+/g, ''));
  });

  it('risposta reale a 1 item da 64 byte: ff 04 0200', () => {
    const body = rnd(64, 9);
    const [r] = decodeReadResponse(fromHex('04 01'), fromHex('ff 04 0200 ' + hex(body)));
    expect(r!.ok && r!.data.length).toBe(64);
  });

  it("padding: un item da 3 byte seguito da un altro ha 1 byte di riempimento; l'ultimo no", () => {
    const results: ItemResult[] = [
      { ok: true, data: Uint8Array.of(1, 2, 3) },
      { ok: true, data: Uint8Array.of(4, 5, 6) },
    ];
    const { data } = encodeReadResponse(results);
    // 4+3 +1 pad + 4+3 senza pad
    expect(data.length).toBe(15);
    expect(hex(data)).toBe('ff040018010203' + '00' + 'ff040018040506');
    const back = decodeReadResponse(Uint8Array.of(4, 2), data);
    expect(back.map((r) => (r.ok ? hex(r.data) : 'err'))).toEqual(['010203', '040506']);
  });

  it('item con return code 0x0A da { ok: false, returnCode: 10 } e non interrompe gli altri', () => {
    const data = fromHex('0a 00 0000  ff 04 0010 aabb');
    const res = decodeReadResponse(fromHex('04 02'), data);
    expect(res[0]).toMatchObject({ ok: false, returnCode: 10 });
    expect(res[0]!.ok === false && res[0]!.name).toMatch(/non disponibile/);
    expect(res[1]).toEqual({ ok: true, data: Uint8Array.of(0xaa, 0xbb) });
    const enc = encodeReadResponse(res);
    expect(hex(enc.data)).toBe('0a000000ff040010aabb');
  });

  it('lunghezza in bit o in byte secondo il transport size dei dati', () => {
    // 0x09 (byte): timer 2 byte per elemento; 0x06/0x07 in byte; 0x03 bit: 1 bit -> 1 byte
    const r = decodeReadResponse(
      fromHex('04 04'),
      fromHex('ff 09 0004 11223344  ff 07 0004 01020304  ff 03 0001 01 00  ff 05 0010 abcd'),
    );
    expect(r.map((x) => (x.ok ? x.data.length : -1))).toEqual([4, 4, 1, 2]);
  });

  it('bit: indirizzo = start*8 + bit; timer e counter usano il numero direttamente', () => {
    const p = encodeReadRequest([
      { area: 'DB', db: 3, start: 10, bit: 5, size: 'BIT', count: 1 },
      { area: 'T', db: 0, start: 7, size: 'TIMER', count: 8 },
      { area: 'C', db: 0, start: 300, size: 'COUNTER', count: 2 },
    ]);
    expect(hex(p)).toBe(
      '0403' +
        '120a1001' +
        '0001' +
        '0003' +
        '84' +
        '000055' +
        '120a101d' +
        '0008' +
        '0000' +
        '1d' +
        '000007' +
        '120a101c' +
        '0002' +
        '0000' +
        '1c' +
        '00012c',
    );
    const back = decodeReadRequest(p);
    expect(back[0]).toEqual({ area: 'DB', db: 3, start: 10, bit: 5, size: 'BIT', count: 1 });
    expect(back[1]).toEqual({ area: 'T', db: 0, start: 7, size: 'TIMER', count: 8 });
    expect(back[2]).toEqual({ area: 'C', db: 0, start: 300, size: 'COUNTER', count: 2 });
  });

  it('i tipi non BIT/TIMER/COUNTER sono richiesti come BYTE con count in byte', () => {
    const p = encodeReadRequest([
      { area: 'M', db: 0, start: 4, size: 'DWORD', count: 2 },
      { area: 'DB', db: 1, start: 0, size: 'REAL', count: 3 },
      { area: 'DB', db: 1, start: 0, size: 'WORD', count: 1 },
    ]);
    const items = decodeReadRequest(p);
    expect(items.map((i) => [i.size, i.count])).toEqual([
      ['BYTE', 8],
      ['BYTE', 12],
      ['BYTE', 2],
    ]);
  });

  it('errori: PROTOCOL su funzione/area/transport size ignoti; RangeError su parametri non codificabili', () => {
    expect(() => decodeReadRequest(fromHex('05 01 12 0a 10 02 0001 0001 84 000000'))).toThrow(
      S7Error,
    );
    expect(() => decodeReadRequest(fromHex('04 01 12 0a 10 02 0001 0001 99 000000'))).toThrow(
      S7Error,
    );
    expect(() => decodeReadRequest(fromHex('04 01 12 0a 10 77 0001 0001 84 000000'))).toThrow(
      S7Error,
    );
    expect(() => decodeReadRequest(fromHex('04 02 12 0a 10 02 0001 0001 84 000000'))).toThrow(
      S7Error,
    );
    expect(() => decodeReadResponse(fromHex('04 01'), fromHex('ff 04 0200 aa'))).toThrow(S7Error);
    const ok: ReadItem = { area: 'DB', db: 1, start: 0, size: 'BYTE', count: 1 };
    expect(() => encodeReadRequest([])).toThrow(RangeError);
    expect(() => encodeReadRequest([{ ...ok, count: 0 }])).toThrow(RangeError);
    expect(() => encodeReadRequest([{ ...ok, db: 70000 }])).toThrow(RangeError);
    expect(() => encodeReadRequest([{ ...ok, start: 0x200000 }])).toThrow(RangeError);
    expect(() => encodeReadRequest([{ ...ok, size: 'TIMER' }])).toThrow(RangeError);
    expect(() => encodeReadRequest([{ ...ok, area: 'T', size: 'BYTE' }])).toThrow(RangeError);
  });
});
