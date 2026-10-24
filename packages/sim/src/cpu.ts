import { findCpu, findSystemBlock } from '@baaportal/catalog';
import { buildSzl, type CpuBackend } from '@baaportal/s7-server';
import { readBlockFile } from '@baaportal/mc7';
import { diagFromError, syntheticEventId, type DiagEntry } from './diagnostics';
import { SimError, StopRequest } from './errors';
import { EVENT, PRIORITY, hwEventId, syncFaultOf, type HwInterrupt } from './events';
import {
  execBlock,
  newExecState,
  type ExecContext,
  type ExecState,
  type MonitorRequest,
  type MonitorSink,
  type MonitorStep,
} from './executor';
import { Program } from './program';
import { SimMemory, memorySizesFor } from './memory';
import {
  ob100StartInfo,
  ob121StartInfo,
  ob122StartInfo,
  ob1StartInfo,
  ob35StartInfo,
  ob80StartInfo,
  ob82StartInfo,
  ob85StartInfo,
  ob86StartInfo,
  type ObRef,
} from './obStartInfo';
import { newRegisters } from './registers';
import { CounterBank } from './counters';
import { TimerBank } from './timers';
import type { SystemServices } from './system/params';
import { simBackend } from './backend';

export type SimMode = 'STOP' | 'STARTUP' | 'RUN';

/** Proprietà della CPU che servono al simulatore (stessa forma di `CpuProperties`, senza dipendere da `project`). */
export interface SimCpuProps {
  maxCycleMs: number;
  minCycleMs: number;
  clockMemory: { enabled: boolean; byte: number };
  /** Ritentività: numero di MB, di temporizzatori e di contatori ritentivi, contati da 0. */
  retentivity: { mBytes: number; timers: number; counters: number };
  /** Intervallo di OB35 in ms (`cyclicInterrupts.ob35Ms`); 0 = nessuna schedulazione. */
  cyclicInterruptMs: number;
}

export interface SimCpuOptions {
  cpuTypeId: string;
  props: SimCpuProps;
  /** Orologio in ms (iniettabile nei test). */
  now?: () => number;
  /** Limite di istruzioni per ciclo (predefinito `MAX_INSTRUCTIONS`; più basso nei test). */
  maxInstructions?: number;
}

/** OB in esecuzione, con la sua classe di priorità. */
interface RunningOb {
  ob: number;
  prio: number;
}

/** Id del suo evento di avvio, per OB80_ERR_EV_CLASS/NUM (⚠️ OB1: 16#1103, OB35: 16#1136). */
function obRef(r: RunningOb | undefined): ObRef {
  if (!r) return { evClass: 0, evNum: 0, priority: 0, ob: 0 };
  const ev = r.ob === 1 ? 0x1103 : r.ob === 35 ? 0x1136 : 0;
  return { evClass: ev >> 8, evNum: ev & 255, priority: r.prio, ob: r.ob };
}

/** Prima scadenza dopo `t` sulla griglia `due + k·interval`. */
function nextDue(due: number, interval: number, t: number): number {
  return due + interval * (Math.floor((t - due) / interval) + 1);
}

export type SimEvent =
  | { type: 'mode'; mode: SimMode }
  | { type: 'diagnostic'; entry: DiagEntry }
  /** Avviso (non un errore): per ora una SFC o un SFB non simulati. */
  | {
      type: 'warning';
      code: 'SFC_NON_SIMULATA' | 'SFB_NON_SIMULATA';
      block: string;
      message: string;
    }
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

/** Numero massimo di DB se la CPU non è nel catalogo. */
const DEFAULT_MAX_DB = 16000;

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
  /** Orologio di sistema: quello iniettato più il tempo di SFC 47 (WAIT), mai indietro. */
  private now: () => number;
  /** Microsecondi di attesa di SFC 47 non ancora trascorsi sull'orologio iniettato. */
  private waitedUs = 0;
  /** Scarto dell'orologio della CPU (data e ora) fissato da SFC 0 (SET_CLK). */
  private clockOffsetMs = 0;
  /** Istante del primo avvio, origine di SFC 64 (TIME_TCK). */
  private bootAt: number | undefined;
  /** SFC e SFB non simulati già segnalati nel periodo di RUN in corso. */
  private readonly warned = new Set<string>();
  private backend: CpuBackend | undefined;
  /** Servizi per le funzioni di sistema (SFC/SFB) in `ExecContext.sys`. */
  private readonly services: SystemServices;
  private _mode: SimMode = 'STOP';
  private readonly diag: DiagEntry[] = [];
  private readonly listeners = new Set<(e: SimEvent) => void>();
  private st = { last: 0, min: 0, max: 0, cycles: 0 };
  private firstCycle = true;
  private readonly maxInstructions: number | undefined;
  /** OB in esecuzione, dal più esterno al più interno. */
  private running: RunningOb[] = [];
  /** OB80 già richiamato per il tempo di ciclo nel ciclo in corso: il secondo sforamento porta in STOP. */
  private overrun = false;
  /** Inizio del controllo del tempo di ciclo (si riparte dopo OB80). */
  private watchdog = 0;
  private ob35Due = 0;
  private ob35Running = false;
  /** Allarmi di diagnostica e guasti in attesa (`raiseInterrupt`). */
  private pending: HwInterrupt[] = [];
  /** Osservazione di un blocco (`setMonitor`); `undefined` = nessuna, costo zero nell'esecutore. */
  private monitor: MonitorSink | undefined;

  constructor(o: SimCpuOptions) {
    this.props = o.props;
    const clock = o.now ?? (() => Date.now());
    this.now = () => clock() + Math.floor(this.waitedUs / 1000);
    this.services = {
      clockMs: () => this.now() + this.clockOffsetMs,
      setClockMs: (ms) => {
        this.clockOffsetMs = ms - this.now();
      },
      tickMs: () => (((this.now() - (this.bootAt ?? 0)) % 2 ** 31) + 2 ** 31) % 2 ** 31,
      wait: (us) => {
        this.waitedUs += us;
      },
      stop: (reason) => {
        throw new StopRequest(reason);
      },
      warnNotSimulated: (kind, number) => this.warnNotSimulated(kind, number),
      szl: (id, index) => buildSzl((this.backend ??= simBackend(this)), id, index),
      sfbState: new Map(),
      maxDb: findCpu(o.cpuTypeId)?.limits.maxDb ?? DEFAULT_MAX_DB,
    };
    this.maxInstructions = o.maxInstructions;
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

  /** Osserva un blocco: dopo ogni ciclo `monitorSnapshot` dà lo stato dopo le sue istruzioni. */
  setMonitor(req: MonitorRequest | undefined): void {
    this.monitor = req
      ? { kind: req.kind, number: req.number, steps: [], seen: new Set() }
      : undefined;
  }

  /**
   * Stato dopo ogni istruzione del blocco osservato, nella **prima** esecuzione dell'ultimo ciclo
   * (⚠️ TIA può mostrare un'altra esecuzione). `undefined` senza osservazione.
   */
  monitorSnapshot(): MonitorStep[] | undefined {
    return this.monitor ? this.monitor.steps.map((s) => ({ ...s })) : undefined;
  }

  /** Il blocco osservato è cambiato o sparito: l'osservazione finisce. */
  private monitorGone(kind: string, number: number): void {
    if (this.monitor?.kind === kind && this.monitor.number === number) this.monitor = undefined;
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
    // Solo a caricamento riuscito: un file respinto lascia il blocco (e l'osservazione) com'erano.
    this.monitorGone(f.header.kind ?? '', f.header.number);
  }

  deleteBlock(kind: string, number: number): void {
    this.monitorGone(kind, number);
    if (kind === 'DB') this.memory.dbs.delete(number);
    else this.program.delete(kind, number);
  }

  /** STOP → avvio a caldo → RUN. Un errore in OB100 lascia la CPU in STOP. */
  run(): void {
    if (this._mode !== 'STOP') return;
    this.setMode('STARTUP');
    const t0 = this.now();
    this.bootAt ??= t0;
    this.warned.clear();
    this.services.sfbState.clear();
    this.record({ time: t0, code: 'AVVIO' });
    this.warmRestart();
    this.pending = [];
    if (this.program.get('OB', 100)) {
      const t = this.now();
      this.watchdog = t;
      const ctx = this.newContext(t);
      try {
        this.runOb(ctx, 100, PRIORITY.OB100, ob100StartInfo(this.stamp(t)));
      } catch (e) {
        if (e instanceof StopRequest) this.stop(e.reason);
        else this.fail(e);
        return;
      }
    }
    this.ob35Due = t0 + this.props.cyclicInterruptMs;
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
    this.services.sfbState.clear();
    for (const db of m.dbs.values()) db.data.set(db.initial);
    this.st = { last: 0, min: 0, max: 0, cycles: 0 };
    this.record({ time: this.now(), code: 'CANCELLAZIONE_TOTALE' });
  }

  /**
   * Richiesta di allarme di diagnostica (OB82) o di guasto (OB86), per il pannello del piano 2C: gira
   * al prossimo tick o inizio ciclo (non in AVVIO). In STOP non succede niente.
   */
  raiseInterrupt(ob: 82 | 86, info: { address?: number; coming?: boolean } = {}): void {
    if (this._mode === 'STOP') return;
    this.pending.push({ ob, address: info.address ?? 0, coming: info.coming ?? true });
  }

  /** Un ciclo OB1 completo, con le interruzioni dovute all'inizio; in STOP non fa niente. */
  cycle(): CycleResult {
    if (this._mode !== 'RUN') return { ran: false, ok: true, elapsedMs: 0 };
    const start = this.now();
    this.watchdog = start;
    this.overrun = false;
    const m = this.memory;
    this.updateClock(start);
    m.I.set(m.physIn);
    if (this.monitor) {
      this.monitor.steps = [];
      this.monitor.seen.clear();
      delete this.monitor.prio;
    }
    const ctx = this.newContext(start);
    let elapsedMs: number;
    try {
      this.serviceInterrupts(ctx, PRIORITY.OB1, start);
      if (!this.program.get('OB', 1)) {
        // Senza OB1 il ciclo gira a vuoto: le immagini di processo si aggiornano lo stesso.
        m.physOut.set(m.Q);
        return { ran: true, ok: true, elapsedMs: 0 };
      }
      this.runOb(
        ctx,
        1,
        PRIORITY.OB1,
        ob1StartInfo(
          this.firstCycle,
          { prev: this.st.last, min: this.st.min, max: this.st.max },
          this.stamp(start),
        ),
      );
      const end = this.now();
      elapsedMs = end - start;
      if (end - this.watchdog > this.props.maxCycleMs)
        this.cycleOverrun(ctx, `oltre ${this.props.maxCycleMs} ms`, elapsedMs, end, {
          ob: 1,
          prio: PRIORITY.OB1,
        });
    } catch (e) {
      if (e instanceof StopRequest) return this.stopRequested(e, start);
      return this.failedCycle(this.fail(e), start);
    }
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

  /** STP dal programma: STOP con la voce `STOP_RICHIESTO`; il ciclo non è un errore. */
  private stopRequested(e: StopRequest, start: number): CycleResult {
    this.stop(e.reason);
    const result: CycleResult = { ran: true, ok: true, elapsedMs: this.now() - start };
    this.emit({ type: 'cycle', result });
    return result;
  }

  /** Avviso «non simulata»: una voce di diagnostica e un evento, una volta per blocco e per periodo di RUN. */
  private warnNotSimulated(kind: 'SFC' | 'SFB', number: number): void {
    const block = `${kind}${number}`;
    if (this.warned.has(block)) return;
    this.warned.add(block);
    const name = findSystemBlock({ kind, number })?.name ?? block;
    const code = kind === 'SFC' ? 'SFC_NON_SIMULATA' : 'SFB_NON_SIMULATA';
    const message = `${kind} ${number} (${name}) non simulata: uscite non scritte, BR = 0`;
    this.record({ time: this.now(), code, detail: message });
    this.emit({ type: 'warning', code, block, message });
  }

  /** Istante sull'orologio della CPU (data e ora di SET_CLK compresi), per i dati di avvio degli OB. */
  private stamp(t: number): number {
    return t + this.clockOffsetMs;
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
    const errorObs = this.program.get('OB', 121) || this.program.get('OB', 122);
    return {
      mem: this.memory,
      sys: this.services,
      regs: newRegisters(),
      program: this.program,
      now: this.now,
      timers: this.timers,
      counters: this.counters,
      maxCycleMs: this.props.maxCycleMs,
      cycleStart,
      ...(this.monitor ? { monitor: this.monitor } : {}),
      ...(this.maxInstructions !== undefined ? { maxInstructions: this.maxInstructions } : {}),
      onTick: (st) => this.tick(st),
      onOverrun: (st, reason) => {
        const t = this.now();
        this.cycleOverrun(st.ctx, reason, t - cycleStart, t);
      },
      // Senza OB121 né OB122 non serve salvare i registri prima di ogni istruzione.
      ...(errorObs ? { onError: (e: SimError, st: ExecState) => this.syncFault(e, st) } : {}),
    };
  }

  /** Esegue un OB nella sua classe di priorità: registri nuovi, stack L della classe da `lBase`. */
  private runOb(
    parent: ExecContext,
    ob: number,
    prio: number,
    startInfo: Uint8Array,
    lBase = 0,
  ): void {
    const block = this.program.get('OB', ob);
    if (!block) throw new SimError('BLOCCO_NON_CARICATO', `OB${ob}`, { missingBlock: 'OB' });
    // Registri propri: quelli del blocco interrotto restano nel suo contesto e si ritrovano al ritorno.
    const sub: ExecContext = { ...parent, regs: newRegisters(), prio };
    const prevL = this.memory.selectL(prio);
    this.running.push({ ob, prio });
    try {
      const L = this.memory.L;
      if (lBase + block.localBytes > L.length)
        throw new SimError('STACK_L_PIENO', `OB${ob}: ${block.localBytes} byte`);
      L.set(startInfo.subarray(0, Math.max(0, L.length - lBase)), lBase);
      execBlock(
        newExecState(sub, block, {
          lBase,
          prevLBase: lBase,
          lSize: block.localBytes,
          prevLSize: 0,
        }),
      );
    } finally {
      this.running.pop();
      this.memory.restoreL(prevL);
      // Le istruzioni dell'OB contano nel limite del ciclo.
      parent.instructions = sub.instructions;
    }
  }

  private currentPrio(): number {
    return this.running.at(-1)?.prio ?? 0;
  }

  private inOb(ob: number): boolean {
    return this.running.some((r) => r.ob === ob);
  }

  /** Ogni `TICK_EVERY` istruzioni: tempo di ciclo, merker di clock, interruzioni dovute. */
  private tick(st: ExecState): void {
    const t = this.now();
    if (t - this.watchdog > this.props.maxCycleMs)
      this.cycleOverrun(st.ctx, `oltre ${this.props.maxCycleMs} ms`, t - st.ctx.cycleStart, t);
    this.updateClock(t);
    this.serviceInterrupts(st.ctx, this.currentPrio(), t);
  }

  /**
   * Interruzioni dovute, se la loro priorità supera quella in corso (`prio`): OB82/OB86 (26), poi OB35
   * (12). Solo in RUN: non in AVVIO.
   */
  private serviceInterrupts(ctx: ExecContext, prio: number, t: number): void {
    if (this._mode !== 'RUN' || prio >= PRIORITY.ASYNC_ERROR) return;
    while (this.pending.length > 0) this.hwInterrupt(ctx, this.pending.shift()!, t);
    const iv = this.props.cyclicInterruptMs;
    if (!(iv > 0) || t < this.ob35Due) return;
    // Scaduto mentre OB35 gira ancora: l'esecuzione richiesta si perde (OB80, 16#3502).
    if (this.ob35Running) return this.ob35Lost(ctx, t);
    if (prio >= PRIORITY.OB35) return;
    this.ob35Due = nextDue(this.ob35Due, iv, t);
    if (!this.program.get('OB', 35)) return;
    this.ob35Running = true;
    try {
      this.runOb(ctx, 35, PRIORITY.OB35, ob35StartInfo(iv, this.stamp(t)));
    } finally {
      this.ob35Running = false;
    }
    const end = this.now();
    if (end >= this.ob35Due) this.ob35Lost(ctx, end);
  }

  private ob35Lost(ctx: ExecContext, t: number): void {
    this.ob35Due = nextDue(this.ob35Due, this.props.cyclicInterruptMs, t);
    this.timeError(
      ctx,
      0x02,
      EVENT.OB_STILL_RUNNING,
      0,
      obRef({ ob: 35, prio: PRIORITY.OB35 }),
      t,
      'OB35 ancora in esecuzione alla scadenza successiva',
    );
  }

  /**
   * Tempo di ciclo superato (orologio o limite di istruzioni). Il primo sforamento del ciclo richiama
   * OB80 e il ciclo continua con il controllo azzerato; il secondo, o senza OB80, o in AVVIO, è STOP.
   */
  private cycleOverrun(
    ctx: ExecContext,
    reason: string,
    cycleMs: number,
    t: number,
    // A fine ciclo nessun OB è in corso: l'OB coinvolto è OB1, che ha appena finito.
    interrupted: RunningOb | undefined = this.running.at(-1),
  ): void {
    if (this._mode !== 'RUN' || this.overrun) throw new SimError('TEMPO_CICLO_SUPERATO', reason);
    this.overrun = true;
    ctx.instructions = 0;
    this.timeError(ctx, 0x01, EVENT.CYCLE_TIME, cycleMs, obRef(interrupted), t, reason);
    this.watchdog = this.now();
  }

  /** Errore di tempo: OB80 se c'è (e non è già in corso), altrimenti STOP. */
  private timeError(
    ctx: ExecContext,
    fltId: number,
    eventId: number,
    errorInfo: number,
    ref: ObRef,
    t: number,
    reason: string,
  ): void {
    if (!this.program.get('OB', 80) || this.inOb(80))
      throw new SimError('TEMPO_CICLO_SUPERATO', reason, { eventId });
    this.record({ time: t, code: 'OB_RICHIAMATO', eventId, detail: `OB80: ${reason}` });
    this.runOb(ctx, 80, PRIORITY.ASYNC_ERROR, ob80StartInfo(fltId, errorInfo, ref, this.stamp(t)));
  }

  /** OB82 o OB86; se manca, OB85 (16#35A1); se manca anche OB85, STOP. */
  private hwInterrupt(ctx: ExecContext, ev: HwInterrupt, t: number): void {
    const id = hwEventId(ev);
    if (this.program.get('OB', ev.ob)) {
      this.record({ time: t, code: 'OB_RICHIAMATO', eventId: id, detail: `OB${ev.ob}` });
      const info =
        ev.ob === 82
          ? ob82StartInfo(ev.address, ev.coming, this.stamp(t))
          : ob86StartInfo(ev.address, ev.coming, this.stamp(t));
      this.runOb(ctx, ev.ob, PRIORITY.ASYNC_ERROR, info);
      return;
    }
    const detail = `OB${ev.ob} non caricato`;
    if (!this.program.get('OB', 85)) throw new SimError('OB_NON_CARICATO', detail);
    this.record({
      time: t,
      code: 'OB_RICHIAMATO',
      eventId: EVENT.OB_NOT_LOADED,
      detail: `OB85: ${detail}`,
    });
    const missing = {
      evClass: id >> 8,
      evNum: id & 255,
      priority: PRIORITY.ASYNC_ERROR,
      ob: ev.ob,
    };
    this.runOb(ctx, 85, PRIORITY.ASYNC_ERROR, ob85StartInfo(missing, this.stamp(t)));
  }

  /**
   * Errore di programmazione o di accesso alla periferia nell'istruzione corrente di `st`: OB121 o
   * OB122 al posto dell'istruzione, nella priorità dell'interrotto e nel suo stack L, sopra la sua
   * finestra. `false` (→ STOP) se l'OB manca, se l'errore non ne ha uno o se si è già in OB121/OB122.
   */
  private syncFault(e: SimError, st: ExecState): boolean {
    const f = syncFaultOf(e);
    if (!f || !this.program.get('OB', f.ob)) return false;
    const top = this.running.at(-1);
    if (!top || top.ob === 121 || top.ob === 122) return false;
    const t = this.now();
    const site = {
      priority: top.prio,
      blockKind: st.block.kind,
      blockNumber: st.block.number,
      offset: st.offset,
    };
    const info =
      f.ob === 121 || !e.periphery
        ? ob121StartInfo(f.swFlt, e.faultReg ?? 0, site, this.stamp(t))
        : ob122StartInfo(f.swFlt, e.periphery, site, this.stamp(t));
    this.record({
      ...diagFromError(t, e),
      code: 'OB_RICHIAMATO',
      eventId: f.eventId,
      detail: `OB${f.ob}: ${e.message}`,
    });
    const lBase = st.frame.lBase + (st.frame.lSize ?? st.block.localBytes);
    this.runOb(st.ctx, f.ob, top.prio, info, lBase);
    return true;
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
            eventId: syntheticEventId('MC7_NON_ESEGUIBILE'),
            detail: `errore interno: ${e instanceof Error ? e.message : String(e)}`,
          };
    const recorded = this.record(entry);
    this.toStop();
    if (!(e instanceof SimError)) throw e;
    return recorded;
  }

  private toStop(): void {
    // In STOP le uscite della periferia sono disattivate.
    this.memory.physOut.fill(0);
    this.pending = [];
    this.setMode('STOP');
  }

  /** Aggiunge una voce; senza `eventId` le si dà quello sintetico del codice. */
  private record(e: Omit<DiagEntry, 'eventId'> & { eventId?: number }): DiagEntry {
    // Il buffer di diagnostica porta l'ora dell'orologio della CPU (SET_CLK compreso).
    const entry: DiagEntry = {
      ...e,
      time: this.stamp(e.time),
      eventId: e.eventId ?? syntheticEventId(e.code),
    };
    this.diag.push(entry);
    if (this.diag.length > MAX_DIAGNOSTICS) this.diag.shift();
    this.emit({ type: 'diagnostic', entry });
    return entry;
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
