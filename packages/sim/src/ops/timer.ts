import type { Operand } from '@baaportal/awl';
import { SimError } from '../errors';
import type { ExecState, OpHandler } from '../executor';
import { resolveIndirectNumber } from '../operands';
import type { TimerKind } from '../timers';

/** Numero di temporizzatore da `T n` o `T [MW n]`. */
export function timerNumber(st: ExecState, op: Operand | undefined): number {
  if (op?.kind === 'timerCounter' && op.area === 'T') return op.number;
  if (op?.kind === 'indirect' && op.area === 'T')
    return resolveIndirectNumber(op, st.regs, st.mem, st.frame);
  if (op?.kind === 'local')
    throw new SimError('NON_SIMULATA_2B', `parametro formale di tipo TIMER #${op.path[0]?.name}`);
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

/** Vero se l'operando è un contatore (di competenza del Task 2). */
export function isCounter(op: Operand | undefined): boolean {
  return (op?.kind === 'timerCounter' || op?.kind === 'indirect') && op.area === 'C';
}

export const TIMER_OPS: Record<string, OpHandler> = {
  SP: start('SP'),
  SE: start('SE'),
  SD: start('SD'),
  SS: start('SS'),
  SF: start('SF'),
  // Manuale AWL S7-300/400, «LC»: residuo in BCD con la base nei bit 12–13 (ACCU1 passa in ACCU2).
  LC: (st, stmt) => {
    if (isCounter(stmt.operand)) throw new SimError('NON_SIMULATA_2B', stmt.text);
    const v = st.ctx.timers.bcd(timerNumber(st, stmt.operand));
    st.regs.accu2 = st.regs.accu1;
    st.regs.accu1 = v;
  },
  FR: (st, stmt) => {
    if (isCounter(stmt.operand)) throw new SimError('NON_SIMULATA_2B', stmt.text);
    st.ctx.timers.enable(timerNumber(st, stmt.operand), st.regs.stw.rlo);
    endTimerOp(st);
  },
};
