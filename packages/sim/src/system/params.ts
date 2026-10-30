import type { SzlList } from '@baaportal/s7comm';
import type { SystemBlock } from '@baaportal/catalog';
import type { ExecState } from '../executor';
import type { Location } from '../operands';
import { readBits, writeBits } from '../operands';
import { SimError } from '../errors';
import type { SfbState } from './sfb';
import type { SimIoModule } from '../cpu';

export type Size = 'X' | 'B' | 'W' | 'D';

/**
 * Errore di una SFC con il suo RET_VAL: lo lanciano gli accessi ai parametri; il richiamo lo trasforma
 * in RET_VAL negativo e BR = 0, senza errore di programmazione (manuale delle funzioni di sistema e
 * standard S7-300/400, valutazione degli errori di RET_VAL).
 */
export class SysError extends Error {
  constructor(public readonly retVal: number) {
    super(`RET_VAL 16#${retVal.toString(16).toUpperCase()}`);
    this.name = 'SysError';
  }
}

/** Codice generale 16#8xyy: `x` = numero del parametro (da 1), `yy` = errore (manuale, codici d'errore generali). */
export const paramError = (param: number, yy: number): SysError =>
  new SysError(0x8000 | (param << 8) | yy);

/** Area di un puntatore ANY (byte 6 del puntatore: 16#80..16#87). */
export type AnyArea = 'P' | 'I' | 'Q' | 'M' | 'DB' | 'DI' | 'L' | 'V';
const ANY_AREAS: readonly AnyArea[] = ['P', 'I', 'Q', 'M', 'DB', 'DI', 'L', 'V'];

/** Parametro ANY (10 byte, mc7 §2.5): area, DB, indirizzo di partenza e lunghezza in byte. */
export interface AnyRef {
  area: AnyArea;
  db: number;
  /** Indirizzo di partenza in bit (per L e V già assoluto nello stack L). */
  bit: number;
  /** Byte dell'area designata: ripetizioni × dimensione del tipo. */
  length: number;
  /** Byte del tipo di dati dell'ANY. */
  type: number;
  count: number;
  /** Fine (byte, esclusa) della finestra L dentro cui l'accesso deve stare. */
  limit?: number;
}

/** Riferimento a un parametro attuale di una SFC. */
export interface ParamRef {
  readonly name: string;
  /** Numero del parametro per i codici 16#8xyy: 1 = primo parametro formale (RET_VAL esclusa). */
  readonly index: number;
  read(size: Size): number;
  write(size: Size, value: number): void;
  /** Vista di `length` byte sulla memoria del parametro (DATE_AND_TIME, strutture): già convalidata. */
  bytes(length: number, access?: 'read' | 'write'): Uint8Array;
  /** Il parametro è un ANY: lo decodifica (SysError se non lo è). */
  any(): AnyRef;
  /** I byte che l'ANY designa, già convalidati; una scrittura fuori area è un SysError, senza effetti. */
  anyBytes(any: AnyRef, access: 'read' | 'write'): Uint8Array;
}

/**
 * Servizi della CPU per le funzioni di sistema (orologio, STOP, avvisi, SZL). La CPU simulata li
 * fornisce in `ExecContext.sys`; senza, un'esecuzione isolata usa quelli di `standaloneServices`.
 */
export interface SystemServices {
  /** Orologio della CPU in ms: `now()` più lo scarto di SET_CLK. */
  clockMs(): number;
  setClockMs(ms: number): void;
  /** ms dall'avvio della CPU, modulo 2^31. */
  tickMs(): number;
  /** Fa avanzare il tempo di `us` microsecondi senza attendere davvero (nessun timer reale). */
  wait(us: number): void;
  /** Richiede lo STOP con il motivo dato; non ritorna. */
  stop(reason: string): never;
  /** Avviso «non simulata»: una volta per blocco e per periodo di RUN. */
  warnNotSimulated(kind: 'SFC' | 'SFB', number: number): void;
  /** Lista SZL come la dà il server S7; `undefined` se la CPU la rifiuta. */
  szl(id: number, index: number): SzlList | undefined;
  /** Stato interno degli SFB IEC per (DI, offset AR2); azzerato all'avvio a caldo e dalla cancellazione totale. */
  readonly sfbState: Map<string, SfbState>;
  /** Numero massimo di DB della CPU (catalogo). */
  readonly maxDb: number;
  /** Riavvia il controllo del tempo di ciclo (SFC 43 RE_TRIGR). */
  retrigger(): void;
  /**
   * Ritardi degli allarmi dell'OB in corso (SFC 41/42): `+1` o `-1`; il numero dopo la chiamata,
   * `undefined` se `-1` senza ritardi attivi.
   */
  delayInterrupts(delta: 1 | -1): number | undefined;
  /** Primi 12 byte dei dati di avvio dell'OB in corso e dell'ultimo OB di avvio (SFC 6). */
  startInfo(): { top: Uint8Array; startUp: Uint8Array };
  /** Allarmi a tempo, contatore di ore e blocchi di DIS_IRT (SFC 2–4, 28–34, 39, 40). */
  readonly state: SysState;
  /** Maschere degli errori sincroni dell'OB in corso (SFC 36–38). */
  faults(): FaultMasks;
  /** Gestore degli errori sincroni (maschere, OB121/OB122): MSK_FLT lo installa nel contesto se manca. */
  readonly onFault: (e: SimError, st: ExecState) => boolean;
  /** Moduli di I/O presenti della configurazione hardware (SFC 5, 49, 58, 59). */
  modules(): readonly SimIoModule[];
  /** Voce utente nel buffer di diagnostica (SFC 52 WR_USMSG). */
  userMessage(eventId: number, detail: string): void;
}

/** Maschere e registro degli errori sincroni (bit n = SW_FLT 16#20+n per la programmazione, 16#40+n per l'accesso). */
export interface FaultMasks {
  prg: number;
  acc: number;
  /** Errori mascherati avvenuti, finché READ_ERR non li cancella. */
  prgErr: number;
  accErr: number;
}

/** Allarme di ritardo avviato da SFC 32 (OB20). */
export interface DelayInterrupt {
  /** Istante di scadenza (orologio di sistema, ms). */
  due: number;
  sign: number;
  dtimeMs: number;
}

/** Allarme dall'orologio impostato da SFC 28 (OB10). */
export interface TodInterrupt {
  /** Data e ora di partenza (orologio della CPU, ms), secondi e millisecondi azzerati. */
  start: number;
  /** PERIOD di SFC 28 (16#0000 una volta, 16#0201 ogni minuto, …). */
  period: number;
  active: boolean;
  /** Prossima scadenza (orologio della CPU), con l'allarme attivo. */
  next?: number;
}

/** Stato delle SFC che sopravvive alla chiamata; l'avvio a caldo lo riazzera (tranne il contatore di ore). */
export class SysState {
  /** Contatore di ore 0 (SFC 2–4): ms accumulati e inizio del conteggio in corso. */
  rtm: { ms: number; since?: number } = { ms: 0 };
  readonly delay = new Map<number, DelayInterrupt>();
  readonly tod = new Map<number, TodInterrupt>();
  /** OB bloccati da SFC 39 DIS_IRT: i loro eventi si scartano. */
  readonly disabled = new Set<number>();

  /** Avvio a caldo: gli allarmi a tempo e i blocchi si cancellano (⚠️), il contatore di ore si ferma. */
  restart(now: number): void {
    this.delay.clear();
    this.tod.clear();
    this.disabled.clear();
    this.stopRtm(now);
  }

  stopRtm(now: number): void {
    if (this.rtm.since !== undefined) this.rtm = { ms: this.rtm.ms + now - this.rtm.since };
  }
}

/** Richiamo di una SFC o di un SFB, come lo vede il gestore. */
export interface SystemCall {
  /** Stato del blocco chiamante: registri (DB, DI, AR2), memoria, finestra L. */
  readonly ctx: ExecState;
  readonly kind: 'SFC' | 'SFB';
  readonly number: number;
  /** Interfaccia dal catalogo. */
  readonly block: SystemBlock;
  readonly services: SystemServices;
  /** Parametro attuale per nome (alias del catalogo compresi). Solo SFC: gli SFB leggono il DB di istanza. */
  param(name: string): ParamRef;
  /** Scrive RET_VAL e mette BR = 1 se ≥ 0 (INT), altrimenti 0. Senza chiamata BR = 1. */
  ret(value: number): void;
}

export type SystemHandler = (call: SystemCall) => void;

// ---- ANY ------------------------------------------------------------------------------------------

/** Byte per elemento di un tipo ANY; BOOL conta bit (8 per byte); `undefined` = tipo non ammesso in memoria. */
const TYPE_BYTES: Record<number, number | undefined> = {
  0x01: 1 / 8, // BOOL
  0x02: 1, // BYTE
  0x03: 1, // CHAR
  0x04: 2, // WORD
  0x05: 2, // INT
  0x06: 4, // DWORD
  0x07: 4, // DINT
  0x08: 4, // REAL
  0x09: 2, // DATE
  0x0a: 4, // TIME_OF_DAY
  0x0b: 4, // TIME
  0x0c: 2, // S5TIME
  0x0e: 8, // DATE_AND_TIME
  0x13: 1, // STRING (byte)
};

/** Decodifica i 10 byte di un ANY nella posizione `p`-esima; `index` = numero del parametro. */
function decodeAny(st: ExecState, b: Uint8Array, index: number): AnyRef {
  if (b[0] !== 0x10) throw paramError(index, 0x24);
  const type = b[1]!;
  const per = TYPE_BYTES[type];
  if (per === undefined) throw paramError(index, 0x24);
  const count = (b[2]! << 8) | b[3]!;
  const db = (b[4]! << 8) | b[5]!;
  const code = b[6]!;
  if (code < 0x80 || code > 0x87) throw paramError(index, 0x24);
  const area = ANY_AREAS[code & 7]!;
  let bit = ((b[7]! << 16) | (b[8]! << 8) | b[9]!) & 0x7ffff;
  const bits = type === 0x01 ? count : count * per * 8;
  if (type === 0x01 && (count % 8 !== 0 || (bit & 7) !== 0)) throw paramError(index, 0x28);
  const ref: AnyRef = { area, db, bit, length: Math.ceil(bits / 8), type, count };
  if (area === 'L' || area === 'V') {
    const base = area === 'L' ? st.frame.lBase : st.frame.prevLBase;
    const size = area === 'L' ? st.frame.lSize : st.frame.prevLSize;
    bit += base * 8;
    ref.bit = bit;
    if (size !== undefined) ref.limit = base + size;
  }
  return ref;
}

/** Vista sui byte di un ANY; gli errori di memoria diventano codici 16#8xyy del parametro `index`. */
function viewOfAny(st: ExecState, a: AnyRef, access: 'read' | 'write', index: number): Uint8Array {
  const write = access === 'write';
  if ((a.bit & 7) !== 0) throw paramError(index, write ? 0x29 : 0x28);
  if ((a.area === 'DB' || a.area === 'DI') && a.db === 0) throw paramError(index, 0x3a);
  const area = a.area === 'P' ? (write ? 'PQ' : 'PI') : a.area;
  const byte = a.bit >> 3;
  if (a.limit !== undefined && byte + a.length > a.limit)
    throw paramError(index, write ? 0x23 : 0x22);
  try {
    return st.mem.bytes(area, a.area === 'DB' || a.area === 'DI' ? a.db : null, byte, a.length);
  } catch (e) {
    if (!(e instanceof SimError)) throw e;
    if (e.code === 'DB_NON_CARICATO') throw paramError(index, 0x3a);
    if (e.code === 'AREA_LUNGHEZZA') throw paramError(index, write ? 0x23 : 0x22);
    throw e;
  }
}

/**
 * Gli errori di memoria di un parametro scalare diventano i codici generali 16#8xyy (22 lettura,
 * 23 scrittura, 3A DB non caricato o non aperto); gli altri restano errori di programmazione.
 */
function asSysError<T>(index: number, access: 'read' | 'write', f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (!(e instanceof SimError)) throw e;
    if (e.code === 'DB_NON_CARICATO' || e.code === 'DB_NON_APERTO') throw paramError(index, 0x3a);
    if (e.code === 'AREA_LUNGHEZZA') throw paramError(index, access === 'write' ? 0x23 : 0x22);
    throw e;
  }
}

/**
 * Il parametro attuale in posizione `index`. Con `mapErrors = false` gli errori restano SimError:
 * serve per RET_VAL, la cui scrittura fallita è un errore di programmazione (OB121 / STOP).
 */
export function paramRef(
  st: ExecState,
  loc: Location | null,
  name: string,
  index: number,
  mapErrors = true,
): ParamRef {
  const here = (): Location => {
    if (!loc) throw new SimError('MC7_NON_ESEGUIBILE', `parametro ${name}: puntatore senza area`);
    return loc;
  };
  const guard = <T>(access: 'read' | 'write', f: () => T): T =>
    mapErrors ? asSysError(index, access, f) : f();
  const bytes = (length: number, access: 'read' | 'write' = 'read'): Uint8Array =>
    guard(access, () => {
      const l = here();
      if (l.limit !== undefined && (l.bit >> 3) + length > l.limit)
        throw new SimError('AREA_LUNGHEZZA', `${name}: fuori dalla finestra`);
      return st.mem.bytes(l.area === 'P' ? 'PI' : l.area, l.db, l.bit >> 3, length);
    });
  return {
    name,
    index,
    read: (size) => guard('read', () => readBits(st.mem, here(), size)),
    write: (size, value) => guard('write', () => writeBits(st.mem, here(), size, value)),
    bytes,
    any: () => decodeAny(st, bytes(10), index),
    anyBytes: (a, access) => viewOfAny(st, a, access, index),
  };
}
