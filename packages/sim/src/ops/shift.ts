import type { ExecState, OpHandler } from '../executor';
import { constantValue } from './loadTransfer';

/** Posizioni: l'operando, oppure ACCU2-LL (manuale AWL S7-300/400, «Operazioni di scorrimento»). */
function count(st: ExecState, operand: Parameters<OpHandler>[1]['operand']): number {
  return operand ? constantValue(operand) : st.regs.accu2 & 0xff;
}

function finish(st: ExecState, value: number, width: 16 | 32, lastOut: boolean): void {
  const a = st.regs.accu1;
  st.regs.accu1 = (width === 16 ? (a & 0xffff0000) | (value & 0xffff) : value) >>> 0;
  const s = st.regs.stw;
  s.cc1 = lastOut;
  s.cc0 = false;
  s.ov = false;
}

/** Valore dell'ACCU1 nella larghezza data (per SSI con segno). */
function field(st: ExecState, width: 16 | 32): number {
  return width === 16 ? st.regs.accu1 & 0xffff : st.regs.accu1 >>> 0;
}

function shiftLeft(width: 16 | 32): OpHandler {
  return (st, stmt) => {
    const n = count(st, stmt.operand);
    if (n === 0) return;
    const v = field(st, width);
    // Oltre la larghezza escono tutti i bit; l'ultimo uscito è 0 (a meno di n = larghezza).
    const out = n <= width ? ((v >>> (width - n)) & 1) === 1 : false;
    finish(st, n >= width ? 0 : v << n, width, out);
  };
}

function shiftRight(width: 16 | 32): OpHandler {
  return (st, stmt) => {
    const n = count(st, stmt.operand);
    if (n === 0) return;
    const v = field(st, width);
    const out = n <= width ? ((v >>> (n - 1)) & 1) === 1 : false;
    finish(st, n >= width ? 0 : v >>> n, width, out);
  };
}

function shiftSigned(width: 16 | 32): OpHandler {
  return (st, stmt) => {
    const n = count(st, stmt.operand);
    if (n === 0) return;
    const v = field(st, width);
    const signed = width === 16 ? (v << 16) >> 16 : v | 0;
    // Con n oltre la larghezza restano solo bit di segno, e l'ultimo uscito è il segno.
    const k = Math.min(n, width - 1);
    const out = n >= width ? signed < 0 : ((v >>> (n - 1)) & 1) === 1;
    finish(st, signed >> k, width, out);
  };
}

function rotate(left: boolean): OpHandler {
  return (st, stmt) => {
    const n = count(st, stmt.operand);
    if (n === 0) return;
    const k = n % 32;
    const a = st.regs.accu1;
    const r = k === 0 ? a : left ? (a << k) | (a >>> (32 - k)) : (a >>> k) | (a << (32 - k));
    // Ultimo bit uscito: a sinistra rientra come bit 0, a destra come bit 31.
    finish(st, r >>> 0, 32, (left ? r & 1 : (r >>> 31) & 1) === 1);
  };
}

function rotateCc1(left: boolean): OpHandler {
  return (st) => {
    // Manuale AWL S7-300/400, «RLDA», «RRDA»: rotazione di una posizione attraverso CC1.
    const a = st.regs.accu1;
    const cc1 = st.regs.stw.cc1;
    const r = left ? (a << 1) | (cc1 ? 1 : 0) : (a >>> 1) | (cc1 ? 0x80000000 : 0);
    finish(st, r >>> 0, 32, left ? a >>> 31 === 1 : (a & 1) === 1);
  };
}

export const SHIFT_OPS: Record<string, OpHandler> = {
  SLW: shiftLeft(16),
  SRW: shiftRight(16),
  SLD: shiftLeft(32),
  SRD: shiftRight(32),
  SSI: shiftSigned(16),
  SSD: shiftSigned(32),
  RLD: rotate(true),
  RRD: rotate(false),
  RLDA: rotateCc1(true),
  RRDA: rotateCc1(false),
};
