/** Codici degli errori della CPU simulata (piano 2A, Global Constraints; piano 2B, Task 3). */
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
  | 'NUMERO_CONTATORE'
  | 'TEMPO_CICLO_SUPERATO'
  /** L'OB di un evento manca, e manca anche OB85 (manuale delle funzioni di sistema, OB85). */
  | 'OB_NON_CARICATO';

/** Informazioni facoltative sull'errore, per i dati di avvio di OB121/OB122 e l'id diagnostico. */
export interface SimErrorInfo {
  /** Direzione dell'accesso fallito: sceglie SW_FLT 16#22/16#23 (o 16#42/16#43 per la periferia). */
  access?: 'read' | 'write';
  /** Accesso alla periferia (PI/PQ) fuori dal campo di I/O della CPU: evento di OB122. */
  periphery?: { byte: number; width: number };
  /** Registro d'errore (FLT_REG di OB121): numero del DB, del temporizzatore, del contatore o del blocco. */
  faultReg?: number;
  /** Tipo del blocco non caricato (BLOCCO_NON_CARICATO). */
  missingBlock?: 'FC' | 'FB' | 'SFC' | 'SFB' | 'OB';
  /** Id dell'evento nel buffer di diagnostica, quando non si ricava dal codice (per esempio 16#3502). */
  eventId?: number;
}

export class SimError extends Error implements SimErrorInfo {
  /** Posizione dell'errore, riempita dall'esecutore: blocco, offset MC7 (byte) e rete (da 1). */
  block?: { kind: string; number: number };
  offset?: number;
  network?: number;
  access?: 'read' | 'write';
  periphery?: { byte: number; width: number };
  faultReg?: number;
  missingBlock?: 'FC' | 'FB' | 'SFC' | 'SFB' | 'OB';
  eventId?: number;

  constructor(
    public code: SimErrorCode,
    public detail?: string,
    info?: SimErrorInfo,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'SimError';
    if (info) Object.assign(this, info);
  }
}

/**
 * Richiesta di STOP dal programma (SFC 46 STP): interrompe l'esecuzione del ciclo in corso. Non è un
 * errore della CPU: la fa passare in STOP con la voce `STOP_RICHIESTO`, senza OB di errore.
 */
export class StopRequest extends Error {
  constructor(public readonly reason: string) {
    super(`STOP richiesto: ${reason}`);
    this.name = 'StopRequest';
  }
}
