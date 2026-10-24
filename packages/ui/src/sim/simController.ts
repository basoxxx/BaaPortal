import type { StoreApi } from 'zustand/vanilla';
import { findDevice, type PlcDevice } from '@baaportal/project';
import type { SimCpuProps } from '@baaportal/sim';
import type { BaaBridge } from '../bridge';
import { t } from '../i18n';
import { compileProgram, contextHashOf, hashOf } from '../project/compile/compileActions';
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
    // L'API non permette di registrare gli ascoltatori prima di `start`: le notifiche del primo
    // istante (solo STOP) si perdono, la successiva arriva entro 200 ms.
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

  /**
   * Scrive ingressi fisici (`physIn`) dal byte dato. L'immagine locale si aggiorna subito, così
   * clic ravvicinati partono dal valore giusto senza aspettare la prossima notifica.
   */
  async setInputs(byte: number, bytes: Uint8Array): Promise<void> {
    const s = this.session;
    if (!s) return;
    const cur = this.store.getState().sim.inputs;
    if (byte >= 0 && byte + bytes.length <= cur.length) {
      const next = cur.slice();
      next.set(bytes, byte);
      this.store.getState().setSim({ inputs: next });
    }
    try {
      await s.request({ op: 'setInputs', byte, bytes });
    } catch (e) {
      if (this.session === s) this.push('error', 'simInputsFailed', { message: errorText(e) });
    }
  }

  /** «Simula guasto»: allarme di diagnostica (OB82) o guasto del rack (OB86) del modulo `address`. */
  async interrupt(ob: 82 | 86, address: number): Promise<void> {
    const s = this.session;
    if (!s) return;
    try {
      await s.request({ op: 'interrupt', ob, address });
    } catch (e) {
      if (this.session === s) this.push('error', 'simInterruptFailed', { message: errorText(e) });
    }
  }

  /** Cancellazione totale (MRES): solo in STOP, dopo conferma. Il worker la rifiuta fuori da STOP. */
  async memoryReset(ctx: SimCtx): Promise<void> {
    const s = this.session;
    if (!s || this.store.getState().sim.mode !== 'STOP') return;
    let yes: boolean;
    try {
      yes = await ctx.bridge.askQuestion({
        title: t('sim.mresTitle'),
        message: t('sim.mresMessage'),
        yes: t('sim.yes'),
        no: t('sim.no'),
      });
    } catch {
      return;
    }
    if (!yes || this.session !== s) return;
    try {
      await s.request({ op: 'mres' });
    } catch (e) {
      if (this.session === s) this.push('error', 'simMresFailed', { message: errorText(e) });
    }
  }

  /** "Carica nel dispositivo" sul simulatore. */
  async download(ctx: SimCtx): Promise<void> {
    const s = this.session;
    const sim = this.store.getState().sim;
    if (!s || sim.phase !== 'on' || !sim.deviceId || sim.downloading || getProgress()) return;
    this.store.getState().setSim({ downloading: true });
    try {
      await this.downloadTo(s, sim.deviceId, ctx);
    } finally {
      // se nel frattempo la sessione è finita, lo stato è già stato azzerato
      if (this.session === s) this.store.getState().setSim({ downloading: false });
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
    if (compile.interrupted) return;
    if (compile.summary.errors > 0) {
      this.push('error', 'simDownloadBlocked', { errors: String(compile.summary.errors) });
      return;
    }
    // Si carica solo ciò che è stato compilato con il contenuto e il contesto di adesso: una
    // compilazione interrotta da un'eccezione lascia blocchi vecchi, che non vanno caricati.
    const context = contextHashOf(dev);
    const items = dev.blocks.map((b) => ({
      kind: b.kind,
      number: b.number,
      file: compile.hashes[b.id] === hashOf(b, context) ? compile.files[b.id] : undefined,
    }));
    const stale = items.filter((i) => !i.file).length;
    if (stale > 0) {
      this.push('error', 'simDownloadStale', { count: String(stale) });
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
    if (this.session !== s) return;
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
