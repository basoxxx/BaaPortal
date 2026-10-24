import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decodeCotp,
  decodeDownloadBlockAck,
  decodeDownloadBlockJob,
  decodeDownloadEnded,
  decodeRequestDownload,
  decodeS7,
  encodeDownloadBlockAck,
  encodeDownloadBlockJob,
  encodeDownloadEnded,
  encodeRequestDownload,
  fromHex,
  hex,
  readPcap,
  sliceBlockForDownload,
} from '../src';
import { CACHE_DIR } from './captures';

const NAME_DB1_P = '09 5f 3041 3030303031 50';

describe('codec download 0x1A/0x1B/0x1C (proto §10, §17.9)', () => {
  it('request download DB1 di proto §17.9: byte identici (load mem 100086, MC7 2)', () => {
    const want = fromHex(
      `1a 00 01 00 00 00 00 00 ${NAME_DB1_P} 0d 31 ${hexAscii('100086')} ${hexAscii('000002')}`,
    );
    const got = encodeRequestDownload('DB', 1, 'P', 100086, 2);
    expect(hex(got)).toBe(hex(want));
    expect(decodeRequestDownload(want)).toEqual({
      type: 'DB',
      number: 1,
      fs: 'P',
      loadLength: 100086,
      mc7Length: 2,
    });
  });

  it('encode/decodeRequestDownload roundtrip su OB1 e FB1', () => {
    for (const [type, number, load, mc7] of [
      ['OB', 1, 1234, 700],
      ['FB', 1, 999999, 0],
    ] as const) {
      const p = encodeRequestDownload(type, number, 'P', load, mc7);
      expect(decodeRequestDownload(p)).toEqual({
        type,
        number,
        fs: 'P',
        loadLength: load,
        mc7Length: mc7,
      });
    }
    expect(() => encodeRequestDownload('DB', 1, 'P', 1_000_000, 0)).toThrow(RangeError);
    expect(() => decodeRequestDownload(fromHex('1a 00'))).toThrow();
  });

  it('la sequenza 0x1B di §17.9 (3 cicli, ultimo EoS 0) si decodifica e si ricodifica identica', () => {
    const job = fromHex(`1b 00 00 00 00 00 00 00 ${NAME_DB1_P}`);
    expect(decodeDownloadBlockJob(job)).toEqual({ type: 'DB', number: 1, fs: 'P' });
    expect(hex(encodeDownloadBlockJob('DB', 1, 'P'))).toBe(hex(job));
    // dimensioni reali della cattura: 222 + 222 + 56 byte, EoS 01 01 00
    const cycles = [
      { eos: true, chunk: Uint8Array.from({ length: 222 }, (_, i) => i) },
      { eos: true, chunk: Uint8Array.from({ length: 222 }, (_, i) => 255 - i) },
      { eos: false, chunk: Uint8Array.from({ length: 56 }, (_, i) => i * 3) },
    ];
    for (const c of cycles) {
      const { param, data } = encodeDownloadBlockAck(c.eos, c.chunk);
      expect(hex(param)).toBe(c.eos ? '1b01' : '1b00');
      expect(hex(data.subarray(0, 4))).toBe(`${c.chunk.length.toString(16).padStart(4, '0')}00fb`);
      const back = decodeDownloadBlockAck(param, data);
      expect(back.eos).toBe(c.eos);
      expect(hex(back.chunk)).toBe(hex(c.chunk));
      const again = encodeDownloadBlockAck(back.eos, back.chunk);
      expect(hex(again.param)).toBe(hex(param));
      expect(hex(again.data)).toBe(hex(data));
    }
    expect(() => decodeDownloadBlockAck(fromHex('1b 02'), fromHex('0000 00fb'))).toThrow();
    expect(() => decodeDownloadBlockAck(fromHex('1b 00'), fromHex('0005 00fb 01'))).toThrow();
  });

  it("sliceBlockForDownload di un blocco da 500 byte con PDU 240 → fette che ricompongono l'originale, ultima EoS 0", () => {
    const file = Uint8Array.from({ length: 500 }, (_, i) => i & 0xff);
    const slices = sliceBlockForDownload(file, 240);
    expect(slices.map((s) => s.length)).toEqual([222, 222, 56]);
    // ogni fetta, incapsulata in un'ack-data, sta nella PDU: 12 + 2 + 4 + fetta <= 240
    const acks = slices.map((s, i) => encodeDownloadBlockAck(i < slices.length - 1, s));
    for (const a of acks) expect(12 + a.param.length + a.data.length).toBeLessThanOrEqual(240);
    expect(acks.map((a) => a.param[1])).toEqual([1, 1, 0]);
    const joined = new Uint8Array(500);
    let o = 0;
    for (const a of acks) {
      const { chunk } = decodeDownloadBlockAck(a.param, a.data);
      joined.set(chunk, o);
      o += chunk.length;
    }
    expect(o).toBe(500);
    expect(hex(joined)).toBe(hex(file));
    // blocco che entra in una fetta sola, e blocco vuoto
    expect(sliceBlockForDownload(new Uint8Array(222), 240)).toHaveLength(1);
    expect(sliceBlockForDownload(new Uint8Array(0), 240)).toHaveLength(1);
    expect(() => sliceBlockForDownload(file, 18)).toThrow(RangeError);
  });

  it('download ended 0x1C roundtrip', () => {
    const want = fromHex(`1c 00 00 00 00 00 00 00 ${NAME_DB1_P}`);
    expect(hex(encodeDownloadEnded('DB', 1, 'P'))).toBe(hex(want));
    expect(decodeDownloadEnded(want)).toEqual({ type: 'DB', number: 1, fs: 'P' });
    expect(() => decodeDownloadEnded(fromHex(`1b 00 00 00 00 00 00 00 ${NAME_DB1_P}`))).toThrow();
  });
});

function hexAscii(s: string): string {
  return [...s].map((c) => c.charCodeAt(0).toString(16)).join(' ');
}

// Cattura pubblica scaricata a richiesta (scripts/fetch-s7-captures.mjs): se manca si salta, col nome.
const CAPTURE = 's7comm_downloading_block_db1.pcap';
const capturePath = join(CACHE_DIR, CAPTURE);

describe(`cattura reale ${CAPTURE}`, () => {
  it.skipIf(!existsSync(capturePath))(
    'ogni frame 0x1A/0x1B/0x1C si decodifica e si ricodifica identico',
    () => {
      let request = 0;
      let jobs = 0;
      let acks = 0;
      let ended = 0;
      const eos: number[] = [];
      for (const st of readPcap(readFileSync(capturePath))) {
        for (const fr of st.frames) {
          let pdu;
          try {
            const c = decodeCotp(fr.bytes);
            if (c.type !== 'DT' || !c.eot) continue;
            pdu = decodeS7(c.data);
          } catch {
            continue;
          }
          const fn = pdu.param[0];
          if (pdu.rosctr === 1 && fn === 0x1a) {
            const r = decodeRequestDownload(pdu.param);
            expect(
              hex(encodeRequestDownload(r.type, r.number, r.fs, r.loadLength, r.mc7Length)),
            ).toBe(hex(pdu.param));
            expect([r.type, r.number, r.fs, r.loadLength, r.mc7Length]).toEqual([
              'DB',
              1,
              'P',
              500,
              400,
            ]);
            request++;
          } else if (pdu.rosctr === 1 && fn === 0x1b) {
            const j = decodeDownloadBlockJob(pdu.param);
            expect(hex(encodeDownloadBlockJob(j.type, j.number, j.fs))).toBe(hex(pdu.param));
            jobs++;
          } else if (pdu.rosctr === 3 && fn === 0x1b) {
            const a = decodeDownloadBlockAck(pdu.param, pdu.data);
            const e = encodeDownloadBlockAck(a.eos, a.chunk);
            expect(hex(e.param)).toBe(hex(pdu.param));
            expect(hex(e.data)).toBe(hex(pdu.data));
            eos.push(a.eos ? 1 : 0);
            acks++;
          } else if (pdu.rosctr === 1 && fn === 0x1c) {
            const j = decodeDownloadEnded(pdu.param);
            expect(hex(encodeDownloadEnded(j.type, j.number, j.fs))).toBe(hex(pdu.param));
            ended++;
          }
        }
      }
      expect([request, jobs, acks, ended]).toEqual([1, 3, 3, 1]);
      expect(eos).toEqual([1, 1, 0]);
    },
  );
});
