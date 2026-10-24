import type { ExecState, OpHandler } from '../executor';

const view = new DataView(new ArrayBuffer(4));

/** REAL (IEEE 754 a 32 bit, big-endian) di un accumulatore. */
export function toReal(u: number): number {
  view.setUint32(0, u >>> 0, false);
  return view.getFloat32(0, false);
}

export function fromReal(x: number): number {
  if (Number.isNaN(x)) return 0x7fc00000; // NaN canonico
  view.setFloat32(0, x, false);
  return view.getUint32(0, false);
}

/** Più piccolo REAL normalizzato. */
const MIN_NORMAL = 1.1754943508222875e-38;

/**
 * Bit di stato di un risultato REAL (manuale AWL S7-300/400, «Operazioni in virgola mobile», tabella):
 * normalizzato +/− → CC 10/01, OV 0; ±0 → 00; denormalizzato → 00, OV = OS = 1; ±infinito → 10/01,
 * OV = OS = 1; NaN → 11, OV = OS = 1.
 */
export function setRealStatus(st: ExecState, r: number): void {
  const s = st.regs.stw;
  let ov = false;
  if (Number.isNaN(r)) {
    s.cc0 = s.cc1 = true;
    ov = true;
  } else if (r === 0) {
    s.cc0 = s.cc1 = false;
  } else if (Math.abs(r) < MIN_NORMAL) {
    s.cc0 = s.cc1 = false;
    ov = true;
  } else {
    s.cc0 = r < 0;
    s.cc1 = r > 0;
    ov = !Number.isFinite(r);
  }
  s.ov = ov;
  if (ov) s.os = true;
}

function binary(fn: (a: number, b: number) => number): OpHandler {
  return (st) => {
    const r = Math.fround(fn(toReal(st.regs.accu2), toReal(st.regs.accu1)));
    st.regs.accu1 = fromReal(r);
    setRealStatus(st, r);
  };
}

function unary(fn: (a: number) => number): OpHandler {
  return (st) => {
    const r = Math.fround(fn(toReal(st.regs.accu1)));
    st.regs.accu1 = fromReal(r);
    setRealStatus(st, r);
  };
}

export const FLOAT_OPS: Record<string, OpHandler> = {
  '+R': binary((a, b) => a + b),
  '-R': binary((a, b) => a - b),
  '*R': binary((a, b) => a * b),
  '/R': binary((a, b) => a / b),
  // Manuale AWL S7-300/400, «ABS»: azzera il bit di segno; la parola di stato non cambia.
  ABS: (st) => {
    st.regs.accu1 = (st.regs.accu1 & 0x7fffffff) >>> 0;
  },
  SQR: unary((a) => a * a),
  SQRT: unary(Math.sqrt),
  EXP: unary(Math.exp),
  LN: unary(Math.log),
  SIN: unary(Math.sin),
  COS: unary(Math.cos),
  TAN: unary(Math.tan),
  ASIN: unary(Math.asin),
  ACOS: unary(Math.acos),
  ATAN: unary(Math.atan),
};
