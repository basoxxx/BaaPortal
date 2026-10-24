import type { OpHandler } from '../executor';
import { ACCUMULATOR_OPS } from './accumulator';
import { BIT_OPS } from './bitLogic';
import { DB_OPS } from './db';
import { LOAD_TRANSFER_OPS } from './loadTransfer';
import { SHIFT_OPS } from './shift';
import { WORD_LOGIC_OPS } from './wordLogic';

/** Tabella delle istruzioni; la chiave è l'id internazionale di INSTRUCTIONS. */
export const OPS: Record<string, OpHandler> = {
  ...BIT_OPS,
  ...LOAD_TRANSFER_OPS,
  ...ACCUMULATOR_OPS,
  ...WORD_LOGIC_OPS,
  ...SHIFT_OPS,
  ...DB_OPS,
  // Manuale AWL, «Operazioni di controllo»: BLD e NOP non fanno niente, BE termina il blocco.
  BLD: () => undefined,
  NOP: () => undefined,
  BE: () => 'return',
};
