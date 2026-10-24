import type { ExecState, OpHandler } from '../executor';
import { constantValue } from './loadTransfer';

type Fn = (a: number, b: number) => number;

/** CC1 = (risultato ≠ 0), CC0 = 0, OV = 0 (manuale AWL S7-300/400, operazioni logiche a parola). */
function setCc(st: ExecState, result: number): void {
  const s = st.regs.stw;
  s.cc1 = result !== 0;
  s.cc0 = false;
  s.ov = false;
}

function wordOp(fn: Fn): OpHandler {
  return (st, stmt) => {
    // Con costante: ACCU1-L con la costante; senza: ACCU1-L con ACCU2-L. La parola alta resta.
    const b = stmt.operand ? constantValue(stmt.operand) : st.regs.accu2;
    const r = fn(st.regs.accu1, b) & 0xffff;
    st.regs.accu1 = ((st.regs.accu1 & 0xffff0000) | r) >>> 0;
    setCc(st, r);
  };
}

function dwordOp(fn: Fn): OpHandler {
  return (st, stmt) => {
    const b = stmt.operand ? constantValue(stmt.operand) : st.regs.accu2;
    const r = fn(st.regs.accu1, b) >>> 0;
    st.regs.accu1 = r;
    setCc(st, r);
  };
}

const and: Fn = (a, b) => a & b;
const or: Fn = (a, b) => a | b;
const xor: Fn = (a, b) => a ^ b;

export const WORD_LOGIC_OPS: Record<string, OpHandler> = {
  AW: wordOp(and),
  OW: wordOp(or),
  XOW: wordOp(xor),
  AD: dwordOp(and),
  OD: dwordOp(or),
  XOD: dwordOp(xor),
};
