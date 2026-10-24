import type { PlcAccess, PlcIdentity, PlcMode } from '@baaportal/project';

export type { PlcAccess, PlcIdentity, PlcMode };

/** Eventi dal processo principale sul collegamento online della finestra. */
export type PlcEvent = { kind: 'mode'; mode: PlcMode } | { kind: 'lost'; reason: string };

/** Esito di `plcConnect`: l'errore è già un testo leggibile, mai un'eccezione grezza. */
export type PlcConnectResult =
  | { ok: true; identity: PlcIdentity; mode: PlcMode; protection?: string }
  | { ok: false; error: string };

export interface PlcStatus {
  connected: boolean;
  access?: PlcAccess;
}
