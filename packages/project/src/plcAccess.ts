/** Dati di accesso a una CPU reale (solo tipi: nessuna rete in questo pacchetto). */
export interface PlcAccess {
  host: string;
  /** Predefinito 102; serve solo al PLC di prova. */
  port?: number;
  rack: number;
  slot: number;
  connectionType: 'PG' | 'OP' | 'S7_BASIC';
  remoteTsap?: number;
  /** Assente vuol dire TCP. Con `mpi`, `host`, `port`, `rack`, `slot` e TSAP restano ma non si usano. */
  link?: PlcLink;
}

export type MpiBusSpeed = '187.5k' | '19.2k' | '1.5M';

/** Collegamento attraverso il PC Adapter MPI (seriale o USB-COM). */
export interface MpiLink {
  kind: 'mpi';
  /** Porta seriale, per esempio `COM3` o `/dev/tty.usbserial-1`. */
  port: string;
  baudRate: number;
  parity: 'odd' | 'even' | 'none';
  localAddress: number;
  cpuAddress: number;
  /** Indirizzo più alto del bus (HSA). */
  highestAddress: number;
  busSpeed: MpiBusSpeed;
  variant: 'auto' | 'v1' | 'v2';
}

export type PlcLink = { kind: 'tcp' } | MpiLink;

/** Valori ammessi dell'indirizzo più alto (HSA), come in TIA Portal. */
export const MPI_HIGHEST_ADDRESSES = [15, 31, 63, 126] as const;
export const MPI_BUS_SPEEDS: readonly MpiBusSpeed[] = ['19.2k', '187.5k', '1.5M'];

/** Identità letta dalla CPU. */
export interface PlcIdentity {
  orderNumber: string;
  moduleName?: string;
  firmware?: string;
  serial?: string;
  plantId?: string;
}

export type PlcMode = 'RUN' | 'STOP' | 'STARTUP' | 'HOLD' | 'UNKNOWN';
