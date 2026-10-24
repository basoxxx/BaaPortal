import { SimError } from './errors';

export type TimerKind = 'SP' | 'SE' | 'SD' | 'SS' | 'SF';
export type TimerBase = 10 | 100 | 1000 | 10000;

/** Stato di un temporizzatore S5 (manuale AWL S7-300/400, operazioni di temporizzazione). */
export interface S5Timer {
  running: boolean;
  /** Bit di stato (uscita Q) all'ultimo aggiornamento; `TimerBank.q` lo porta all'istante corrente. */
  q: boolean;
  startedAt: number;
  /** Tempo impostato in ms (valore · base). */
  preset: number;
  base: TimerBase;
  /** Ultimo RLO visto da un'istruzione di avvio (memoria del fronte). */
  edge: boolean;
  /** Tipo dell'ultimo avvio: decide che cosa succede alla scadenza. */
  kind: TimerKind;
  /** Memoria del fronte di FR. */
  frEdge: boolean;
  /** Valore residuo (unità) da fermo; ignorato mentre il temporizzatore corre. */
  frozen: number;
}

const BASES: readonly TimerBase[] = [10, 100, 1000, 10000];

function idle(): S5Timer {
  return {
    running: false,
    q: false,
    startedAt: 0,
    preset: 0,
    base: 10,
    edge: false,
    kind: 'SP',
    frEdge: false,
    frozen: 0,
  };
}

/**
 * Valore S5TIME (ACCU1-L): bit 12–13 base (10 ms, 100 ms, 1 s, 10 s), bit 0–11 tre cifre BCD.
 * Una cifra oltre 9 è un errore di programmazione (BCD non valido).
 */
export function decodeS5Time(word: number): { units: number; base: TimerBase } {
  const d2 = (word >> 8) & 15;
  const d1 = (word >> 4) & 15;
  const d0 = word & 15;
  if (d2 > 9 || d1 > 9 || d0 > 9) throw new SimError('BCD_NON_VALIDO', `S5TIME ${word & 0xffff}`);
  return { units: d2 * 100 + d1 * 10 + d0, base: BASES[(word >> 12) & 3]! };
}

/** Banco dei temporizzatori: il tempo viene solo da `now`, iniettato (nessun timer di sistema). */
export class TimerBank {
  private readonly timers: S5Timer[];

  constructor(
    readonly count: number,
    private readonly now: () => number,
  ) {
    this.timers = Array.from({ length: count }, idle);
  }

  get(n: number): S5Timer {
    if (!Number.isInteger(n) || n < 0 || n >= this.count)
      throw new SimError('NUMERO_TEMPORIZZATORE', `T ${n}`);
    return this.timers[n]!;
  }

  private units(t: S5Timer): number {
    if (!t.running) return t.frozen;
    const elapsed = Math.floor((this.now() - t.startedAt) / t.base);
    return Math.max(0, t.preset / t.base - elapsed);
  }

  /** Porta il temporizzatore all'istante corrente: alla scadenza smette di correre e fissa Q. */
  private settle(t: S5Timer): void {
    if (!t.running || this.units(t) > 0) return;
    t.running = false;
    t.frozen = 0;
    // Impulsi (SP, SE) e ritardo alla disinserzione (SF) finiscono a 0; SD e SS a 1.
    t.q = t.kind === 'SD' || t.kind === 'SS';
  }

  /** Bit di stato all'istante corrente. */
  q(n: number): boolean {
    const t = this.get(n);
    this.settle(t);
    return t.q;
  }

  /** Valore residuo in unità della base e base in ms. */
  value(n: number): { units: number; base: number } {
    const t = this.get(n);
    this.settle(t);
    return { units: this.units(t), base: t.base };
  }

  /** Valore BCD con la base nei bit 12–13 (come `LC`). */
  bcd(n: number): number {
    const { units, base } = this.value(n);
    const bcd =
      ((Math.floor(units / 100) % 10) << 8) | ((Math.floor(units / 10) % 10) << 4) | (units % 10);
    return (BASES.indexOf(base as TimerBase) << 12) | bcd;
  }

  private start(t: S5Timer, kind: TimerKind, s5time: number): void {
    const { units, base } = decodeS5Time(s5time);
    t.kind = kind;
    t.base = base;
    t.preset = units * base;
    t.startedAt = this.now();
    t.running = true;
    t.frozen = 0;
  }

  private stop(t: S5Timer): void {
    t.frozen = this.units(t);
    t.running = false;
  }

  /**
   * Istruzione di avvio (SP, SE, SD, SS, SF) con l'RLO e l'S5TIME di ACCU1. Parte sul fronte di
   * salita dell'RLO (SF: di discesa), o con RLO attivo se FR ha riabilitato l'avvio.
   */
  startOp(n: number, kind: TimerKind, rlo: boolean, s5time: number): void {
    const t = this.get(n);
    this.settle(t);
    const risen = rlo && !t.edge;
    const fallen = !rlo && t.edge;
    t.edge = rlo;
    switch (kind) {
      case 'SP':
        if (risen) {
          this.start(t, kind, s5time);
          t.q = true;
        } else if (!rlo && t.running) {
          // Impulso: con RLO = 0 si ferma e Q torna a 0.
          this.stop(t);
          t.q = false;
        }
        break;
      case 'SE':
        if (risen) {
          // Impulso prolungato: un nuovo fronte durante l'impulso lo riavvia.
          this.start(t, kind, s5time);
          t.q = true;
        }
        break;
      case 'SD':
        if (risen) {
          this.start(t, kind, s5time);
          t.q = false;
        } else if (!rlo) {
          if (t.running) this.stop(t);
          t.q = false;
        }
        break;
      case 'SS':
        if (risen) {
          // ⚠️ Un riavvio con Q già a 1 lascia Q a 1 fino a R.
          const q = t.q;
          this.start(t, kind, s5time);
          t.q = q;
        }
        break;
      case 'SF':
        if (rlo) {
          // Con RLO = 1, Q = 1; un ritardo in corso si ferma.
          if (t.running) this.stop(t);
          t.q = true;
        } else if (fallen) {
          this.start(t, kind, s5time);
          t.q = true;
        } else t.q = t.running;
        break;
    }
  }

  /**
   * `FR`: sul fronte di salita dell'RLO cancella la memoria del fronte di avvio, così un RLO a 1
   * riavvia SP, SE, SD, SS senza un nuovo fronte. Per SF, che parte sul fronte di discesa, non
   * cambia niente (con RLO = 0 non riparte).
   */
  enable(n: number, rlo: boolean): void {
    const t = this.get(n);
    if (rlo && !t.frEdge) t.edge = false;
    t.frEdge = rlo;
  }

  /** `R`: con RLO = 1 ferma il temporizzatore, azzera valore e Q. */
  resetOp(n: number, rlo: boolean): void {
    const t = this.get(n);
    if (!rlo) return;
    t.running = false;
    t.frozen = 0;
    t.q = false;
    t.base = 10;
    t.preset = 0;
  }

  /** Riporta a riposo i temporizzatori da `from` in su (avvio a caldo, cancellazione totale). */
  reset(from: number): void {
    for (let i = Math.max(0, from); i < this.count; i++) this.timers[i] = idle();
  }
}
