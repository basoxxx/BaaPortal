import { findCpu } from '@baaportal/catalog';
import { readBlockFile } from '@baaportal/mc7';
import { diagFromError, type DiagEntry } from './diagnostics';
import { SimError } from './errors';
import { runBlock, type ExecContext } from './executor';
import { Program } from './program';
import { SimMemory, memorySizesFor } from './memory';
import { ob100StartInfo, ob1StartInfo } from './obStartInfo';
import { newRegisters } from './registers';
import { CounterBank } from './counters';
import { TimerBank } from './timers';

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
  /** false se la CPU non era in RUN (nessun ciclo eseguito). */
  ran: boolean;
  ok: boolean;
  error?: DiagEntry;
  elapsedMs: number;
}

/** Numero di temporizzatori se la CPU non è nel catalogo (CPU 315-2 PN/DP). */
const DEFAULT_TIMER_COUNT = 256;
/** Numero di contatori se la CPU non è nel catalogo (CPU 315-2 PN/DP). */
const DEFAULT_COUNTER_COUNT = 256;

/** Voci di diagnostica conservate (le più vecchie si perdono). */
const MAX_DIAGNOSTICS = 100;

/** Periodo in ms dei bit 0..7 del merker di clock (manuale delle CPU 31x: 10, 5, 2.5, 2, 1.25, 1, 0.625, 0.5 Hz). */
const CLOCK_PERIODS_MS = [100, 200, 400, 500, 800, 1000, 1600, 2000];

export class SimCpu {
  readonly memory: SimMemory;
  readonly program = new Program();
  /** Temporizzatori e contatori S5 (numero dal catalogo). */
  readonly timers: TimerBank;
  readonly counters: CounterBank;

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
    this.counters = new CounterBank(findCpu(o.cpuTypeId)?.limits.counters ?? DEFAULT_COUNTER_COUNT);
    this.timers = new TimerBank(findCpu(o.cpuTypeId)?.limits.timers ?? DEFAULT_TIMER_COUNT, () =>
      this.now(),
    );
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
    this.st = { last: 0, min: 0, max: 0, cycles: 0 };
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
    this.timers.reset(0);
    this.counters.reset(0);
    for (const db of m.dbs.values()) db.data.set(db.initial);
    this.st = { last: 0, min: 0, max: 0, cycles: 0 };
    this.record({ time: this.now(), code: 'CANCELLAZIONE_TOTALE' });
  }

  /** Un ciclo OB1 completo; in STOP non fa niente. */
  cycle(): CycleResult {
    if (this._mode !== 'RUN') return { ran: false, ok: true, elapsedMs: 0 };
    const start = this.now();
    const m = this.memory;
    this.updateClock(start);
    m.I.set(m.physIn);
    if (!this.program.get('OB', 1)) {
      // Senza OB1 il ciclo gira a vuoto: le immagini di processo si aggiornano lo stesso.
      m.physOut.set(m.Q);
      return { ran: true, ok: true, elapsedMs: 0 };
    }
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
      return this.failedCycle(entry, start);
    }
    const elapsedMs = this.now() - start;
    if (elapsedMs > this.props.maxCycleMs)
      return this.failedCycle(
        this.fail(new SimError('TEMPO_CICLO_SUPERATO', `oltre ${this.props.maxCycleMs} ms`)),
        start,
      );
    m.physOut.set(m.Q);
    this.firstCycle = false;
    const s = this.st;
    s.last = elapsedMs;
    s.min = s.cycles === 0 ? elapsedMs : Math.min(s.min, elapsedMs);
    s.max = Math.max(s.max, elapsedMs);
    s.cycles++;
    const result: CycleResult = { ran: true, ok: true, elapsedMs };
    this.emit({ type: 'cycle', result });
    return result;
  }

  private failedCycle(entry: DiagEntry, start: number): CycleResult {
    const result: CycleResult = {
      ran: true,
      ok: false,
      error: entry,
      elapsedMs: this.now() - start,
    };
    this.emit({ type: 'cycle', result });
    return result;
  }

  private newContext(cycleStart: number): ExecContext {
    const ctx: ExecContext = {
      mem: this.memory,
      regs: newRegisters(),
      program: this.program,
      now: this.now,
      timers: this.timers,
      counters: this.counters,
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
    this.timers.reset(timers);
    this.counters.reset(counters);
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

  /** Qualsiasi errore: voce di diagnostica e STOP; solo i non-SimError (bug) vengono rilanciati. */
  private fail(e: unknown): DiagEntry {
    const entry =
      e instanceof SimError
        ? diagFromError(this.now(), e)
        : {
            time: this.now(),
            code: 'MC7_NON_ESEGUIBILE' as const,
            detail: `errore interno: ${e instanceof Error ? e.message : String(e)}`,
          };
    this.record(entry);
    this.toStop();
    if (!(e instanceof SimError)) throw e;
    return entry;
  }

  private toStop(): void {
    // In STOP le uscite della periferia sono disattivate.
    this.memory.physOut.fill(0);
    this.setMode('STOP');
  }

  private record(entry: DiagEntry): void {
    this.diag.push(entry);
    if (this.diag.length > MAX_DIAGNOSTICS) this.diag.shift();
    this.emit({ type: 'diagnostic', entry });
  }

  private setMode(mode: SimMode): void {
    if (this._mode === mode) return;
    this._mode = mode;
    this.emit({ type: 'mode', mode });
  }

  private emit(e: SimEvent): void {
    for (const cb of [...this.listeners]) {
      try {
        cb(e);
      } catch {
        // Un ascoltatore che lancia non deve interrompere una transizione della CPU.
      }
    }
  }
}
