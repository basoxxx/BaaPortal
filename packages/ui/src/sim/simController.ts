import type { StoreApi } from 'zustand/vanilla';
import { findCpu, findIoModule } from '@baaportal/catalog';
import {
  findDevice,
  findWatchTable,
  watchResolverFor,
  type HwModule,
  type PlcDevice,
  type WatchTable,
} from '@baaportal/project';
import type { MonitorRequest, SimCpuProps, SimIoModule } from '@baaportal/sim';
import type { BaaBridge } from '../bridge';
import { t } from '../i18n';
import { hashOf } from '../project/compile/compileActions';
import { prepareCompiledBlocks } from '../project/compile/downloadFiles';
import { targetPlcId } from '../project/navigation/treeIds';
import { getProgress } from '../project/progress';
import {
  planCommand,
  resolveRows,
  watchPlan,
  type WatchRowError,
} from '../editors/watch/watchRows';
import { SIM_OFF, type AppState } from '../state/store';
import { downloadOrder } from './downloadOrder';
import { activeCodeBlock, codeBlockOf, monitorReasonOf, monitorStillShown } from './monitorStatus';
import {
  MAX_WATCH_ITEMS,
  type WatchItem,
  type WatchValue,
  type WriteItemReq,
  type WriteResult,
} from './protocol';
import { SimSession, type SimSessionOptions } from './session';
import { watchStillShown } from './watchStatus';

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

/** Salva nel dispositivo le preferenze del pannello di test (una voce di cronologia se cambiano). */
function saveSimPanel(
  store: StoreApi<AppState>,
  deviceId: string | null | undefined,
  patch: NonNullable<PlcDevice['simPanel']>,
): void {
  const st = store.getState();
  if (!deviceId || !st.doc || !findDevice(st.doc.project, deviceId)) return;
  st.edit('history.simPanel', (p) => {
    const d = findDevice(p, deviceId);
    if (d) d.simPanel = { ...d.simPanel, ...patch };
  });
}

/** Esadecimale/decimale dell'osservazione: subito nello stato e nel progetto del dispositivo. */
export function setMonitorHex(
  store: StoreApi<AppState>,
  deviceId: string | null | undefined,
  hex: boolean,
): void {
  store.getState().setSim({ monitorHex: hex });
  saveSimPanel(store, deviceId, { hex });
}

/** Byte aggiunto a mano al pannello I/O («+ byte»), salvato anche nel progetto. */
export function addIoByte(
  store: StoreApi<AppState>,
  dir: 'inputs' | 'outputs',
  byte: number,
): void {
  const sim = store.getState().sim;
  if (sim.ioExtra[dir].includes(byte)) return;
  const ioExtra = { ...sim.ioExtra, [dir]: [...sim.ioExtra[dir], byte] };
  store.getState().setSim({ ioExtra });
  saveSimPanel(store, sim.deviceId, { [dir]: ioExtra[dir] });
}

/**
 * Moduli di I/O della configurazione hardware (rack e stazioni ET 200) per il simulatore; vuoto se
 * non ce n'è nessuno (progetti senza configurazione: tutto il campo della CPU).
 */
export function simIoOf(dev: PlcDevice): SimIoModule[] {
  const out: SimIoModule[] = [];
  const add = (m: HwModule, station?: number) => {
    const type = findIoModule(m.orderNumber);
    if (!type) return;
    const range = (start: number | undefined, bytes: number) =>
      start !== undefined && bytes > 0 ? { start, bytes } : undefined;
    const inputs = range(m.inputStart, type.inputBytes);
    const outputs = range(m.outputStart, type.outputBytes);
    if (!inputs && !outputs) return;
    out.push({
      id: m.id,
      name: m.name,
      rack: m.rack,
      slot: m.slot,
      ...(station !== undefined ? { station } : {}),
      ...(inputs ? { inputs } : {}),
      ...(outputs ? { outputs } : {}),
    });
  };
  for (const m of dev.hardware?.modules ?? []) add(m);
  for (const st of dev.hardware?.stations ?? [])
    for (const m of st.modules) add(m, st.address ?? 0);
  return out;
}

/**
 * Governa la sessione del simulatore di un negozio: la crea solo quando si accende Simulazione,
 * la spegne chiudendo o cambiando progetto (e alla chiusura della finestra).
 */
export class SimController {
  private session: SimSession | undefined;
  /** Cresce a ogni spegnimento: un avvio ancora in corso, se è cambiato, si scarta. */
  private generation = 0;
  /** `setInputs` in volo: finché ce ne sono, gli `inputs` delle notifiche (possibili copie vecchie) si ignorano. */
  private inputsInFlight = 0;
  /** Il blocco che il worker osserva adesso (`FC5`…), o niente. */
  private sentMonitor: string | undefined;
  /** Il blocco la cui ultima richiesta di osservazione è stata rifiutata (segnalato una volta). */
  private failedMonitor: string | undefined;
  /** Ciò da cui dipende il motivo di indisponibilità, per non ricalcolare l'impronta a ogni notifica. */
  private reasonInputs: unknown[] = [];
  /** Le voci che il worker osserva adesso (testo JSON), o niente. */
  private sentWatch: string | undefined;
  /** Righe a cui corrispondono, per posizione, le voci osservate. */
  private watchRowIds: string[] = [];
  /** La voce (testo JSON) mandata per ciascuna riga: i valori di una voce cambiata non valgono più. */
  private watchItemOfRow = new Map<string, string>();
  /** Richieste `watch` in volo: finché ce ne sono, le notifiche (di voci vecchie) si scartano. */
  private watchInFlight = 0;
  /** Le voci la cui ultima richiesta è stata rifiutata (segnalato una volta). */
  private failedWatch: string | undefined;
  /** Piani già calcolati per tabella (oggetti immutabili: una tabella cambiata è un oggetto nuovo). */
  private watchPlanFor = new WeakMap<
    WatchTable,
    { dev: PlcDevice; rowIds: string[]; items: WatchItem[] }
  >();

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
    store.subscribe(() => {
      this.syncMonitor();
      this.syncWatch();
      this.syncProps();
    });
  }

  /** Proprietà della CPU mandate al worker (oggetto immutabile del progetto). */
  private sentProps: PlcDevice['properties'] | undefined;

  /** Le proprietà della CPU simulata cambiate nel progetto valgono subito (tempo di ciclo, clock, OB35). */
  private syncProps(): void {
    const s = this.session;
    const st = this.store.getState();
    if (!s || st.sim.phase !== 'on' || !st.doc || !st.sim.deviceId) return;
    const dev = findDevice(st.doc.project, st.sim.deviceId);
    if (!dev || dev.properties === this.sentProps) return;
    this.sentProps = dev.properties;
    s.request({ op: 'props', props: simPropsOf(dev) }).catch((e: unknown) => {
      if (this.session === s) this.push('error', 'simModeFailed', { message: errorText(e) });
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
    } else if (this.store.getState().online.status !== 'off') {
      this.push('warning', 'simBlockedByOnline');
    } else await this.startSession();
  }

  private async startSession(): Promise<void> {
    const state = this.store.getState();
    const doc = state.doc;
    const target = targetPlcId(state);
    const dev = doc && target ? findDevice(doc.project, target) : undefined;
    if (!dev) return;
    const gen = ++this.generation;
    // Preferenze del pannello salvate nel progetto (assenti nei file precedenti).
    state.setSim({
      ...SIM_OFF,
      phase: 'starting',
      deviceId: dev.id,
      monitorHex: dev.simPanel?.hex ?? true,
      ioExtra: { inputs: dev.simPanel?.inputs ?? [], outputs: dev.simPanel?.outputs ?? [] },
    });
    let session: SimSession;
    try {
      session = await (this.deps.start ?? SimSession.start)({
        cpuTypeId: dev.cpu.typeId,
        props: simPropsOf(dev),
        io: simIoOf(dev),
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
    this.sentProps = dev.properties;
    this.inputsInFlight = 0;
    this.sentMonitor = undefined;
    this.sentWatch = undefined;
    this.watchItemOfRow = new Map();
    this.watchInFlight = 0;
    this.failedWatch = undefined;
    session.onNotice((n) => {
      if (this.session !== session) return;
      if (n.kind === 'watch') {
        // Valori di voci non più osservate (o appena cambiate): si scartano.
        if (
          this.watchInFlight === 0 &&
          this.sentWatch !== undefined &&
          n.values.length === this.watchRowIds.length
        ) {
          this.store.getState().setSim({
            watchValues: Object.fromEntries(this.watchRowIds.map((id, i) => [id, n.values[i]!])),
          });
        }
        return;
      }
      if (n.kind === 'monitor') {
        // Una notifica di un blocco non più osservato (o appena cambiato) si scarta.
        if (this.sentMonitor === `${n.block.kind}${n.block.number}`)
          this.store.getState().setSim({ monitorSteps: n.steps });
        return;
      }
      if (n.kind !== 'status') return;
      this.store.getState().setSim({
        mode: n.mode,
        stats: n.stats,
        diagnostics: n.diagnostics,
        warnings: n.warnings,
        ...(this.inputsInFlight > 0 ? {} : { inputs: n.inputs }),
        outputs: n.outputs,
        forces: n.forces,
        pulled: n.pulled,
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
    this.sentMonitor = undefined;
    this.sentWatch = undefined;
    s?.dispose();
    if (this.store.getState().sim.phase !== 'off') this.store.getState().setSim(SIM_OFF);
  }

  async setMode(to: 'RUN' | 'STOP'): Promise<void> {
    const s = this.session;
    if (!s) return;
    try {
      await s.request({ op: 'mode', to });
    } catch (e) {
      if (this.session !== s) return;
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
    this.inputsInFlight++;
    try {
      await s.request({ op: 'setInputs', byte, bytes });
    } catch (e) {
      if (this.session === s) this.push('error', 'simInputsFailed', { message: errorText(e) });
    } finally {
      if (this.session === s) this.inputsInFlight--;
    }
  }

  /** Estrae o reinserisce un modulo della configurazione (OB82, OB86 per una stazione). */
  async setModulePresent(id: string, present: boolean): Promise<void> {
    const s = this.session;
    if (!s) return;
    try {
      await s.request({ op: 'module', id, present });
    } catch (e) {
      if (this.session === s) this.push('error', 'simInterruptFailed', { message: errorText(e) });
    }
  }

  /** Sostituisce la tabella di forzamento della CPU simulata (vuota = termina il forzamento). */
  async setForce(items: WriteItemReq[]): Promise<void> {
    const s = this.session;
    if (!s) return;
    try {
      await s.request({ op: 'force', items });
    } catch (e) {
      if (this.session === s) this.push('error', 'simForceFailed', { message: errorText(e) });
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

  /** «Osserva»: accende l'osservazione del blocco aperto, o la spegne. */
  toggleMonitor(): void {
    const st = this.store.getState();
    if (st.sim.monitor) {
      st.setSim({ monitor: null, monitorSteps: null });
      return;
    }
    const a = activeCodeBlock(st);
    if (!a) return;
    st.setSim({
      monitor: {
        deviceId: a.deviceId,
        blockId: a.blockId,
        reason: monitorReasonOf(st, a.deviceId, a.blockId),
        edited: false,
      },
      monitorSteps: null,
    });
  }

  /**
   * Allinea il worker allo stato dell'osservazione: la ferma se l'editor non è più visibile,
   * aggiorna il motivo di indisponibilità quando cambiano progetto, caricamenti o compilazione, e
   * chiede al worker il blocco giusto (o nessuno).
   */
  private syncMonitor(): void {
    const st = this.store.getState();
    const m = st.sim.monitor;
    if (m && !monitorStillShown(st, m.deviceId, m.blockId)) {
      st.setSim({ monitor: null, monitorSteps: null });
      return; // lo stato è cambiato: la sottoscrizione richiama questa funzione
    }
    let want: MonitorRequest | undefined;
    if (m) {
      const inputs = [st.doc, st.sim.loaded, st.compile, m.blockId];
      if (inputs.some((x, i) => x !== this.reasonInputs[i])) {
        this.reasonInputs = inputs;
        const reason = monitorReasonOf(st, m.deviceId, m.blockId);
        if (reason !== m.reason) {
          st.setSim({ monitor: { ...m, reason }, monitorSteps: null });
          return;
        }
      }
      if (m.reason === 'ok') {
        const a = codeBlockOf(st, m.deviceId, m.blockId);
        const b =
          st.doc && findDevice(st.doc.project, m.deviceId)?.blocks.find((x) => x.id === m.blockId);
        // SCL: l'ultima esecuzione nel ciclo, come la CPU (in un ciclo si vede l'ultimo giro)
        const last = b?.kind !== 'DB' && b?.kind !== 'IDB' && b?.language === 'SCL';
        if (a) want = { kind: a.kind, number: a.number, ...(last ? { last: true } : {}) };
      }
    } else this.reasonInputs = [];
    const key = want ? `${want.kind}${want.number}` : undefined;
    const s = this.session;
    if (!s || key === this.sentMonitor) return;
    this.sentMonitor = key;
    if (!want && st.sim.monitorSteps) st.setSim({ monitorSteps: null });
    const req = s.request({ op: 'monitor', ...(want ? { block: want } : {}) });
    const done = () => {
      if (this.failedMonitor === key) this.failedMonitor = undefined;
    };
    const fail = (e: unknown) => {
      if (this.session !== s) return;
      // La richiesta non è arrivata: alla prossima occasione si riprova.
      if (this.sentMonitor === key) this.sentMonitor = undefined;
      // Il messaggio una sola volta per blocco: il nuovo tentativo può ripetersi a ogni notifica.
      if (this.failedMonitor === key) return;
      this.failedMonitor = key;
      this.push('error', 'simMonitorFailed', { message: errorText(e) });
    };
    req.then(done, fail);
  }

  /** «Osserva tutto» di una tabella di controllo: accende l'osservazione, o la spegne se già accesa. */
  toggleWatch(deviceId: string, tableId: string): void {
    const st = this.store.getState();
    if (st.sim.phase !== 'on' || st.sim.deviceId !== deviceId) return;
    const on = st.sim.watch.some((w) => w.deviceId === deviceId && w.tableId === tableId);
    // Più tabelle osservano insieme (come online): «Osserva tutto» accende o spegne solo questa.
    st.setSim({
      watch: on
        ? st.sim.watch.filter((w) => !(w.deviceId === deviceId && w.tableId === tableId))
        : [...st.sim.watch, { deviceId, tableId }],
    });
  }

  /** Piano di osservazione della tabella (righe con operando risolto e formato adatto). */
  private planOf(dev: PlcDevice, table: WatchTable) {
    const cached = this.watchPlanFor.get(table);
    if (cached && cached.dev === dev) return cached;
    const resolve = watchResolverFor(dev, findCpu(dev.cpu.typeId));
    const infos = resolveRows(resolve, table.rows);
    const plan = { dev, ...watchPlan(table.rows, (row) => infos.get(row.id)!) };
    this.watchPlanFor.set(table, plan);
    return plan;
  }

  /**
   * Allinea il worker all'osservazione della tabella di controllo: la ferma se la tabella non è più
   * visibile, e quando le righe cambiano manda le voci nuove (le notifiche arrivano su richiesta).
   */
  private syncWatch(): void {
    const st = this.store.getState();
    const tables = st.sim.watch.map((w) => {
      const dev = st.doc ? findDevice(st.doc.project, w.deviceId) : undefined;
      const table = dev ? findWatchTable(dev, w.tableId) : undefined;
      return dev && table && watchStillShown(st, w.deviceId, w.tableId)
        ? { dev, table }
        : undefined;
    });
    if (tables.some((x) => !x)) {
      const watch = st.sim.watch.filter((_, i) => tables[i]);
      st.setSim({ watch, ...(watch.length === 0 ? { watchValues: null } : {}) });
      return; // lo stato è cambiato: la sottoscrizione richiama questa funzione
    }
    // Le voci delle tabelle in fila, nell'ordine di accensione (gli id di riga sono unici).
    const plans = tables.map((x) => this.planOf(x!.dev, x!.table));
    const plan =
      plans.length > 0
        ? {
            // shortcut: oltre MAX_WATCH_ITEMS in tutto le righe in più restano senza valore, senza errore di riga.
            rowIds: plans.flatMap((p) => p.rowIds).slice(0, MAX_WATCH_ITEMS),
            items: plans.flatMap((p) => p.items).slice(0, MAX_WATCH_ITEMS),
          }
        : undefined;
    const key = plan ? JSON.stringify(plan.items) : undefined;
    const s = this.session;
    if (!s) return;
    if (plan) this.watchRowIds = plan.rowIds;
    if (key === this.sentWatch) return;
    this.sentWatch = key;
    // Cambiata la voce di una riga (MW10 → MD10) il suo vecchio valore ha un'altra lunghezza: si toglie.
    const nextItems = new Map(plan?.rowIds.map((id, i) => [id, JSON.stringify(plan.items[i])]));
    const old = st.sim.watchValues;
    if (old) {
      const kept = Object.fromEntries(
        Object.entries(old).filter(
          ([id]) => nextItems.has(id) && nextItems.get(id) === this.watchItemOfRow.get(id),
        ),
      );
      st.setSim({ watchValues: Object.keys(kept).length > 0 ? kept : null });
    }
    this.watchItemOfRow = nextItems;
    this.watchInFlight++;
    s.request({ op: 'watch', items: plan?.items ?? [] }).then(
      () => {
        if (this.session !== s) return;
        this.watchInFlight--;
        if (this.failedWatch === key) this.failedWatch = undefined;
      },
      (e: unknown) => {
        if (this.session !== s) return;
        this.watchInFlight--;
        // La richiesta non è arrivata: alla prossima occasione si riprova.
        if (this.sentWatch === key) this.sentWatch = undefined;
        // Il messaggio una sola volta per voci: il nuovo tentativo può ripetersi a ogni notifica.
        if (this.failedWatch === key) return;
        this.failedWatch = key;
        this.push('error', 'simWatchFailed', { message: errorText(e) });
      },
    );
  }

  /**
   * «Comanda»: scrive una volta i valori di comando delle righe valide; gli errori (di riga o del
   * simulatore) tornano per riga e non bloccano le altre. `null` se la simulazione non c'è.
   */
  async commandWatch(
    deviceId: string,
    tableId: string,
  ): Promise<{ errors: Record<string, WatchRowError>; written: number } | null> {
    const s = this.session;
    const st = this.store.getState();
    const dev = st.doc && findDevice(st.doc.project, deviceId);
    const table = dev && findWatchTable(dev, tableId);
    if (!s || !dev || !table || st.sim.deviceId !== deviceId) return null;
    const resolve = watchResolverFor(dev, findCpu(dev.cpu.typeId));
    const infos = resolveRows(resolve, table.rows);
    const plan = planCommand(table.rows, (row) => infos.get(row.id)!);
    const errors = { ...plan.errors };
    let written = 0;
    if (plan.writes.length > 0) {
      let results: WriteResult[] | undefined;
      let failure: string | undefined;
      try {
        results = await s.request<WriteResult[]>({
          op: 'write',
          items: plan.writes.map((x) => x.req),
        });
      } catch (e) {
        failure = errorText(e);
      }
      if (this.session !== s) return null;
      if (failure !== undefined) this.push('error', 'simWriteFailed', { message: failure });
      plan.writes.forEach((x, i) => {
        const r = results?.[i];
        if (r && 'ok' in r) written++;
        else {
          const message = failure ?? (r && 'error' in r ? r.error : '');
          errors[x.rowId] = { key: 'HOST', params: { message } };
        }
      });
    }
    return { errors, written };
  }

  /** Legge una volta le voci (runtime HMI); `null` se la simulazione non è di questo PLC. */
  async readItems(deviceId: string, items: WatchItem[]): Promise<WatchValue[] | null> {
    const s = this.session;
    if (!s || this.store.getState().sim.deviceId !== deviceId) return null;
    const values = await s.request<WatchValue[]>({ op: 'read', items });
    return this.session === s ? values : null;
  }

  /** Scrive le voci (runtime HMI); `null` se la simulazione non è di questo PLC. */
  async writeItems(deviceId: string, items: WriteItemReq[]): Promise<WriteResult[] | null> {
    const s = this.session;
    if (!s || this.store.getState().sim.deviceId !== deviceId) return null;
    return s.request<WriteResult[]>({ op: 'write', items });
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
    const prep = await prepareCompiledBlocks(
      ctx,
      deviceId,
      () => this.session === s && store.getState().docLoadId === load,
    );
    if (prep.status === 'aborted') return;
    if (prep.status === 'errors') {
      this.push('error', 'simDownloadBlocked', { errors: String(prep.errors) });
      return;
    }
    if (prep.status === 'stale') {
      this.push('error', 'simDownloadStale', { count: String(prep.count) });
      return;
    }
    const { dev, context } = prep;
    const files = downloadOrder(prep.blocks).map((i) => i.file);
    const wasStopped = store.getState().sim.mode === 'STOP';
    let failure: unknown;
    try {
      const keep = dev.blocks.map((b) => ({
        kind: b.kind === 'IDB' ? ('DB' as const) : b.kind,
        number: b.number,
      }));
      await s.request({ op: 'download', files, keep });
    } catch (e) {
      failure = e;
    }
    if (this.session !== s) return;
    // Caricare un blocco ferma la sua osservazione nel worker: va richiesta di nuovo.
    this.sentMonitor = undefined;
    if (failure !== undefined) {
      this.push('error', 'simDownloadFailed', { message: errorText(failure) });
      this.syncMonitor();
      return;
    }
    store.getState().setSim({
      loaded: Object.fromEntries(dev.blocks.map((b) => [b.id, hashOf(b, context)])),
    });
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
