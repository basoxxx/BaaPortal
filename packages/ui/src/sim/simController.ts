import type { StoreApi } from 'zustand/vanilla';
import { findDevice, type PlcDevice } from '@baaportal/project';
import type { SimCpuProps } from '@baaportal/sim';
import type { BaaBridge } from '../bridge';
import { t } from '../i18n';
import { compileProgram } from '../project/compile/compileActions';
import { targetPlcId } from '../project/navigation/treeIds';
import { getProgress } from '../project/progress';
import { SIM_OFF, type AppState } from '../state/store';
import { downloadOrder } from './downloadOrder';
import { SimSession, type SimSessionOptions } from './session';

export interface SimCtx {
  store: StoreApi<AppState>;
  bridge: BaaBridge;
}

export interface SimControllerDeps {
  /** Avvio della sessione (i test sostituiscono il worker). */
  start?: (o: SimSessionOptions) => Promise<SimSession>;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Proprietà della CPU del progetto → proprietà della CPU simulata. */
export function simPropsOf(dev: PlcDevice): SimCpuProps {
  const p = dev.properties;
  return {
    maxCycleMs: p.cycle.maxCycleMs,
    minCycleMs: p.cycle.minCycleMs,
    clockMemory: { ...p.clockMemory },
    retentivity: { ...p.retentivity },
    cyclicInterruptMs: p.cyclicInterrupts.ob35Ms,
  };
}

/**
 * Governa la sessione del simulatore di un negozio: la crea solo quando si accende Simulazione,
 * la spegne chiudendo o cambiando progetto (e alla chiusura della finestra).
 */
export class SimController {
  private session: SimSession | undefined;
  /** Cresce a ogni spegnimento: un avvio ancora in corso, se è cambiato, si scarta. */
  private generation = 0;
  private busy = false;

  constructor(
    private readonly store: StoreApi<AppState>,
    private readonly deps: SimControllerDeps,
  ) {
    let load = store.getState().docLoadId;
    store.subscribe((s) => {
      if (s.docLoadId === load) return;
      load = s.docLoadId;
      this.shutdown();
    });
  }

  private push(
    severity: 'info' | 'warning' | 'error',
    key: string,
    params?: Record<string, string>,
  ): void {
    this.store.getState().pushMessage({
      severity,
      textKey: `messages.${key}`,
      ...(params ? { params } : {}),
    });
  }

  async toggle(): Promise<void> {
    const sim = this.store.getState().sim;
    if (sim.phase !== 'off') {
      const wasOn = sim.phase === 'on';
      this.shutdown();
      if (wasOn) this.push('info', 'simStopped');
    } else await this.startSession();
  }

  private async startSession(): Promise<void> {
    const state = this.store.getState();
    const doc = state.doc;
    const target = targetPlcId(state);
    const dev = doc && target ? findDevice(doc.project, target) : undefined;
    if (!dev) return;
    const gen = ++this.generation;
    state.setSim({ ...SIM_OFF, phase: 'starting', deviceId: dev.id });
    let session: SimSession;
    try {
      session = await (this.deps.start ?? SimSession.start)({
        cpuTypeId: dev.cpu.typeId,
        props: simPropsOf(dev),
      });
    } catch (e) {
      if (gen === this.generation) {
        this.store.getState().setSim(SIM_OFF);
        this.push('error', 'simStartFailed', { message: errorText(e) });
      }
      return;
    }
    if (gen !== this.generation) {
      session.dispose(); // spenta mentre partiva
      return;
    }
    this.session = session;
    session.onNotice((n) => {
      if (n.kind !== 'status' || this.session !== session) return;
      this.store.getState().setSim({
        mode: n.mode,
        stats: n.stats,
        diagnostics: n.diagnostics,
        warnings: n.warnings,
        inputs: n.inputs,
        outputs: n.outputs,
      });
    });
    session.onFail((e) => {
      if (this.session !== session) return;
      this.session = undefined;
      this.generation++;
      this.store.getState().setSim(SIM_OFF);
      this.push('error', 'simFailed', { message: errorText(e) });
    });
    this.store.getState().setSim({ phase: 'on' });
    this.push('info', 'simStarted', { name: dev.name });
  }

  /** Spegne la simulazione: il worker termina e lo stato torna spento. */
  shutdown(): void {
    this.generation++;
    const s = this.session;
    this.session = undefined;
    s?.dispose();
    if (this.store.getState().sim.phase !== 'off') this.store.getState().setSim(SIM_OFF);
  }

  async setMode(to: 'RUN' | 'STOP'): Promise<void> {
    const s = this.session;
    if (!s) return;
    try {
      await s.request({ op: 'mode', to });
    } catch (e) {
      this.push('error', 'simModeFailed', { message: errorText(e) });
    }
  }

  /** "Carica nel dispositivo" sul simulatore. */
  async download(ctx: SimCtx): Promise<void> {
    const s = this.session;
    const sim = this.store.getState().sim;
    if (!s || sim.phase !== 'on' || !sim.deviceId || this.busy || getProgress()) return;
    this.busy = true;
    try {
      await this.downloadTo(s, sim.deviceId, ctx);
    } finally {
      this.busy = false;
    }
  }

  private async downloadTo(s: SimSession, deviceId: string, ctx: SimCtx): Promise<void> {
    const { store } = this;
    const load = store.getState().docLoadId;
    await compileProgram(ctx, deviceId, 'changes');
    if (this.session !== s || store.getState().docLoadId !== load) return;
    const { compile, doc } = store.getState();
    const dev = doc && findDevice(doc.project, deviceId);
    if (!dev || !compile.summary) return; // compilazione non eseguita o fallita (già segnalata)
    const items = dev.blocks.map((b) => ({
      kind: b.kind,
      number: b.number,
      file: compile.hashes[b.id] !== undefined ? compile.files[b.id] : undefined,
    }));
    const missing = items.filter((i) => !i.file).length;
    const errors = Math.max(compile.summary.errors, missing);
    if (compile.interrupted || errors > 0) {
      if (!compile.interrupted)
        this.push('error', 'simDownloadBlocked', { errors: String(errors) });
      return;
    }
    const files = downloadOrder(items).map((i) => i.file!);
    const wasStopped = store.getState().sim.mode === 'STOP';
    try {
      await s.request({ op: 'download', files });
    } catch (e) {
      if (this.session === s) this.push('error', 'simDownloadFailed', { message: errorText(e) });
      return;
    }
    this.push('info', 'simDownloaded', { count: String(files.length) });
    if (!wasStopped) return;
    let yes: boolean;
    try {
      yes = await ctx.bridge.askQuestion({
        title: t('sim.startCpuTitle'),
        message: t('sim.startCpuMessage'),
        yes: t('sim.yes'),
        no: t('sim.no'),
      });
    } catch {
      return;
    }
    if (yes && this.session === s) await this.setMode('RUN');
  }
}

const controllers = new WeakMap<StoreApi<AppState>, SimController>();

/** Il controllore del negozio (creato alla prima richiesta; `deps` conta solo in quel momento). */
export function simControllerFor(
  store: StoreApi<AppState>,
  deps: SimControllerDeps = {},
): SimController {
  let c = controllers.get(store);
  if (!c) {
    c = new SimController(store, deps);
    controllers.set(store, c);
  }
  return c;
}

/** Spegne la simulazione se esiste (chiusura della finestra). */
export function shutdownSimulation(store: StoreApi<AppState>): void {
  controllers.get(store)?.shutdown();
}
