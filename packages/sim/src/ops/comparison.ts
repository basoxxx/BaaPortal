import type { ExecState, OpHandler } from '../executor';
import { checkBit } from './bitLogic';
import { toReal } from './float';

type Test = (cc: 'eq' | 'lt' | 'gt') => boolean;

const TESTS: Record<string, Test> = {
  '==': (c) => c === 'eq',
  '<>': (c) => c !== 'eq',
  '>': (c) => c === 'gt',
  '<': (c) => c === 'lt',
  '>=': (c) => c !== 'lt',
  '<=': (c) => c !== 'gt',
};

/**
 * Manuale AWL, «Operazioni di confronto»: ACCU2 con ACCU1; il risultato entra nell'RLO come una
 * prima interrogazione, STA = risultato, OR = 0. CC: uguale 00, ACCU2 < ACCU1 01, ACCU2 > ACCU1 10,
 * non confrontabile (REAL con NaN) 11 con OV = OS = 1 e risultato falso. OV = 0 altrimenti.
 */
function compare(type: 'I' | 'D' | 'R', test: Test): OpHandler {
  return (st: ExecState) => {
    const { accu1, accu2 } = st.regs;
    let a: number;
    let b: number;
    if (type === 'I') {
      a = (accu2 << 16) >> 16;
      b = (accu1 << 16) >> 16;
    } else if (type === 'D') {
      a = accu2 | 0;
      b = accu1 | 0;
    } else {
      a = toReal(accu2);
      b = toReal(accu1);
    }
    const s = st.regs.stw;
    const unordered = Number.isNaN(a) || Number.isNaN(b);
    const rel = a === b ? 'eq' : a < b ? 'lt' : 'gt';
    const v = !unordered && test(rel);
    s.cc0 = unordered || rel === 'lt';
    s.cc1 = unordered || rel === 'gt';
    s.ov = unordered;
    if (unordered) s.os = true;
    checkBit(st, 'A', v, v);
    s.or = false;
  };
}

export const COMPARISON_OPS: Record<string, OpHandler> = {};
for (const [sym, test] of Object.entries(TESTS))
  for (const t of ['I', 'D', 'R'] as const) COMPARISON_OPS[sym + t] = compare(t, test);
