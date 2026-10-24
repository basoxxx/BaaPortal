/** Dati di accesso a una CPU reale (solo tipi: nessuna rete in questo pacchetto). */
export interface PlcAccess {
  host: string;
  /** Predefinito 102; serve solo al PLC di prova. */
  port?: number;
  rack: number;
  slot: number;
  connectionType: 'PG' | 'OP' | 'S7_BASIC';
  remoteTsap?: number;
}

/** Identità letta dalla CPU. */
export interface PlcIdentity {
  orderNumber: string;
  moduleName?: string;
  firmware?: string;
  serial?: string;
  plantId?: string;
}

export type PlcMode = 'RUN' | 'STOP' | 'STARTUP' | 'HOLD' | 'UNKNOWN';
