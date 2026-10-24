import type { OpHandler } from '../executor';
import { ACCUMULATOR_OPS } from './accumulator';
import { BIT_OPS } from './bitLogic';
import { COMPARISON_OPS } from './comparison';
import { CONVERSION_OPS } from './conversion';
import { CONTROL_OPS } from './control';
import { DB_OPS } from './db';
import { FLOAT_OPS } from './float';
import { INTEGER_OPS } from './integer';
import { JUMP_OPS } from './jump';
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
  ...INTEGER_OPS,
  ...FLOAT_OPS,
  ...COMPARISON_OPS,
  ...CONVERSION_OPS,
  ...JUMP_OPS,
  ...CONTROL_OPS,
};
