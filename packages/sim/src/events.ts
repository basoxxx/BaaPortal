import type { SimError } from './errors';

/**
 * Eventi della CPU simulata e OB che li servono (manuale «System Software for S7-300/400 System and
 * Standard Functions», OB e dati di avvio; manuale delle CPU 31x per le classi di priorità).
 */

/** Classi di priorità fisse della S7-300. */
export const PRIORITY = {
  OB1: 1,
  OB10: 2,
  OB20: 3,
  OB35: 12,
  /** OB80, OB82, OB85, OB86. */
  ASYNC_ERROR: 26,
  OB100: 27,
} as const;

/** Id degli eventi nel buffer di diagnostica (manuale delle funzioni di sistema). */
export const EVENT = {
  /** Tempo di ciclo superato (OB80, FLT_ID 16#01). */
  CYCLE_TIME: 0x3501,
  /** OB richiesto ancora in esecuzione (OB80, FLT_ID 16#02): OB35 che dura più del suo intervallo. */
  OB_STILL_RUNNING: 0x3502,
  /** OB dell'evento non caricato (OB85, FLT_ID 16#A1). */
  OB_NOT_LOADED: 0x35a1,
} as const;

/** Evento d'errore sincrono: OB che lo serve, codice SW_FLT dei dati di avvio e id diagnostico. */
export interface SyncFault {
  ob: 121 | 122;
  swFlt: number;
  eventId: number;
}

const MISSING_BLOCK_FLT: Record<string, number> = { FC: 0x3c, SFC: 0x3d, FB: 0x3e, SFB: 0x3f };

/**
 * Errore di programmazione (OB121) o di accesso alla periferia (OB122), con il codice del manuale
 * (OB121_SW_FLT, OB122_SW_FLT). Gli altri errori (stack, MC7 non eseguibile…) non hanno un OB:
 * `undefined`, e la CPU va in STOP.
 */
export function syncFaultOf(e: SimError): SyncFault | undefined {
  const write = e.access === 'write';
  if (e.code === 'AREA_LUNGHEZZA' && e.periphery) {
    const swFlt = write ? 0x43 : 0x42;
    return { ob: 122, swFlt, eventId: 0x2900 | swFlt };
  }
  let swFlt: number | undefined;
  switch (e.code) {
    case 'BCD_NON_VALIDO':
      swFlt = 0x21;
      break;
    case 'AREA_LUNGHEZZA':
    // ⚠️ Un accesso a DB/DI senza DB aperto: errore di area come con il registro DB a 0.
    case 'DB_NON_APERTO':
      swFlt = write ? 0x23 : 0x22;
      break;
    case 'NUMERO_TEMPORIZZATORE':
      swFlt = 0x26;
      break;
    case 'NUMERO_CONTATORE':
      swFlt = 0x27;
      break;
    case 'DB_NON_CARICATO':
      swFlt = 0x3a;
      break;
    case 'BLOCCO_NON_CARICATO':
      swFlt = e.missingBlock ? MISSING_BLOCK_FLT[e.missingBlock] : undefined;
      break;
    default:
      break;
  }
  return swFlt === undefined ? undefined : { ob: 121, swFlt, eventId: 0x2500 | swFlt };
}

/** Id diagnostico di un errore secondo il manuale; `undefined` se il manuale non ne dà uno. */
export function manualEventIdOf(e: SimError): number | undefined {
  if (e.eventId !== undefined) return e.eventId;
  const f = syncFaultOf(e);
  if (f) return f.eventId;
  if (e.code === 'TEMPO_CICLO_SUPERATO') return EVENT.CYCLE_TIME;
  if (e.code === 'OB_NON_CARICATO') return EVENT.OB_NOT_LOADED;
  return undefined;
}

/** Richiesta di allarme di diagnostica (OB82) o di guasto (OB86) dal pannello. */
export interface HwInterrupt {
  ob: 82 | 86;
  /** Indirizzo logico dell'unità (MDL_ADDR). */
  address: number;
  /** true = evento entrante (16#39), false = uscente (16#38). */
  coming: boolean;
}

/** Numero dell'evento (secondo byte dell'id) di OB82 e OB86. ⚠️ OB86: 16#C4, guasto di una stazione DP. */
export const HW_FLT_ID: Record<HwInterrupt['ob'], number> = { 82: 0x42, 86: 0xc4 };

export function hwEventId(ev: HwInterrupt): number {
  return ((ev.coming ? 0x39 : 0x38) << 8) | HW_FLT_ID[ev.ob];
}
