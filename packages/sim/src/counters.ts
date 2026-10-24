import { SimError } from './errors';

/** Stato di un contatore S5 (manuale AWL S7-300/400, operazioni di conteggio). */
export interface S5Counter {
  /** Valore 0–999; il bit di stato Q è «valore ≠ 0». */
  value: number;
  /** Memorie del fronte di salita dell'RLO, distinte per CU, CD e S. */
  edgeCu: boolean;
  edgeCd: boolean;
  edgeS: boolean;
  /** Memoria del fronte di FR (la riabilitazione agisce sul fronte di salita). */
  enabled: boolean;
}

const MAX_COUNT = 999;

function idle(): S5Counter {
  return { value: 0, edgeCu: false, edgeCd: false, edgeS: false, enabled: false };
}

/** Valore del contatore da ACCU1-L: tre cifre BCD nei bit 0–11; una cifra oltre 9 è un errore. */
export function decodeCounter(word: number): number {
  const d2 = (word >> 8) & 15;
  const d1 = (word >> 4) & 15;
  const d0 = word & 15;
  if (d2 > 9 || d1 > 9 || d0 > 9)
    throw new SimError('BCD_NON_VALIDO', `contatore ${word & 0xffff}`);
  return d2 * 100 + d1 * 10 + d0;
}

/** Banco dei contatori S5 della CPU. */
export class CounterBank {
  private readonly counters: S5Counter[];

  constructor(readonly count: number) {
    this.counters = Array.from({ length: count }, idle);
  }

  get(n: number): S5Counter {
    if (!Number.isInteger(n) || n < 0 || n >= this.count)
      throw new SimError('NUMERO_CONTATORE', `C ${n}`, { faultReg: n & 0xffff });
    return this.counters[n]!;
  }

  /** Bit di stato: valore ≠ 0. */
  q(n: number): boolean {
    return this.get(n).value !== 0;
  }

  /** Valore binario 0–999 (`L C`). */
  value(n: number): number {
    return this.get(n).value;
  }

  /** Imposta il valore (0–999) senza toccare i fronti. */
  setValue(n: number, v: number): void {
    this.get(n).value = Math.min(MAX_COUNT, Math.max(0, Math.trunc(v)));
  }

  /** Valore in BCD, tre cifre nei bit 0–11 (`LC C`). */
  bcd(n: number): number {
    const v = this.get(n).value;
    return ((Math.floor(v / 100) % 10) << 8) | ((Math.floor(v / 10) % 10) << 4) | (v % 10);
  }

  /** `CU`: sul fronte di salita dell'RLO incrementa, fermandosi a 999. */
  countUp(n: number, rlo: boolean): void {
    const c = this.get(n);
    if (rlo && !c.edgeCu && c.value < MAX_COUNT) c.value++;
    c.edgeCu = rlo;
  }

  /** `CD`: sul fronte di salita dell'RLO decrementa, fermandosi a 0. */
  countDown(n: number, rlo: boolean): void {
    const c = this.get(n);
    if (rlo && !c.edgeCd && c.value > 0) c.value--;
    c.edgeCd = rlo;
  }

  /** `S`: sul fronte di salita dell'RLO carica il valore BCD di ACCU1-L. */
  setOp(n: number, rlo: boolean, accu1: number): void {
    const c = this.get(n);
    if (rlo && !c.edgeS) c.value = decodeCounter(accu1);
    c.edgeS = rlo;
  }

  /** `R`: con RLO = 1 azzera il contatore. */
  resetOp(n: number, rlo: boolean): void {
    const c = this.get(n);
    if (rlo) c.value = 0;
  }

  /**
   * `FR`: sul fronte di salita dell'RLO cancella le memorie dei fronti, così il conteggio o il
   * caricamento successivo con RLO = 1 vale come un fronte (stesso modello dei temporizzatori).
   */
  enable(n: number, rlo: boolean): void {
    const c = this.get(n);
    if (rlo && !c.enabled) {
      c.edgeCu = false;
      c.edgeCd = false;
      c.edgeS = false;
    }
    c.enabled = rlo;
  }

  /** Riporta a riposo i contatori da `from` in su (avvio a caldo, cancellazione totale). */
  reset(from: number): void {
    for (let i = Math.max(0, from); i < this.count; i++) this.counters[i] = idle();
  }
}
