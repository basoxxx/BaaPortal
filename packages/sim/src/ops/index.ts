import type { OpHandler } from '../executor';
import { BIT_OPS } from './bitLogic';

/** Tabella delle istruzioni; la chiave è l'id internazionale di INSTRUCTIONS. */
export const OPS: Record<string, OpHandler> = {
  ...BIT_OPS,
  // Manuale AWL, «Operazioni di controllo»: BLD e NOP non fanno niente, BE termina il blocco.
  BLD: () => undefined,
  NOP: () => undefined,
  BE: () => 'return',
};
