import type { Operand } from '@baaportal/awl';
import { SimError } from '../errors';
import type { ExecState, OpHandler } from '../executor';
import { formalTcNumber, resolveIndirectNumber } from '../operands';
import type { TimerKind } from '../timers';
import { counterNumber, endCounterOp, isCounter } from './counter';

/** Numero di temporizzatore da `T n` o `T [MW n]`. */
export function timerNumber(st: ExecState, op: Operand | undefined): number {
  if (op?.kind === 'timerCounter' && op.area === 'T') return op.number;
  if (op?.kind === 'indirect' && op.area === 'T')
    return resolveIndirectNumber(op, st.regs, st.mem, st.frame);
  // Parametro formale di FC di tipo TIMER (`#T_IN`): il numero viene dalla lista dei puntatori.
  if (op?.kind === 'local') return formalTcNumber(op, st.frame);
  throw new SimError('MC7_NON_ESEGUIBILE', 'temporizzatore atteso');
}

/** Parola di stato di avvio, FR e R (manuale AWL S7-300/400): /FC = 0, OR = 0, STA = RLO; RLO invariato. */
function endTimerOp(st: ExecState): void {
  const s = st.regs.stw;
  s.sta = s.rlo;
  s.fc = false;
  s.or = false;
}

function start(kind: TimerKind): OpHandler {
  return (st, stmt) => {
    const n = timerNumber(st, stmt.operand);
    st.ctx.timers.startOp(n, kind, st.regs.stw.rlo, st.regs.accu1 & 0xffff);
    endTimerOp(st);
  };
}

export const TIMER_OPS: Record<string, OpHandler> = {
  SP: start('SP'),
  SE: start('SE'),
  SD: start('SD'),
  SS: start('SS'),
  SF: start('SF'),
  // Manuale AWL S7-300/400, «LC»: residuo in BCD con la base nei bit 12–13 (ACCU1 passa in ACCU2).
  LC: (st, stmt) => {
    const v = isCounter(stmt.operand, stmt.formal)
      ? st.ctx.counters.bcd(counterNumber(st, stmt.operand))
      : st.ctx.timers.bcd(timerNumber(st, stmt.operand));
    st.regs.accu2 = st.regs.accu1;
    st.regs.accu1 = v;
  },
  FR: (st, stmt) => {
    if (isCounter(stmt.operand, stmt.formal)) {
      st.ctx.counters.enable(counterNumber(st, stmt.operand), st.regs.stw.rlo);
      endCounterOp(st);
      return;
    }
    st.ctx.timers.enable(timerNumber(st, stmt.operand), st.regs.stw.rlo);
    endTimerOp(st);
  },
};
