import { parseConstant } from '@baaportal/mc7';
import { SimError } from '../errors';
import type { ExecState, OpHandler } from '../executor';

/** CC dal segno di un valore (manuale AWL, «Operazioni con numeri interi»): 0 → 00, <0 → 01, >0 → 10. */
export function setSignCc(st: ExecState, v: bigint | number): void {
  const s = st.regs.stw;
  s.cc0 = v < 0;
  s.cc1 = v > 0;
}

/** Overflow: OV = 1 e OS = 1 (OS è memorizzato e non si azzera qui). */
export function setOverflow(st: ExecState, ov: boolean): void {
  st.regs.stw.ov = ov;
  if (ov) st.regs.stw.os = true;
}

/** Divisione per zero: CC1 = CC0 = 1, OV = OS = 1. */
function divByZero(st: ExecState): void {
  const s = st.regs.stw;
  s.cc0 = s.cc1 = true;
  setOverflow(st, true);
}

const i16 = (v: number): bigint => BigInt.asIntN(16, BigInt(v));
const i32 = (v: number): bigint => BigInt.asIntN(32, BigInt(v));

type Fn = (a: bigint, b: bigint) => bigint;

/** Forma a 16 bit: parole basse, ACCU1-H invariata. */
function op16(fn: Fn): OpHandler {
  return (st) => {
    const r = fn(i16(st.regs.accu2), i16(st.regs.accu1));
    const w = BigInt.asIntN(16, r);
    st.regs.accu1 = ((st.regs.accu1 & 0xffff0000) | Number(BigInt.asUintN(16, w))) >>> 0;
    setSignCc(st, w);
    setOverflow(st, w !== r);
  };
}

function op32(fn: Fn): OpHandler {
  return (st) => {
    const r = fn(i32(st.regs.accu2), i32(st.regs.accu1));
    const w = BigInt.asIntN(32, r);
    st.regs.accu1 = Number(BigInt.asUintN(32, w));
    setSignCc(st, w);
    setOverflow(st, w !== r);
  };
}

/** Manuale AWL, «/I»: quoziente in ACCU1-L, resto in ACCU1-H. Per 0: ACCU1 = 0 (piano 2A). */
const divI: OpHandler = (st) => {
  const a = i16(st.regs.accu2);
  const b = i16(st.regs.accu1);
  if (b === 0n) {
    st.regs.accu1 = 0;
    divByZero(st);
    return;
  }
  const q = a / b;
  const w = BigInt.asIntN(16, q);
  const rem = a % b;
  st.regs.accu1 = ((Number(BigInt.asUintN(16, rem)) << 16) | Number(BigInt.asUintN(16, w))) >>> 0;
  setSignCc(st, w);
  setOverflow(st, w !== q);
};

function div32(remainder: boolean): OpHandler {
  return (st) => {
    const a = i32(st.regs.accu2);
    const b = i32(st.regs.accu1);
    if (b === 0n) {
      st.regs.accu1 = 0;
      divByZero(st);
      return;
    }
    const q = a / b;
    const w = BigInt.asIntN(32, remainder ? a % b : q);
    st.regs.accu1 = Number(BigInt.asUintN(32, w));
    setSignCc(st, w);
    setOverflow(st, !remainder && w !== q);
  };
}

/**
 * Manuale AWL, «+ <costante intera>»: costante a 16 bit su ACCU1-L (ACCU1-H invariata), a 32 bit su
 * tutto ACCU1; la parola di stato non cambia.
 */
const addConst: OpHandler = (st, stmt) => {
  const op = stmt.operand;
  const c = op?.kind === 'constant' ? parseConstant(op.text) : undefined;
  if (!c) throw new SimError('MC7_NON_ESEGUIBILE', 'costante intera attesa');
  const v = c.data.reduce((a, b) => a * 256 + b, 0);
  const a = st.regs.accu1;
  st.regs.accu1 =
    c.data.length <= 2 ? ((a & 0xffff0000) | ((a + v) & 0xffff)) >>> 0 : (a + v) >>> 0;
};

export const INTEGER_OPS: Record<string, OpHandler> = {
  '+I': op16((a, b) => a + b),
  '-I': op16((a, b) => a - b),
  '*I': op16((a, b) => a * b),
  '/I': divI,
  '+D': op32((a, b) => a + b),
  '-D': op32((a, b) => a - b),
  '*D': op32((a, b) => a * b),
  '/D': div32(false),
  MOD: div32(true),
  '+': addConst,
};
