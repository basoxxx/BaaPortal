import { describe, expect, it } from 'vitest';
import {
  S7Error,
  decodeReadRequest,
  decodeReadResponse,
  encodeReadRequest,
  encodeReadResponse,
  fromHex,
  hex,
  decodeS7,
  encodeS7,
  itemByteLength,
  responseTransportFor,
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
      { ok: true, data: Uint8Array.of(1, 2, 3), transportSize: 4 },
      { ok: true, data: Uint8Array.of(4, 5, 6), transportSize: 4 },
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
    expect(res[1]).toEqual({
      ok: true,
      data: Uint8Array.of(0xaa, 0xbb),
      transportSize: 4,
      rawLength: 16,
    });
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

  it('i tipi mantengono transport size e count in elementi, come inviati', () => {
    const items: ReadItem[] = [
      { area: 'M', db: 0, start: 4, size: 'DWORD', count: 2 },
      { area: 'DB', db: 1, start: 0, size: 'REAL', count: 3 },
      { area: 'DB', db: 1, start: 0, size: 'WORD', count: 1 },
      { area: 'DB', db: 1, start: 2, size: 'INT', count: 1 },
    ];
    const p = encodeReadRequest(items);
    expect(hex(p).slice(4, 12)).toBe('120a1006');
    expect(decodeReadRequest(p)).toEqual(items);
    expect(items.map(itemByteLength)).toEqual([8, 12, 2, 2]);
    expect(itemByteLength({ area: 'T', db: 0, start: 0, size: 'TIMER', count: 8 })).toBe(16);
    expect(itemByteLength({ area: 'DB', db: 1, start: 0, size: 'BIT', count: 1 })).toBe(1);
  });

  it('responseTransportFor: timer/counter 0x09, BIT 0x03, REAL 0x07, INT 0x05, il resto 0x04', () => {
    const f = (area: ReadItem['area'], size: ReadItem['size']): number =>
      responseTransportFor({ area, db: 0, start: 0, size, count: 1 });
    expect(f('T', 'TIMER')).toBe(0x09);
    expect(f('C', 'COUNTER')).toBe(0x09);
    expect(f('DB', 'BIT')).toBe(0x03);
    expect(f('DB', 'REAL')).toBe(0x07);
    expect(f('DB', 'INT')).toBe(0x05);
    for (const z of ['BYTE', 'CHAR', 'WORD', 'DWORD', 'DINT'] as const)
      expect(f('M', z)).toBe(0x04);
  });

  it('item con errore: TS e lunghezza grezzi restano, il round trip e identico', () => {
    const d = fromHex('0a 00 0004  ff 04 0010 aabb  05 03 0007');
    const r = decodeReadResponse(fromHex('04 03'), d);
    expect(r[0]).toMatchObject({ ok: false, returnCode: 0x0a, transportSize: 0, rawLength: 4 });
    expect(r[2]).toMatchObject({ ok: false, returnCode: 5, transportSize: 3, rawLength: 7 });
    expect(hex(encodeReadResponse(r).data)).toBe(hex(d));
  });

  describe('vettori reali (cisagov/icsnpp-s7comm, BSD-3, snap7.pcap e s7ident.pcap)', () => {
    const rt = (reqHex: string, resHex: string): { items: ReadItem[]; res: ItemResult[] } => {
      const req = decodeS7(fromHex(reqHex));
      const rs = decodeS7(fromHex(resHex));
      const items = decodeReadRequest(req.param);
      expect(hex(encodeS7({ ...req, param: encodeReadRequest(items) }))).toBe(reqHex);
      const res = decodeReadResponse(rs.param, rs.data);
      const enc = encodeReadResponse(res);
      expect(hex(encodeS7({ ...rs, param: enc.param, data: enc.data }))).toBe(resHex);
      return { items, res };
    };

    it('lettura REAL: TS richiesta 0x08, risposta 0x07 con lunghezza in byte', () => {
      const { items, res } = rt(
        '320100001900000e00000401120a10080001000083000080',
        '3203000019000002000800000401ff07000400000000',
      );
      expect(items).toEqual([{ area: 'M', db: 0, start: 16, size: 'REAL', count: 1 }]);
      expect(res[0]).toMatchObject({ ok: true, transportSize: 7, rawLength: 4 });
      expect(responseTransportFor(items[0]!)).toBe(7);
      expect(res[0]!.ok && res[0]!.data.length).toBe(itemByteLength(items[0]!));
    });

    it('lettura multi-item con timer e counter: TS 0x09, 8 elementi = 16 byte', () => {
      const { items, res } = rt(
        '320100001b00003e00000405' +
          '120a10020010000083000000120a10020010000081000000120a10020010000082000000' +
          '120a101d000800001d000000120a101c000800001c000000',
        '320300001b000002006400000405' +
          'ff040080acde000daddeaddeaddeaddeaddeaddeff040080aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb' +
          'ff040080bbbbbbbbbbbbbbbbaddeaddeaddeaddeff09001000000000000000000000000000000000' +
          'ff09001000110000000000000000000000000000',
      );
      expect(items.map((i) => [i.area, i.size, i.count])).toEqual([
        ['M', 'BYTE', 16],
        ['I', 'BYTE', 16],
        ['Q', 'BYTE', 16],
        ['T', 'TIMER', 8],
        ['C', 'COUNTER', 8],
      ]);
      expect(res.map((r) => (r.ok ? r.transportSize : -1))).toEqual([4, 4, 4, 9, 9]);
      res.forEach((r, i) => {
        expect(r.ok && r.data.length).toBe(itemByteLength(items[i]!));
        expect(r.ok && r.transportSize).toBe(responseTransportFor(items[i]!));
      });
    });

    it('item con errore reale 0a 00 00 04 (x5)', () => {
      const hexRes = '320300000a0000020014000004050a0000040a0000040a0000040a0000040a000004';
      const rs = decodeS7(fromHex(hexRes));
      const res = decodeReadResponse(rs.param, rs.data);
      expect(res.length).toBe(5);
      expect(res[0]).toMatchObject({ ok: false, returnCode: 10, transportSize: 0, rawLength: 4 });
      const enc = encodeReadResponse(res);
      expect(hex(encodeS7({ ...rs, param: enc.param, data: enc.data }))).toBe(hexRes);
    });
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
  });
});
