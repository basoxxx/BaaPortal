import { SimError } from '../errors';
import type { ExecState, OpHandler } from '../executor';
import { resolveIndirectNumber } from '../operands';

function blockNumber(
  st: ExecState,
  stmt: Parameters<OpHandler>[1],
): { reg: 'db' | 'di'; n: number } {
  const op = stmt.operand;
  if (op?.kind === 'block' && (op.blockKind === 'DB' || op.blockKind === 'DI'))
    return { reg: op.blockKind === 'DB' ? 'db' : 'di', n: op.number };
  if (op?.kind === 'indirect' && (op.area === 'DB' || op.area === 'DI'))
    return {
      reg: op.area === 'DB' ? 'db' : 'di',
      n: resolveIndirectNumber(op, st.regs, st.mem, st.frame),
    };
  throw new SimError('MC7_NON_ESEGUIBILE', 'OPN: operando non valido');
}

export const DB_OPS: Record<string, OpHandler> = {
  // Manuale AWL, «OPN»: apre il DB o il DI; se non è caricato, errore di programmazione.
  OPN: (st, stmt) => {
    const { reg, n } = blockNumber(st, stmt);
    if (!st.mem.dbs.has(n)) throw new SimError('DB_NON_CARICATO', `DB${n}`);
    st.regs[reg] = n;
  },
  // Manuale AWL, «CDB»: scambia DB e DI.
  CDB: (st) => {
    [st.regs.db, st.regs.di] = [st.regs.di, st.regs.db];
  },
};
