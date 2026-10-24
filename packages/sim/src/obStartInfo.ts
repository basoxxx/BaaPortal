/**
 * Dati di avvio degli OB (20 byte negli L 0..19), nella forma di `OB_DEFINITIONS[n].startInfo`
 * del catalogo: sei byte (classe, informazione, priorità, numero, due riservati), tre Int (tempo
 * del ciclo precedente, minimo, massimo) e Date_And_Time in BCD (manuale «System Software for
 * S7-300/400 System and Standard Functions», OB1).
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
