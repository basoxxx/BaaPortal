import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decodeControlResponse,
  decodeCotp,
  decodePlcControlRequest,
  decodeS7,
  encodeControlResponse,
  encodeInsertBlock,
  encodePlcStop,
  encodeWarmRestart,
  fromHex,
  hex,
} from '../src';
import { CISAGOV_DIR, framesOf } from './captures';

const SNAP7 = join(CISAGOV_DIR, 'snap7.pcap').replaceAll('\\', '/');

/** Param delle PDU 0x28/0x29 della cattura reale (rosctr 1 = richieste, 3 = risposte). */
function controlParams(rosctr: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const t of framesOf(SNAP7)) {
    let pdu;
    try {
      const cotp = decodeCotp(t);
      if (cotp.type !== 'DT' || !cotp.eot) continue;
      pdu = decodeS7(cotp.data);
    } catch {
      continue;
    }
    if (pdu.rosctr === rosctr && (pdu.param[0] === 0x28 || pdu.param[0] === 0x29)) {
      out.push(pdu.param);
    }
  }
  return out;
}

const STOP = '29000000000009505f50524f4752414d';
const WARM = '28000000000000fd000009505f50524f4752414d';
const COLD = '28000000000000fd0002432009505f50524f4752414d';
const MODU = '28000000000000fd00024550055f4d4f4455';
const GARB = '28000000000000fd0000055f47415242';
const INSE_DB1 = '28000000000000fd000a01003041303030303150055f494e5345';

describe('PLC control (0x28) e stop (0x29)', () => {
  it('PLC stop di proto §17.10 (snap7_s300_stop): param 0x29 + "P_PROGRAM"', () => {
    expect(hex(encodePlcStop())).toBe(STOP);
    // stessa richiesta nella cattura reale di cisa/snap7.pcap
    const real = controlParams(1).filter((p) => p[0] === 0x29);
    expect(real.length).toBeGreaterThanOrEqual(1);
    for (const p of real) expect(hex(encodePlcStop())).toBe(hex(p));
    expect(decodePlcControlRequest(encodePlcStop())).toEqual({
      function: 0x29,
      service: 'P_PROGRAM',
    });
  });

  it('warm restart P_PROGRAM: param 0x28 senza argomenti, roundtrip', () => {
    expect(hex(encodeWarmRestart())).toBe(WARM);
    expect(decodePlcControlRequest(encodeWarmRestart())).toEqual({
      function: 0x28,
      service: 'P_PROGRAM',
    });
  });

  it('_INSE per DB1 di proto §10.4 / §17.9: byte identici alla cattura', () => {
    const p = encodeInsertBlock('DB', 1, 'P');
    expect(hex(p)).toBe(INSE_DB1);
    expect(decodePlcControlRequest(p)).toEqual({
      function: 0x28,
      service: '_INSE',
      block: { type: 'DB', number: 1 },
    });
    const fc = decodePlcControlRequest(encodeInsertBlock('FC', 12345, 'P'));
    expect(fc.block).toEqual({ type: 'FC', number: 12345 });
  });

  it('_INSE: numero e filesystem fuori dominio sono rifiutati', () => {
    expect(() => encodeInsertBlock('DB', 100000, 'P')).toThrow(RangeError);
    expect(() => encodeInsertBlock('DB', -1, 'P')).toThrow(RangeError);
  });

  it('decodeControlResponse: para 0x00→ok, 0x07→già STOP, 0x03→già RUN, 0x02→non eseguibile', () => {
    expect(decodeControlResponse(fromHex('29'))).toEqual({ code: 0x00, name: 'ok' });
    for (const p of controlParams(3)) expect(decodeControlResponse(p).code).toBe(0);
    expect(decodeControlResponse(fromHex('2900'))).toEqual({ code: 0x00, name: 'ok' });
    expect(decodeControlResponse(fromHex('2907'))).toEqual({ code: 0x07, name: 'già STOP' });
    expect(decodeControlResponse(fromHex('2803'))).toEqual({ code: 0x03, name: 'già RUN' });
    expect(decodeControlResponse(fromHex('2802'))).toEqual({ code: 0x02, name: 'non eseguibile' });
    expect(decodeControlResponse(fromHex('2899')).name).toMatch(/sconosciuto/);
    expect(() => decodeControlResponse(fromHex('2a'))).toThrow();
  });

  it('encodeControlResponse: roundtrip e coincide con le risposte reali', () => {
    expect(hex(encodeControlResponse(0x29, 0))).toBe('29');
    expect(hex(encodeControlResponse(0x28, 0))).toBe('28');
    for (const p of controlParams(3)) expect(hex(encodeControlResponse(p[0] as 0x28, 0))).toBe(hex(p));
    expect(decodeControlResponse(encodeControlResponse(0x29, 0x07)).code).toBe(0x07);
    expect(decodeControlResponse(encodeControlResponse(0x28, 0x03)).code).toBe(0x03);
  });

  it('decodePlcControlRequest rifiuta _MODU/_GARB/cold come "non ammesso"', () => {
    for (const h of [COLD, MODU, GARB]) {
      const r = decodePlcControlRequest(fromHex(h));
      expect(r.function).toBe(0x28);
      expect(r.service).toBeUndefined();
      expect(r.block).toBeUndefined();
    }
    // le richieste reali della cattura: le ammesse sono riconosciute, le altre no
    const real = controlParams(1).map((p) => decodePlcControlRequest(p));
    expect(real.map((r) => r.service)).toEqual(['P_PROGRAM', undefined, undefined, undefined]);
    // _INSE con conteggio/lunghezza diversi, _DELE: non ammessi
    const dele = fromHex('28000000000000fd000a01003041303030303142055f44454c45');
    expect(decodePlcControlRequest(dele).service).toBeUndefined();
  });

  it('decodePlcControlRequest: funzione sconosciuta o param troncato è PROTOCOL', () => {
    expect(() => decodePlcControlRequest(fromHex('04'))).toThrow();
    expect(() => decodePlcControlRequest(new Uint8Array(0))).toThrow();
    expect(() => decodePlcControlRequest(fromHex('2800000000'))).toThrow();
    expect(() => decodePlcControlRequest(fromHex('29000000000009505f50'))).toThrow();
  });
});
