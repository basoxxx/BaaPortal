/** Codici degli errori di programmazione della CPU simulata (piano 2A, Global Constraints). */
export type SimErrorCode =
  | 'AREA_LUNGHEZZA'
  | 'DB_NON_CARICATO'
  | 'DB_NON_APERTO'
  | 'BLOCCO_NON_CARICATO'
  | 'STACK_BLOCCHI_PIENO'
  | 'STACK_ANNIDAMENTO_PIENO'
  | 'STACK_L_PIENO'
  | 'ISTRUZIONE_NON_S7300'
  | 'MC7_NON_ESEGUIBILE'
  | 'BCD_NON_VALIDO'
  | 'NUMERO_TEMPORIZZATORE'
  | 'TEMPO_CICLO_SUPERATO'
  | 'NON_SIMULATA_2B';

export class SimError extends Error {
  /** Posizione dell'errore, riempita dall'esecutore: blocco, offset MC7 (byte) e rete (da 1). */
  block?: { kind: string; number: number };
  offset?: number;
  network?: number;

  constructor(
    public code: SimErrorCode,
    public detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'SimError';
  }
}
