import type { Operand } from '@baaportal/awl';
import { SimError } from '../errors';
import type { ExecState, OpHandler } from '../executor';
import { formalTcNumber, resolveIndirectNumber } from '../operands';

/** Numero di contatore da `C n`, `C [MW n]` o da un parametro formale COUNTER (`#C_IN`). */
export function counterNumber(st: ExecState, op: Operand | undefined): number {
  if (op?.kind === 'timerCounter' && op.area === 'C') return op.number;
  if (op?.kind === 'indirect' && op.area === 'C')
    return resolveIndirectNumber(op, st.regs, st.mem, st.frame);
  if (op?.kind === 'local') return formalTcNumber(op, st.frame);
  throw new SimError('MC7_NON_ESEGUIBILE', 'contatore atteso');
}

/** Vero se l'operando è un contatore (`C n`, `C [..]` o parametro formale di tipo COUNTER). */
export function isCounter(op: Operand | undefined, formal?: { type: string }): boolean {
  if (op?.kind === 'local') return formal?.type === 'Counter';
  return (op?.kind === 'timerCounter' || op?.kind === 'indirect') && op.area === 'C';
}

/** Parola di stato di CU, CD, S, R e FR su contatore: /FC = 0, OR = 0, STA = RLO; RLO invariato. */
export function endCounterOp(st: ExecState): void {
  const s = st.regs.stw;
  s.sta = s.rlo;
  s.fc = false;
  s.or = false;
}

export const COUNTER_OPS: Record<string, OpHandler> = {
  CU: (st, stmt) => {
    st.ctx.counters.countUp(counterNumber(st, stmt.operand), st.regs.stw.rlo);
    endCounterOp(st);
  },
  CD: (st, stmt) => {
    st.ctx.counters.countDown(counterNumber(st, stmt.operand), st.regs.stw.rlo);
    endCounterOp(st);
  },
};
