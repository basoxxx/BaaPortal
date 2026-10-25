import type { S7Client } from '@baaportal/s7comm';
import type { PlcIdentity, PlcMode } from '@baaportal/ui';

const MODES: readonly PlcMode[] = ['RUN', 'STOP', 'STARTUP', 'HOLD'];

/** DEFECT e valori sconosciuti diventano UNKNOWN: l'interfaccia conosce solo questi modi. */
export function toPlcMode(m: string): PlcMode {
  return MODES.find((x) => x === m) ?? 'UNKNOWN';
}

/** Dall'identità letta dalla CPU a quella mostrata dall'interfaccia (solo i campi presenti). */
export function toPlcIdentity(i: Awaited<ReturnType<S7Client['identity']>>): PlcIdentity {
  const out: PlcIdentity = { orderNumber: i.orderNumber };
  if (i.moduleName !== undefined) out.moduleName = i.moduleName;
  if (i.version !== undefined) out.firmware = i.version;
  if (i.serialNumber !== undefined) out.serial = i.serialNumber;
  if (i.plantId !== undefined) out.plantId = i.plantId;
  return out;
}
