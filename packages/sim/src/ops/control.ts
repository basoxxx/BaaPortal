import { SimError } from '../errors';
import type { ExecState, OpHandler } from '../executor';
import { readBits, resolveOperand } from '../operands';
import { callBlock } from '../calls';

/** Chi e che cosa richiamare: operando a blocco, o numero letto da memoria (`UC FC [MW 4]`). */
function callee(st: ExecState, stmt: Parameters<OpHandler>[1]): { kind: 'FC' | 'FB'; n: number } {
  if (stmt.indirectBlock) {
    const loc = resolveOperand(stmt.indirectBlock.location, st.regs, st.mem, st.frame);
    return { kind: stmt.indirectBlock.block, n: readBits(st.mem, loc, 'W') };
  }
  const op = stmt.operand;
  if (op?.kind !== 'block')
    throw new SimError('MC7_NON_ESEGUIBILE', `${stmt.id}: operando non valido`);
  if (op.blockKind === 'FC' || op.blockKind === 'FB') return { kind: op.blockKind, n: op.number };
  // SFC e SFB sono del piano 2B.
  throw new SimError('NON_SIMULATA_2B', `${stmt.id} ${op.blockKind}${op.number}`);
}

/** Manuale AWL, «UC» e «CC»: /FC = 0; UC chiama sempre, CC solo con RLO = 1. */
function call(conditional: boolean): OpHandler {
  return (st, stmt) => {
    const s = st.regs.stw;
    const target = callee(st, stmt);
    const go = !conditional || s.rlo;
    s.fc = false;
    if (go) callBlock(st, target.kind, target.n, stmt.pointers);
  };
}

/** Fine blocco condizionata: BR = RLO; OR = 0, STA = 1, RLO = 1, /FC = 0 (manuale AWL, «BEC»). */
const BEC: OpHandler = (st) => {
  const s = st.regs.stw;
  const end = s.rlo;
  s.br = s.rlo;
  s.or = false;
  s.sta = true;
  s.rlo = true;
  s.fc = false;
  return end ? 'return' : undefined;
};

/** Temporizzatori e contatori sono del piano 2B. */
const later: OpHandler = (_st, stmt) => {
  throw new SimError('NON_SIMULATA_2B', stmt.text);
};

export const CONTROL_OPS: Record<string, OpHandler> = {
  // Manuale AWL, «Operazioni di controllo»: BLD e NOP non fanno niente, BE e BEU terminano il blocco.
  BLD: () => undefined,
  NOP: () => undefined,
  BE: () => 'return',
  BEU: () => 'return',
  BEC,
  UC: call(false),
  CC: call(true),
  SP: later,
  SE: later,
  SD: later,
  SS: later,
  SF: later,
  FR: later,
  LC: later,
  CU: later,
  CD: later,
};
