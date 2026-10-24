import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decodeCotp,
  decodeS7,
  decodeWriteRequest,
  decodeWriteResponse,
  encodeWriteRequest,
  encodeWriteResponse,
  hex,
  planWrites,
  splitWrite,
  type WriteItem,
} from '../src';
import { CISAGOV_DIR, framesOf } from './captures';

const SNAP7 = join(CISAGOV_DIR, 'snap7.pcap').replaceAll('\\', '/');

/** Le PDU S7 con function 0x05 della cattura reale, nell'ordine in cui compaiono. */
function writePdus(rosctr: number): { param: Uint8Array; data: Uint8Array }[] {
  const out: { param: Uint8Array; data: Uint8Array }[] = [];
  for (const t of framesOf(SNAP7)) {
    let pdu;
    try {
      const cotp = decodeCotp(t);
      if (cotp.type !== 'DT' || !cotp.eot) continue;
      pdu = decodeS7(cotp.data);
    } catch {
      continue;
    }
    if (pdu.rosctr === rosctr && pdu.param[0] === 0x05) out.push(pdu);
  }
  return out;
}

describe('write var (0x05)', () => {
  it('write var di M reale di cisa/snap7.pcap: param e data coincidono byte per byte', () => {
    const reqs = writePdus(1);
    expect(reqs.length).toBeGreaterThanOrEqual(2);
    for (const r of reqs) {
      const items = decodeWriteRequest(r.param, r.data);
      const e = encodeWriteRequest(items);
      expect(hex(e.param)).toBe(hex(r.param));
      expect(hex(e.data)).toBe(hex(r.data));
    }
    // La prima: un REAL in MD16 = 0x42f6e979 (123.456).
    const first = decodeWriteRequest(reqs[0]!.param, reqs[0]!.data);
    expect(first).toEqual([
      {
        area: 'M',
        db: 0,
        start: 16,
        size: 'REAL',
        count: 1,
        data: Uint8Array.of(0x79, 0xe9, 0xf6, 0x42),
      },
    ]);
    // Anche le risposte reali si ricodificano identiche.
    for (const r of writePdus(3)) {
      const res = decodeWriteResponse(r.param, r.data);
      const e = encodeWriteResponse(res.map((x) => x.returnCode));
      expect(hex(e.param)).toBe(hex(r.param));
      expect(hex(e.data)).toBe(hex(r.data));
    }
  });

  it('encodeWriteRequest → decodeWriteRequest è identità su un item BYTE, un BIT e un DB WORD', () => {
    const items: WriteItem[] = [
      { area: 'M', db: 0, start: 10, size: 'BYTE', count: 1, data: Uint8Array.of(0x5a) },
      { area: 'Q', db: 0, start: 2, bit: 5, size: 'BIT', count: 1, data: Uint8Array.of(1) },
      { area: 'DB', db: 7, start: 100, size: 'WORD', count: 1, data: Uint8Array.of(0x12, 0x34) },
    ];
    const { param, data } = encodeWriteRequest(items);
    expect(param[0]).toBe(0x05);
    expect(param[1]).toBe(3);
    expect(decodeWriteRequest(param, data)).toEqual(items);
  });

  it("padding: un item da 3 byte seguito da un altro ha 1 byte di riempimento; l'ultimo no", () => {
    const a: WriteItem = {
      area: 'DB',
      db: 1,
      start: 0,
      size: 'BYTE',
      count: 3,
      data: Uint8Array.of(1, 2, 3),
    };
    const b: WriteItem = { ...a, start: 4, data: Uint8Array.of(4, 5, 6) };
    const { data } = encodeWriteRequest([a, b]);
    // 4 + 3 + 1 pad + 4 + 3 (nessun pad finale)
    expect(data.length).toBe(15);
    expect(hex(data)).toBe('00 04 00 18 01 02 03 00 00 04 00 18 04 05 06'.replaceAll(' ', ''));
    expect(decodeWriteRequest(encodeWriteRequest([a, b]).param, data)).toEqual([a, b]);
    expect(encodeWriteRequest([b]).data.length).toBe(7);
  });

  it('write response multi-item con un 0x0A in mezzo → gli altri 0xFF restano ok', () => {
    const { param, data } = encodeWriteResponse([0xff, 0x0a, 0xff]);
    expect(hex(param)).toBe('0503');
    expect(hex(data)).toBe('ff0aff');
    const res = decodeWriteResponse(param, data);
    expect(res.map((r) => r.returnCode)).toEqual([0xff, 0x0a, 0xff]);
    expect(res[0]!.name).toBe('successo');
    expect(res[1]!.name).toBe('oggetto non disponibile');
    expect(res[2]!.name).toBe('successo');
  });

  it('planWrites: 25 item piccoli → 2 richieste, ciascuna ≤ PDU in richiesta e risposta', () => {
    const pdu = 480;
    const items: WriteItem[] = Array.from({ length: 25 }, (_, i) => ({
      area: 'M',
      db: 0,
      start: i * 4,
      size: 'BYTE',
      count: 3,
      data: Uint8Array.of(i, i, i),
    }));
    const groups = planWrites(items, pdu);
    expect(groups.length).toBe(2);
    expect(groups.flat()).toEqual(items);
    for (const g of groups) {
      expect(g.length).toBeLessThanOrEqual(20);
      const e = encodeWriteRequest(g);
      expect(10 + e.param.length + e.data.length).toBeLessThanOrEqual(pdu);
      expect(12 + 2 + g.length).toBeLessThanOrEqual(pdu);
    }
    // Con la PDU 240 il limite è la richiesta (dati inclusi), non i 20 item.
    for (const g of planWrites(items, 240)) {
      const e = encodeWriteRequest(g);
      expect(10 + e.param.length + e.data.length).toBeLessThanOrEqual(240);
    }
  });

  it('planWrites: un item che da solo non entra lancia RangeError', () => {
    const big: WriteItem = {
      area: 'DB',
      db: 1,
      start: 0,
      size: 'BYTE',
      count: 300,
      data: new Uint8Array(300),
    };
    expect(() => planWrites([big], 240)).toThrow(RangeError);
  });

  it('splitWrite(DB,1,0, 1000 byte, 240) → fette ≤ 222 byte che coprono 0..999 senza buchi', () => {
    const data = Uint8Array.from({ length: 1000 }, (_, i) => i & 0xff);
    const slices = splitWrite('DB', 1, 0, data, 240);
    let next = 0;
    for (const s of slices) {
      expect(s.area).toBe('DB');
      expect(s.db).toBe(1);
      expect(s.size).toBe('BYTE');
      expect(s.count).toBe(s.data.length);
      expect(s.data.length).toBeLessThanOrEqual(222);
      expect(s.start).toBe(next);
      expect(hex(s.data)).toBe(hex(data.subarray(next, next + s.data.length)));
      next += s.data.length;
    }
    expect(next).toBe(1000);
    // Ogni fetta, da sola, entra nella PDU come richiesta (proto §5.11: max 212 byte con PDU 240).
    for (const s of slices) {
      const e = encodeWriteRequest([s]);
      expect(10 + e.param.length + e.data.length).toBeLessThanOrEqual(240);
    }
  });
});
