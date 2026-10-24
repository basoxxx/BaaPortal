/**
 * Dati di avvio degli OB (20 byte negli L 0..19), nella forma di `OB_DEFINITIONS[n].startInfo`
 * del catalogo: sei byte (classe, informazione, priorità, numero, due riservati), tre Int (tempo
 * del ciclo precedente, minimo, massimo) e Date_And_Time in BCD (manuale delle funzioni di
 * sistema e standard S7-300/400, OB1).
 */
export const START_INFO_BYTES = 20;

export interface CycleTimes {
  /** Millisecondi del ciclo precedente, minimo e massimo. */
  prev: number;
  min: number;
  max: number;
}

const bcd = (n: number): number => ((Math.floor(n / 10) % 10) << 4) | (n % 10);
const int16 = (n: number): number => Math.max(0, Math.min(0x7fff, Math.round(n)));

/** Data e ora come Date_And_Time: anno, mese, giorno, ore, minuti, secondi, ms (3 cifre), giorno. */
export function dateTimeBcd(ms: number): number[] {
  const d = new Date(ms);
  const msec = d.getMilliseconds();
  return [
    bcd(d.getFullYear() % 100),
    bcd(d.getMonth() + 1),
    bcd(d.getDate()),
    bcd(d.getHours()),
    bcd(d.getMinutes()),
    bcd(d.getSeconds()),
    bcd(Math.floor(msec / 10)),
    ((msec % 10) << 4) | (d.getDay() + 1),
  ];
}

/** Dati di avvio di OB1; `first` = primo ciclo dopo l'avvio (informazione 1 invece di 3). */
export function ob1StartInfo(first: boolean, times: CycleTimes, ms: number): Uint8Array {
  const b = new Uint8Array(START_INFO_BYTES);
  b.set([0x11, first ? 0x01 : 0x03, 1, 1, 0, 0]);
  [times.prev, times.min, times.max].forEach((t, i) => {
    const v = int16(t);
    b[6 + 2 * i] = v >> 8;
    b[7 + 2 * i] = v & 255;
  });
  b.set(dateTimeBcd(ms), 12);
  return b;
}

/** Dati di avvio di OB100 (avvio a caldo manuale). */
export function ob100StartInfo(ms: number): Uint8Array {
  const b = new Uint8Array(START_INFO_BYTES);
  b.set([0x13, 0x81, 27, 100, 0, 0]);
  b.set(dateTimeBcd(ms), 12);
  return b;
}

/** Dati di avvio dai primi 12 byte (nella forma di `OB_DEFINITIONS`) e dall'istante, in BCD. */
function startInfo(head: number[], ms: number): Uint8Array {
  const b = new Uint8Array(START_INFO_BYTES);
  b.set(head.map((x) => x & 255));
  b.set(dateTimeBcd(ms), 12);
  return b;
}

const hi = (w: number): number => (w >> 8) & 255;

/** OB35: classe 16#11, STRT_INF 16#36 (⚠️), PHASE_OFFSET 0, EXC_FREQ = intervallo in ms. */
export function ob35StartInfo(intervalMs: number, ms: number): Uint8Array {
  const f = int16(intervalMs);
  return startInfo([0x11, 0x36, 12, 35, 0, 0, 0, 0, 0, 0, hi(f), f], ms);
}

/** OB che ha causato o subito un errore di tempo (OB80_ERR_EV_CLASS/NUM, OB_PRIORITY, OB_NUM). */
export interface ObRef {
  evClass: number;
  evNum: number;
  priority: number;
  ob: number;
}

/** OB80: classe 16#35, FLT_ID (16#01 ciclo, 16#02 OB ancora in corso), ERROR_INFO, OB coinvolto. */
export function ob80StartInfo(
  fltId: number,
  errorInfo: number,
  ref: ObRef,
  ms: number,
): Uint8Array {
  const e = int16(errorInfo);
  return startInfo(
    [0x35, fltId, 26, 80, 0, 0, hi(e), e, ref.evClass, ref.evNum, ref.priority, ref.ob],
    ms,
  );
}

/** OB82: allarme di diagnostica; IO_FLAG 16#54 (ingresso, ⚠️), MDL_DEFECT = evento entrante. */
export function ob82StartInfo(address: number, coming: boolean, ms: number): Uint8Array {
  return startInfo(
    [coming ? 0x39 : 0x38, 0x42, 26, 82, 0, 0x54, hi(address), address, coming ? 1 : 0, 0, 0, 0],
    ms,
  );
}

/** OB86: guasto di una stazione (FLT_ID 16#C4, ⚠️), RACKS_FLTD a zero. */
export function ob86StartInfo(address: number, coming: boolean, ms: number): Uint8Array {
  return startInfo(
    [coming ? 0x39 : 0x38, 0xc4, 26, 86, 0, 0, hi(address), address, 0, 0, 0, 0],
    ms,
  );
}

/** OB85 per un OB d'evento non caricato (FLT_ID 16#A1): classe, numero, priorità e OB richiesti. */
export function ob85StartInfo(missing: ObRef, ms: number): Uint8Array {
  return startInfo(
    [0x35, 0xa1, 26, 85, 0, 0, 0, 0, missing.evClass, missing.evNum, missing.priority, missing.ob],
    ms,
  );
}

/** Tipo del blocco nei dati di avvio di OB121/OB122 (BLK_TYPE): OB 16#88, DB 16#8A, FC 16#8C, FB 16#8E. */
const BLK_TYPE: Record<string, number> = { OB: 0x88, DB: 0x8a, FC: 0x8c, FB: 0x8e };

/** Blocco e istruzione interrotti da un errore sincrono. */
export interface FaultSite {
  /** Priorità del blocco interrotto. */
  priority: number;
  blockKind: string;
  blockNumber: number;
  /** Offset MC7 dell'istruzione (PRG_ADDR). */
  offset: number;
}

/** OB121: classe 16#25, SW_FLT, FLT_REG (DB, T, C o blocco), blocco e offset. */
export function ob121StartInfo(
  swFlt: number,
  faultReg: number,
  at: FaultSite,
  ms: number,
): Uint8Array {
  return startInfo(
    [
      0x25,
      swFlt,
      at.priority,
      121,
      BLK_TYPE[at.blockKind] ?? 0,
      0,
      hi(faultReg),
      faultReg,
      hi(at.blockNumber),
      at.blockNumber,
      hi(at.offset),
      at.offset,
    ],
    ms,
  );
}

/**
 * OB122: classe 16#29, SW_FLT 16#42/16#43; MEM_AREA = tipo d'accesso nei bit 4–7 (0 bit, 1 byte, 2
 * parola, 3 doppia) e area nei bit 0–3 (0 = periferia, ⚠️); MEM_ADDR = indirizzo in byte.
 */
export function ob122StartInfo(
  swFlt: number,
  periphery: { byte: number; width: number },
  at: FaultSite,
  ms: number,
): Uint8Array {
  const kind = periphery.width === 4 ? 3 : periphery.width === 2 ? 2 : 1;
  return startInfo(
    [
      0x29,
      swFlt,
      at.priority,
      122,
      BLK_TYPE[at.blockKind] ?? 0,
      kind << 4,
      hi(periphery.byte),
      periphery.byte,
      hi(at.blockNumber),
      at.blockNumber,
      hi(at.offset),
      at.offset,
    ],
    ms,
  );
}
