import { describe, expect, it } from 'vitest';
import { address, indirectMem, indirectReg } from '@baaportal/mc7';
import { parsePointer } from '@baaportal/mc7';
import {
  SimError,
  SimMemory,
  readBits,
  resolveOperand,
  writeBits,
  type FrameView,
  type Registers,
} from '../src';
import { wordToStw } from '../src';

// Semantica: manuale AWL S7-300/400, «Indirizzamento indiretto da memoria / da registro»
// e «Formato dei puntatori» (puntatore a 32 bit: area nei bit 24–26, byte nei bit 3–18, bit 0–2).
const mkMem = () => new SimMemory({ inputs: 16, outputs: 16, flags: 64, localBytes: 64 });
const mkRegs = (): Registers => ({
  stw: wordToStw(0),
  accu1: 0,
  accu2: 0,
  ar1: 0,
  ar2: 0,
  db: 0,
  di: 0,
});
const frame: FrameView = { lBase: 0, prevLBase: 0 };
const ptr = (text: string) =>
  new DataView(Uint8Array.from(parsePointer(text)!).buffer).getUint32(0);
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as SimError).code;
  }
  return undefined;
};

describe('risoluzione degli operandi', () => {
  it('MW10 big-endian', () => {
    const mem = mkMem();
    const loc = resolveOperand(address('M', 'W', 10), mkRegs(), mem, frame);
    writeBits(mem, loc, 'W', 0x1234);
    expect(mem.M[10]).toBe(0x12);
    expect(mem.M[11]).toBe(0x34);
    expect(readBits(mem, loc, 'W')).toBe(0x1234);
  });

  it('DBX3.1 con DB aperto 5', () => {
    const mem = mkMem();
    mem.dbs.set(5, { data: new Uint8Array(8), initial: new Uint8Array(8), retentive: false });
    const regs = mkRegs();
    regs.db = 5;
    const loc = resolveOperand(address('DB', 'X', 3, 1), regs, mem, frame);
    expect(loc).toEqual({ area: 'DB', db: 5, bit: 25 });
    writeBits(mem, loc, 'X', 1);
    expect(mem.dbs.get(5)!.data[3]).toBe(0b10);
    expect(readBits(mem, loc, 'X')).toBe(1);
  });

  it('DBX senza DB aperto → DB_NON_APERTO', () => {
    expect(code(() => resolveOperand(address('DB', 'X', 0, 0), mkRegs(), mkMem(), frame))).toBe(
      'DB_NON_APERTO',
    );
  });

  it('M [MD20] con MD20 = P#4.3 → M4.3', () => {
    const mem = mkMem();
    const regs = mkRegs();
    writeBits(mem, resolveOperand(address('M', 'D', 20), regs, mem, frame), 'D', ptr('P#4.3'));
    const loc = resolveOperand(indirectMem('M', 'X', address('M', 'D', 20)), regs, mem, frame);
    expect(loc).toEqual({ area: 'M', db: null, bit: 4 * 8 + 3 });
  });

  it('M [AR1,P#2.0] con AR1 = P#10.0 → M12.0', () => {
    const regs = mkRegs();
    regs.ar1 = ptr('P#10.0');
    const loc = resolveOperand(indirectReg('M', 'X', 1, 'P#2.0'), regs, mkMem(), frame);
    expect(loc).toEqual({ area: 'M', db: null, bit: 96 });
  });

  it('[AR1,P#0.0] trasversale con AR1 = P#DBX 4.0 → DB aperto, byte 4', () => {
    const mem = mkMem();
    mem.dbs.set(9, { data: new Uint8Array(8), initial: new Uint8Array(8), retentive: false });
    const regs = mkRegs();
    regs.db = 9;
    regs.ar1 = ptr('P#DBX 4.0');
    const loc = resolveOperand(indirectReg(null, 'B', 1, 'P#0.0'), regs, mem, frame);
    expect(loc).toEqual({ area: 'DB', db: 9, bit: 32 });
    regs.ar1 = ptr('P#M 7.0');
    expect(resolveOperand(indirectReg(null, 'B', 1, 'P#0.0'), regs, mem, frame).area).toBe('M');
  });

  it('PIW legge physIn, PQW scrive physOut, non I/Q', () => {
    const mem = mkMem();
    mem.physIn[2] = 0xab;
    mem.physIn[3] = 0xcd;
    const regs = mkRegs();
    expect(readBits(mem, resolveOperand(address('PI', 'W', 2), regs, mem, frame), 'W')).toBe(
      0xabcd,
    );
    writeBits(mem, resolveOperand(address('PQ', 'W', 4), regs, mem, frame), 'W', 0x1122);
    expect(mem.physOut[4]).toBe(0x11);
    expect(mem.physOut[5]).toBe(0x22);
    expect(mem.Q[4]).toBe(0);
    expect(mem.I[2]).toBe(0);
  });

  it('L usa la base del blocco, V la base del chiamante', () => {
    const mem = mkMem();
    const regs = mkRegs();
    const f: FrameView = { lBase: 16, prevLBase: 4 };
    writeBits(mem, resolveOperand(address('L', 'B', 2), regs, mem, f), 'B', 7);
    writeBits(
      mem,
      resolveOperand(address('L', 'B', 1), regs, mem, { lBase: 4, prevLBase: 0 }),
      'B',
      9,
    );
    expect(mem.L[18]).toBe(7);
    const v = resolveOperand(
      indirectReg(null, 'B', 1, 'P#0.0'),
      { ...regs, ar1: ptr('P#V 1.0') },
      mem,
      f,
    );
    expect(v.area).toBe('V');
    expect(readBits(mem, v, 'B')).toBe(9);
  });

  it('accesso oltre la fine dell area dopo la risoluzione → AREA_LUNGHEZZA', () => {
    const mem = mkMem();
    const regs = mkRegs();
    regs.ar1 = ptr('P#100.0');
    const loc = resolveOperand(indirectReg('M', 'B', 1, 'P#0.0'), regs, mem, frame);
    expect(code(() => readBits(mem, loc, 'B'))).toBe('AREA_LUNGHEZZA');
  });
});
