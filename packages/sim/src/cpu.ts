import { readBlockFile } from '@baaportal/mc7';
import { diagFromError, type DiagEntry } from './diagnostics';
import { SimError } from './errors';
import { runBlock, type ExecContext } from './executor';
import { Program } from './program';
import { SimMemory, memorySizesFor } from './memory';
import { ob100StartInfo, ob1StartInfo } from './obStartInfo';
import { newRegisters } from './registers';

export type SimMode = 'STOP' | 'STARTUP' | 'RUN';

/** Proprietà della CPU che servono al simulatore (stessa forma di `CpuProperties`, senza dipendere da `project`). */
export interface SimCpuProps {
  maxCycleMs: number;
  minCycleMs: number;
  clockMemory: { enabled: boolean; byte: number };
  /** Ritentività: numero di MB, di temporizzatori e di contatori ritentivi, contati da 0. */
  retentivity: { mBytes: number; timers: number; counters: number };
}

export interface SimCpuOptions {
  cpuTypeId: string;
  props: SimCpuProps;
  /** Orologio in ms (iniettabile nei test). */
  now?: () => number;
}

export type SimEvent =
  | { type: 'mode'; mode: SimMode }
  | { type: 'diagnostic'; entry: DiagEntry }
  | { type: 'cycle'; result: CycleResult };

export interface CycleResult {
  ok: boolean;
  error?: DiagEntry;
  elapsedMs: number;
}

/** Aree T e C riservate (le istruzioni arrivano nel piano 2B): un valore a 16 bit per elemento. */
const TIMER_COUNT = 2048;
const COUNTER_COUNT = 2048;

/** Periodo in ms dei bit 0..7 del merker di clock (manuale CPU 31x: 10, 5, 2.5, 2, 1.25, 1, 0.625, 0.5 Hz). */
const CLOCK_PERIODS_MS = [100, 200, 400, 500, 800, 1000, 1600, 2000];

export class SimCpu {
  readonly memory: SimMemory;
  readonly program = new Program();
  /** Temporizzatori e contatori: solo strutture riservate, usate da avvio e cancellazione totale. */
  readonly timers = new Uint16Array(TIMER_COUNT);
  readonly counters = new Uint16Array(COUNTER_COUNT);

  private readonly props: SimCpuProps;
  private now: () => number;
  private _mode: SimMode = 'STOP';
  private readonly diag: DiagEntry[] = [];
  private readonly listeners = new Set<(e: SimEvent) => void>();
  private st = { last: 0, min: 0, max: 0, cycles: 0 };
  private firstCycle = true;

  constructor(o: SimCpuOptions) {
    this.props = o.props;
    this.now = o.now ?? (() => Date.now());
    this.memory = new SimMemory(memorySizesFor(o.cpuTypeId));
  }

  get mode(): SimMode {
    return this._mode;
  }

  get diagnostics(): readonly DiagEntry[] {
    return this.diag;
  }

  stats(): { last: number; min: number; max: number; cycles: number } {
    return { ...this.st };
  }

  onEvent(cb: (e: SimEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  loadBlock(file: Uint8Array): void {
    const f = readBlockFile(file);
    if (f.header.kind === 'DB') {
      // Dati attuali = sezione MC7 del file; a questi si torna con la cancellazione totale.
      this.memory.dbs.set(f.header.number, {
        data: f.mc7.slice(),
        initial: f.mc7.slice(),
        retentive: false,
      });
      return;
    }
    this.program.load(file);
  }

  deleteBlock(kind: string, number: number): void {
    if (kind === 'DB') this.memory.dbs.delete(number);
    else this.program.delete(kind, number);
  }

  /** STOP → avvio a caldo → RUN. Un errore in OB100 lascia la CPU in STOP. */
  run(): void {
    if (this._mode !== 'STOP') return;
    this.setMode('STARTUP');
    this.record({ time: this.now(), code: 'AVVIO' });
    this.warmRestart();
    if (this.program.get('OB', 100)) {
      const t = this.now();
      const ctx = this.newContext(t);
      ctx.mem.L.set(ob100StartInfo(t));
      try {
        runBlock(ctx, 'OB', 100);
      } catch (e) {
        this.fail(e);
        return;
      }
    }
    this.firstCycle = true;
    this.setMode('RUN');
  }

  stop(reason?: string): void {
    if (this._mode === 'STOP') return;
    this.record({
      time: this.now(),
      code: 'STOP_RICHIESTO',
      ...(reason !== undefined ? { detail: reason } : {}),
    });
    this.toStop();
  }

  /** Cancellazione totale (solo in STOP): la memoria di caricamento (blocchi) resta. */
  memoryReset(): void {
    if (this._mode !== 'STOP') throw new Error('la cancellazione totale richiede la CPU in STOP');
    const m = this.memory;
    m.I.fill(0);
    m.Q.fill(0);
    m.M.fill(0);
    m.physOut.fill(0);
    this.timers.fill(0);
    this.counters.fill(0);
    for (const db of m.dbs.values()) db.data.set(db.initial);
    this.st = { last: 0, min: 0, max: 0, cycles: 0 };
    this.record({ time: this.now(), code: 'CANCELLAZIONE_TOTALE' });
  }

  /** Un ciclo OB1 completo; in STOP non fa niente. */
  cycle(): CycleResult {
    if (this._mode !== 'RUN') return { ok: true, elapsedMs: 0 };
    if (!this.program.get('OB', 1)) return { ok: true, elapsedMs: 0 };
    const start = this.now();
    const m = this.memory;
    this.updateClock(start);
    m.I.set(m.physIn);
    const ctx = this.newContext(start);
    ctx.mem.L.set(
      ob1StartInfo(
        this.firstCycle,
        { prev: this.st.last, min: this.st.min, max: this.st.max },
        start,
      ),
    );
    try {
      runBlock(ctx, 'OB', 1);
    } catch (e) {
      const entry = this.fail(e);
      const result: CycleResult = { ok: false, error: entry, elapsedMs: this.now() - start };
      this.emit({ type: 'cycle', result });
      return result;
    }
    m.physOut.set(m.Q);
    this.firstCycle = false;
    const elapsedMs = this.now() - start;
    const s = this.st;
    s.last = elapsedMs;
    s.min = s.cycles === 0 ? elapsedMs : Math.min(s.min, elapsedMs);
    s.max = Math.max(s.max, elapsedMs);
    s.cycles++;
    const result: CycleResult = { ok: true, elapsedMs };
    this.emit({ type: 'cycle', result });
    return result;
  }

  private newContext(cycleStart: number): ExecContext {
    const ctx: ExecContext = {
      mem: this.memory,
      regs: newRegisters(),
      program: this.program,
      now: this.now,
      maxCycleMs: this.props.maxCycleMs,
      cycleStart,
      onTick: () => {
        const t = this.now();
        if (t - cycleStart > this.props.maxCycleMs)
          throw new SimError('TEMPO_CICLO_SUPERATO', `oltre ${this.props.maxCycleMs} ms`);
        this.updateClock(t);
      },
    };
    return ctx;
  }

  /** Avvio a caldo: azzera ciò che non è ritentivo e le immagini di processo; i DB restano. */
  private warmRestart(): void {
    const { mBytes, timers, counters } = this.props.retentivity;
    const m = this.memory;
    m.I.fill(0);
    m.Q.fill(0);
    m.M.fill(0, Math.max(0, mBytes));
    this.timers.fill(0, Math.max(0, timers));
    this.counters.fill(0, Math.max(0, counters));
  }

  /** Il byte del merker di clock riflette l'orologio: bit n alto nella seconda metà del periodo. */
  private updateClock(t: number): void {
    const c = this.props.clockMemory;
    if (!c.enabled || c.byte < 0 || c.byte >= this.memory.M.length) return;
    let v = 0;
    CLOCK_PERIODS_MS.forEach((p, bit) => {
      if (Math.floor(t / (p / 2)) % 2 === 1) v |= 1 << bit;
    });
    this.memory.M[c.byte] = v;
  }

  /** Errore di programmazione: voce di diagnostica e STOP. */
  private fail(e: unknown): DiagEntry {
    if (!(e instanceof SimError)) throw e;
    const entry = diagFromError(this.now(), e);
    this.record(entry);
    this.toStop();
    return entry;
  }

  private toStop(): void {
    // In STOP le uscite della periferia sono disattivate.
    this.memory.physOut.fill(0);
    this.setMode('STOP');
  }

  private record(entry: DiagEntry): void {
    this.diag.push(entry);
    this.emit({ type: 'diagnostic', entry });
  }

  private setMode(mode: SimMode): void {
    if (this._mode === mode) return;
    this._mode = mode;
    this.emit({ type: 'mode', mode });
  }

  private emit(e: SimEvent): void {
    for (const cb of [...this.listeners]) cb(e);
  }
}
