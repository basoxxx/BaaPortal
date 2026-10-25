import type { StoreApi } from 'zustand/vanilla';
import type { BaaBridge } from '../bridge';
import type { AppState } from '../state/store';
import type { DiagPart, PlcClockRequest, PlcDiagData } from './plcTypes';

export type DiagPage = 'general' | 'buffer' | 'cycle' | 'memory' | 'clock';

/** Parti di ogni pagina; `mode` e `leds` si chiedono sempre, per l'intestazione. */
export const PAGE_PARTS: Record<DiagPage, DiagPart[]> = {
  general: ['identity', 'protection', 'lastModeChange', 'memory'],
  buffer: ['buffer'],
  cycle: ['cycle'],
  memory: ['memory'],
  clock: ['clock'],
};

export interface DiagState {
  data: Partial<PlcDiagData>;
  /** Istante (ms) dell'ultima risposta, per confrontare l'ora della CPU con quella del PC. */
  readAt: number;
  /** L'interrogazione si è fermata per questo motivo (collegamento perso). */
  error?: string;
  running: boolean;
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  now(): number;
}

const REAL_TIMERS: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

const PERIOD_MS = 1000;

export type ClockOutcome =
  { kind: 'ok' } | { kind: 'cancelled' } | { kind: 'error'; message: string };

/**
 * Interrogazione periodica della diagnostica: una richiesta alla volta, la successiva 1 s dopo la
 * fine della precedente. Si ferma da sola se il collegamento si perde e non riparte: la riavvia
 * chi ha l'editor aperto (`start`).
 */
export class DiagController {
  private state: DiagState = { data: {}, readAt: 0, running: false };
  private listeners = new Set<() => void>();
  private page: DiagPage = 'general';
  private frozen = false;
  private identityDone = false;
  private timer: unknown;
  private inFlight = false;
  private again = false;
  private session = 0;
  private unsub: (() => void) | undefined;

  constructor(
    private readonly store: StoreApi<AppState>,
    private readonly bridge: BaaBridge,
    private readonly timers: Timers = REAL_TIMERS,
  ) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getState = (): DiagState => this.state;

  private set(patch: Partial<DiagState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of [...this.listeners]) fn();
  }

  partsFor(): DiagPart[] {
    const own = PAGE_PARTS[this.page].filter(
      (p) => !(p === 'identity' && this.identityDone) && !(p === 'buffer' && this.frozen),
    );
    return [...new Set<DiagPart>(['mode', 'leds', ...own])];
  }

  start(): void {
    if (this.state.running) return;
    this.session++;
    this.identityDone = false;
    this.state = { data: {}, readAt: 0, running: true };
    for (const fn of [...this.listeners]) fn();
    this.unsub = this.store.subscribe((s) => {
      if (s.online.status !== 'on') this.stop();
    });
    void this.tick(this.session);
  }

  stop(): void {
    if (!this.state.running) return;
    this.session++;
    this.again = false;
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
    this.unsub?.();
    this.unsub = undefined;
    this.set({ running: false });
  }

  setPage(page: DiagPage): void {
    if (page === this.page) return;
    this.page = page;
    this.readNow();
  }

  setFrozen(frozen: boolean): void {
    this.frozen = frozen;
    if (!frozen) this.readNow();
  }

  /** Rilegge subito (cambio di pagina, ora appena scritta) senza sovrapporsi a una richiesta in corso. */
  readNow(): void {
    if (!this.state.running) return;
    if (this.inFlight) {
      this.again = true;
      return;
    }
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
    void this.tick(this.session);
  }

  private async tick(session: number): Promise<void> {
    if (session !== this.session) return;
    if (this.store.getState().online.status !== 'on') {
      this.stop();
      return;
    }
    this.timer = undefined;
    this.inFlight = true;
    let result: Awaited<ReturnType<BaaBridge['plcDiagnostics']>>;
    try {
      result = await this.bridge.plcDiagnostics(this.partsFor());
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    this.inFlight = false;
    if (session !== this.session) return;
    if (!result.ok) {
      this.set({ error: result.error });
      this.stop();
      return;
    }
    const data = { ...this.state.data } as Record<string, unknown>;
    for (const [k, v] of Object.entries(result.data)) {
      if (k === 'buffer' && this.frozen) continue;
      data[k] = v;
    }
    if (result.data.identity) this.identityDone = true;
    this.set({ data: data as Partial<PlcDiagData>, readAt: this.timers.now() });
    if (this.again) {
      this.again = false;
      void this.tick(session);
      return;
    }
    this.timer = this.timers.set(() => void this.tick(session), PERIOD_MS);
  }

  /** «Imposta ora»: la conferma è nel processo principale; un esito positivo rilegge subito l'ora. */
  async setClock(req: PlcClockRequest): Promise<ClockOutcome> {
    let r: Awaited<ReturnType<BaaBridge['plcSetClock']>>;
    try {
      r = await this.bridge.plcSetClock(req);
    } catch (e) {
      return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
    }
    if (r.ok) {
      this.readNow();
      return { kind: 'ok' };
    }
    return 'cancelled' in r ? { kind: 'cancelled' } : { kind: 'error', message: r.error };
  }
}
