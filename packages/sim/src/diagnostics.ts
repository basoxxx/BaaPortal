import type { SimError, SimErrorCode } from './errors';
import { manualEventIdOf } from './events';

export type DiagCode =
  | SimErrorCode
  | 'STOP_RICHIESTO'
  | 'AVVIO'
  | 'CANCELLAZIONE_TOTALE'
  /** Un OB d'evento è stato richiamato (OB80, OB82, OB85, OB86, OB121, OB122): non è un errore. */
  | 'OB_RICHIAMATO'
  | 'SFC_NON_SIMULATA'
  | 'SFB_NON_SIMULATA';

/** Voce del buffer di diagnostica della CPU simulata. */
export interface DiagEntry {
  /** Istante (ms, orologio della CPU). */
  time: number;
  code: DiagCode;
  /** Id dell'evento nel buffer di diagnostica (SZL 0x00A0): dal manuale, o sintetico da 16#9000 (⚠️). */
  eventId: number;
  /** Blocco in cui è avvenuto l'errore, per esempio `FC2`. */
  block?: string;
  /** Offset MC7 (byte) dell'istruzione. */
  offset?: number;
  /** Rete (da 1) del blocco. */
  network?: number;
  /** Stack dei blocchi al momento dell'errore, dal più interno (come `block`) al più esterno (OB). */
  stack?: { kind: string; number: number; offset: number }[];
  detail?: string;
}

/**
 * Id sintetici (16#9000 + indice) per i codici senza un id del manuale: non sono id Siemens (⚠️).
 * L'ordine è fisso, così gli id restano stabili; i codici nuovi si aggiungono in fondo.
 */
const SYNTHETIC_BASE = 0x9000;
const SYNTHETIC_ORDER: readonly DiagCode[] = [
  'AVVIO',
  'STOP_RICHIESTO',
  'CANCELLAZIONE_TOTALE',
  'AREA_LUNGHEZZA',
  'DB_NON_CARICATO',
  'DB_NON_APERTO',
  'BLOCCO_NON_CARICATO',
  'STACK_BLOCCHI_PIENO',
  'STACK_ANNIDAMENTO_PIENO',
  'STACK_L_PIENO',
  'ISTRUZIONE_NON_S7300',
  'MC7_NON_ESEGUIBILE',
  'BCD_NON_VALIDO',
  'TEMPO_CICLO_SUPERATO',
  'NUMERO_TEMPORIZZATORE',
  'NUMERO_CONTATORE',
  'OB_NON_CARICATO',
  'OB_RICHIAMATO',
  'SFC_NON_SIMULATA',
  'SFB_NON_SIMULATA',
];

/** Id sintetico del codice (16#9000 + indice), ⚠️. */
export function syntheticEventId(code: DiagCode): number {
  const i = SYNTHETIC_ORDER.indexOf(code);
  if (i < 0) throw new RangeError(`codice di diagnostica sconosciuto: ${code}`);
  return SYNTHETIC_BASE + i;
}

/** Voce di diagnostica per un errore: id del manuale se c'è, altrimenti sintetico. */
export function diagFromError(time: number, e: SimError): DiagEntry {
  const d: DiagEntry = {
    time,
    code: e.code,
    eventId: manualEventIdOf(e) ?? syntheticEventId(e.code),
  };
  if (e.block) d.block = `${e.block.kind}${e.block.number}`;
  if (e.offset !== undefined) d.offset = e.offset;
  if (e.network !== undefined) d.network = e.network;
  if (e.blockStack !== undefined) d.stack = e.blockStack.map((f) => ({ ...f }));
  if (e.detail !== undefined) d.detail = e.detail;
  return d;
}

/** Quali codici sono errori della CPU. Esaustivo: un DiagCode nuovo non compila finché non è classificato. */
const IS_ERROR: Record<DiagCode, boolean> = {
  AREA_LUNGHEZZA: true,
  DB_NON_CARICATO: true,
  DB_NON_APERTO: true,
  BLOCCO_NON_CARICATO: true,
  STACK_BLOCCHI_PIENO: true,
  STACK_ANNIDAMENTO_PIENO: true,
  STACK_L_PIENO: true,
  ISTRUZIONE_NON_S7300: true,
  MC7_NON_ESEGUIBILE: true,
  BCD_NON_VALIDO: true,
  NUMERO_TEMPORIZZATORE: true,
  NUMERO_CONTATORE: true,
  TEMPO_CICLO_SUPERATO: true,
  OB_NON_CARICATO: true,
  STOP_RICHIESTO: false,
  AVVIO: false,
  CANCELLAZIONE_TOTALE: false,
  OB_RICHIAMATO: false,
  SFC_NON_SIMULATA: false,
  SFB_NON_SIMULATA: false,
};

/** La voce di diagnostica è un errore della CPU (DiagEntry non porta una gravità: la si ricava dal codice). */
export const isDiagError = (d: DiagEntry): boolean => IS_ERROR[d.code];
