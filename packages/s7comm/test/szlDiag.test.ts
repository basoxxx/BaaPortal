import { describe, expect, it } from 'vitest';
import {
  S7Error,
  cycleConfigFrom,
  cycleTimeFrom,
  diagRecordsFrom,
  fromHex,
  isUnavailable,
  lastModeChangeFrom,
  ledsFrom,
  memoryFrom,
  modeTransition,
  type SzlList,
} from '../src';

function list(id: number, index: number, recs: string[]): SzlList {
  const records = recs.map((r) => fromHex(r));
  return { id, index, recordLength: records[0]!.length, records };
}

describe('SZL di diagnostica (proto §7.5, §7.6)', () => {
  it('0x0222/1 di §7.5.2: ultimo 0, minimo 0, massimo 3 ms, avvio 2016-02-08 23:17:58.211', () => {
    const l = list(0x0222, 1, [
      '11030101c858' +
        '00000000' +
        '0003' +
        '1602082317582112' +
        '001000080000 0000'.replace(/ /g, ''),
    ]);
    expect(cycleTimeFrom(l)).toEqual({
      lastMs: 0,
      minMs: 0,
      maxMs: 3,
      lastStart: {
        year: 2016,
        month: 2,
        day: 8,
        hour: 23,
        minute: 17,
        second: 58,
        ms: 211,
        weekday: 2,
      },
    });
  });

  it('0x0222/0x50 di §7.5.2: massimo configurato 150 ms', () => {
    const l = list(0x0222, 0x50, [
      '35011a50c858' +
        '0000' +
        '0000' +
        '0096' +
        '0000000000000000' +
        '000000080000 0000'.replace(/ /g, ''),
    ]);
    expect(cycleConfigFrom(l)).toEqual({ minMs: 0, maxMs: 150 });
  });

  it('0x0222 con indice diverso da quello chiesto: PROTOCOL', () => {
    const rec = '11030101c858' + '00000000' + '0003' + '1602082317582112' + '0010000800000000';
    expect(() => cycleTimeFrom(list(0x0222, 2, [rec]))).toThrow(S7Error);
    expect(() => cycleConfigFrom(list(0x0222, 1, [rec]))).toThrow(/indice/);
    expect(() => cycleTimeFrom(list(0x0232, 1, [rec]))).toThrow(S7Error);
  });

  const rec13 = (i: number, code: number, size: number, b1: number, b2: number): string => {
    const u32 = (n: number): string => n.toString(16).padStart(8, '0');
    const u16 = (n: number): string => n.toString(16).padStart(4, '0');
    return (
      u16(i) +
      u16(code) +
      u32(size) +
      '0011' +
      '0000' +
      u32(size) +
      u32(b1) +
      u32(0) +
      u32(0) +
      u32(b2) +
      u32(0)
    );
  };

  it('0x0013 con i 5 record di §7.5.3', () => {
    const l = list(0x0013, 0, [
      rec13(1, 1, 196608, 352, 0),
      rec13(2, 1, 0, 0, 0),
      rec13(3, 2, 131072, 0, 4906),
      rec13(4, 2, 8388608, 0, 0),
      rec13(5, 2, 1280, 0, 32),
    ]);
    const m = memoryFrom(l);
    expect(m.map((a) => a.kind)).toEqual([
      'work',
      'loadIntegrated',
      'loadMmc',
      'loadMax',
      'backup',
    ]);
    expect(m[0]).toMatchObject({ size: 196608, used: 352, free: 196256 });
    expect(m[2]).toMatchObject({ size: 131072, used: 4906, free: 126166 });
    expect(m[4]).toMatchObject({ size: 1280, used: 32, free: 1248 });
    expect(m[1]).toMatchObject({ size: 0, used: 0, free: 0 });
  });

  it('0x0013: usato oltre il totale dà libero 0; un record corto è saltato', () => {
    const l: SzlList = {
      id: 0x0013,
      index: 0,
      recordLength: 36,
      records: [fromHex(rec13(1, 1, 100, 150, 0)), fromHex('0001')],
    };
    const m = memoryFrom(l);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ used: 150, free: 0 });
    const short: SzlList = {
      id: 0x0013,
      index: 0,
      recordLength: 36,
      records: [fromHex('0001'), fromHex(rec13(5, 2, 1280, 0, 32))],
    };
    expect(memoryFrom(short).map((a) => a.index)).toEqual([5]);
  });

  it('0x0019 di §7.5.4: 7 LED, RUN acceso fisso, gli altri spenti', () => {
    const l = list(0x0019, 0, [
      '00010000',
      '00040100',
      '00050000',
      '00060000',
      '000b0000',
      '000c0000',
      '00150000',
    ]);
    const leds = ledsFrom(l);
    expect(leds.map((x) => x.name)).toEqual([
      'SF',
      'RUN',
      'STOP',
      'FRCE',
      'BUS1F',
      'BUS2F',
      'MAINT',
    ]);
    expect(leds.filter((x) => x.on).map((x) => x.name)).toEqual(['RUN']);
    expect(leds[1]).toMatchObject({ on: true, blink: 'none' });
  });

  it('0x0174/6 di §7.5.4: FRCE spento; lampeggi', () => {
    expect(ledsFrom(list(0x0174, 6, ['00060000']))).toEqual([
      { id: 6, name: 'FRCE', on: false, blink: 'none' },
    ]);
    const b = ledsFrom(list(0x0074, 0, ['00010101', '00010102', '00010107']));
    expect(b.map((x) => x.blink)).toEqual(['normal', 'slow', 'unknown']);
    expect(() => ledsFrom(list(0x0011, 0, ['00010000']))).toThrow(S7Error);
  });

  const R4302 = '4302ff68c7' + '00' + '0000' + '08147714' + '1602082308102642';

  it('0x0124 di §7.5.5: 0x4302, da avviamento (6) a RUN (8), 2016-02-08 23:08:10.264', () => {
    const r = lastModeChangeFrom(list(0x0124, 0, [R4302]))!;
    expect(r.eventId).toBe(0x4302);
    expect(modeTransition(r.obNumber)).toEqual({ from: 'startup', to: 'run' });
    expect(r.time).toMatchObject({
      year: 2016,
      month: 2,
      day: 8,
      hour: 23,
      minute: 8,
      second: 10,
      ms: 264,
    });
    expect(
      lastModeChangeFrom({ id: 0x0124, index: 0, recordLength: 20, records: [] }),
    ).toBeUndefined();
  });

  it('modeTransition: tutti i codici di §7.3, 0x6 compreso', () => {
    expect(modeTransition(0x84)).toEqual({ from: 'run', to: 'stopInternal' });
    expect(modeTransition(0x46)).toEqual({ from: 'stopInternal', to: 'startup' });
    expect(modeTransition(0x15)).toEqual({ from: 'stopUpdate', to: 'warmStart' });
    expect(modeTransition(0x27)).toEqual({ from: 'stopReset', to: 'restart' });
    expect(modeTransition(0x3a)).toEqual({ from: 'stopSelfInit', to: 'hold' });
    expect(modeTransition(0xd0)).toEqual({ from: 'defect', to: 'unknown' });
    expect(modeTransition(0x9e)).toEqual({ from: 'unknown', to: 'unknown' });
  });

  const DIAG = [
    R4302,
    '13811b64c7724304081477141602082308102632',
    '4301ff46c7724304081477141602082308101662',
    '4304ff84' + '0000' + '0000' + '00000000' + '1602082308100312',
  ];

  it('0x00A0 con le 4 voci di §7.6.1: ordine conservato, 0x1381 con priorità 0x1B, OB 0x64, info1 0x4304', () => {
    const recs = diagRecordsFrom(list(0x00a0, 0, DIAG));
    expect(recs.map((r) => r.eventId)).toEqual([0x4302, 0x1381, 0x4301, 0x4304]);
    expect(recs[1]).toMatchObject({ priority: 0x1b, obNumber: 0x64, info1: 0x4304 });
    expect(recs[0]!.time).toBeDefined();
    expect(diagRecordsFrom(list(0x01a0, 4, DIAG))).toHaveLength(4);
    expect(() => diagRecordsFrom(list(0x0124, 0, DIAG))).toThrow(S7Error);
  });

  it("voce con ora non valida: c'è, con rawTime; un record corto è saltato", () => {
    const bad = '4302ff68c70000000814771416ff082308102642';
    const l: SzlList = {
      id: 0x00a0,
      index: 0,
      recordLength: 20,
      records: [fromHex(bad), fromHex('4302'), fromHex(DIAG[2]!)],
    };
    const recs = diagRecordsFrom(l);
    expect(recs).toHaveLength(2);
    expect(recs[0]!.time).toBeUndefined();
    expect(recs[0]!.rawTime).toEqual(fromHex('16ff082308102642'));
    expect(recs[1]!.eventId).toBe(0x4301);
  });

  it('isUnavailable: D402 e D409 sì; D241, TIMEOUT e CLOSED no', () => {
    const cpu = (c: number, n: number): S7Error =>
      new S7Error('CPU_ERROR', 'x', { errorClass: c, errorCode: n });
    expect(isUnavailable(cpu(0xd4, 0x02))).toBe(true);
    expect(isUnavailable(cpu(0xd4, 0x09))).toBe(true);
    expect(isUnavailable(cpu(0xd4, 0x01))).toBe(true);
    expect(isUnavailable(cpu(0xd4, 0x00))).toBe(false);
    expect(isUnavailable(cpu(0xd4, 0x0a))).toBe(false);
    expect(isUnavailable(cpu(0xd2, 0x41))).toBe(false);
    expect(isUnavailable(new S7Error('TIMEOUT', 'x'))).toBe(false);
    expect(isUnavailable(new S7Error('CLOSED', 'x'))).toBe(false);
    expect(isUnavailable(new Error('x'))).toBe(false);
  });
});
