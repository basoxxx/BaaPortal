import { maxBlockStatusLines } from '@baaportal/s7comm';
import { findDevice } from '@baaportal/project';
import type { StoreApi } from 'zustand/vanilla';
import type { BaaBridge } from '../bridge';
import type { LineMapRow } from '../editors/awl/monitorExtension';
import { monitorStillShown, plcMonitorReasonOf } from '../sim/monitorStatus';
import type { AppState, PlcMonitorReason } from '../state/store';
import { signatureOf } from './compare';
import type { Timers } from './diagController';
import type { PlcStatusRequest, PlcStatusStartResult } from './plcTypes';

export { monitorLinesFromPlc } from '../editors/awl/monitorExtension';

const REAL_TIMERS: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/** Ritmo delle letture (dalla fine della precedente) e minimo fra due cambi di finestra (ms). */
export const PLC_MONITOR_PERIOD_MS = 250;
/** PDU supposta prima della start (la CPU concede 240 byte, di solito); `start` dà il limite vero. */
const DEFAULT_PDU = 240;

/** Prima riga visibile dentro una rete lunga (SCL: la prima riga AWL delle righe SCL in vista). */
export type WindowFrom = { network: number; line: number };

/**
 * Finestra di osservazione: le istruzioni delle reti visibili, dalla prima (o da `from`), al
 * massimo `maxLines`. `saz` è l'offset dell'istruzione dopo l'ultima scelta, oppure la lunghezza MC7.
 */
export function windowFor(
  lineMap: readonly LineMapRow[],
  visibleNetworks: readonly number[],
  maxLines: number,
  mc7Length?: number,
  from?: WindowFrom,
): { offsets: number[]; saz: number } {
  const all = [...new Set(lineMap.map((r) => r.offset))].sort((a, b) => a - b);
  const shown = new Set(visibleNetworks);
  const after = (r: LineMapRow) =>
    !from || r.network > from.network || (r.network === from.network && r.line >= from.line);
  const want = [
    ...new Set(lineMap.filter((r) => shown.has(r.network) && after(r)).map((r) => r.offset)),
  ]
    .sort((a, b) => a - b)
    .slice(0, Math.max(0, maxLines));
  const last = want.at(-1);
  if (last === undefined) return { offsets: [], saz: 0 };
  const next = all.find((o) => o > last);
  const end = lineMap.reduce((m, r) => Math.max(m, r.offset + r.length), 0);
  return { offsets: want, saz: next ?? mc7Length ?? end };
}

/** Dati del blocco osservato, presi dallo stato (iniettabile nei test). */
export interface PlcMonitorInput {
  reason: 'ok' | 'stale' | 'noLines';
  type: 'OB' | 'FB' | 'FC';
  number: number;
  signature?: { checksum: number; mc7Length: number };
  lineMap: LineMapRow[];
  /** Chiave che cambia quando il compilato cambia (per riprovare dopo un rifiuto). */
  key: string;
}

export type PlcMonitorResolve = (
  s: AppState,
  deviceId: string,
  blockId: string,
) => PlcMonitorInput | undefined;

export const resolvePlcMonitor: PlcMonitorResolve = (s, deviceId, blockId) => {
  if (!monitorStillShown(s, deviceId, blockId)) return undefined;
  const b = s.doc && findDevice(s.doc.project, deviceId)?.blocks.find((x) => x.id === blockId);
  if (!b || (b.kind !== 'OB' && b.kind !== 'FB' && b.kind !== 'FC')) return undefined;
  const file = s.compile.files[blockId];
  const signature = file ? signatureOf(file) : undefined;
  return {
    reason: plcMonitorReasonOf(s, deviceId, blockId),
    type: b.kind,
    number: b.number,
    ...(signature ? { signature } : {}),
    lineMap: s.compile.lines[blockId] ?? [],
    key: s.compile.hashes[blockId] ?? '',
  };
};

const REMOTE_REASONS: readonly PlcMonitorReason[] = [
  'different',
  'missing',
  'unsupported',
  'busy',
  'ended',
];

/**
 * Osservazione del blocco aperto sulla CPU: avvia il job nel processo principale, legge ogni
 * 250 ms dalla fine della lettura precedente (mai due insieme), segue le reti visibili e le
 * caselle ACCU2/AR1, e chiama sempre `plcStatusStop` quando finisce.
 */
export class PlcMonitorController {
  private spec: { deviceId: string; blockId: string } | null = null;
  private epoch = 0;
  private remote = false;
  private starting = false;
  private edited = false;
  private visible: number[] | null = null;
  private from: WindowFrom | undefined;
  private pduLength = 240;
  private sentKey = '';
  /** Offset della finestra chiesta alla CPU (le righe grigie quando non arrivano risultati). */
  private offsets: number[] = [];
  /** Righe concesse dalla CPU se le visibili sono di più (altrimenti `undefined`). */
  private clip: number | undefined;
  private lastWindowAt = -Infinity;
  private timer: unknown;
  private windowTimer: unknown;
  private blockedKey: string | undefined;
  /** Il confronto con la CPU al momento del rifiuto: se cambia (blocco caricato) si riprova. */
  private blockedCompare: unknown;
  private unsub: (() => void) | undefined;

  constructor(
    private readonly store: StoreApi<AppState>,
    private readonly bridge: BaaBridge,
    private readonly timers: Timers = REAL_TIMERS,
    private readonly resolve: PlcMonitorResolve = resolvePlcMonitor,
  ) {}

  /** Accende l'osservazione del blocco, o la spegne se è già accesa su quel blocco. */
  toggle(deviceId: string, blockId: string): void {
    const m = this.store.getState().online.monitor;
    if (m && m.reason !== 'ended') {
      this.stop();
      return;
    }
    this.stop();
    if (this.store.getState().online.status !== 'on') return;
    this.spec = { deviceId, blockId };
    this.edited = false;
    this.from = undefined;
    this.blockedKey = undefined;
    this.patch({
      monitor: { deviceId, blockId, reason: 'stale' },
      monitorLines: null,
      monitorRegs: this.store.getState().online.monitorRegs ?? { accu2: false, ar1: false },
    });
    this.unsub = this.store.subscribe(() => this.sync());
    this.sync();
  }

  /** Spegne: ferma letture e job, e toglie lo stato. */
  stop(): void {
    const had = this.spec !== null;
    const needStop = this.remote || this.starting;
    this.epoch++;
    this.remote = false;
    this.starting = false;
    this.spec = null;
    this.sentKey = '';
    this.unsub?.();
    this.unsub = undefined;
    if (this.timer !== undefined) this.timers.clear(this.timer);
    if (this.windowTimer !== undefined) this.timers.clear(this.windowTimer);
    this.timer = this.windowTimer = undefined;
    if (needStop) void Promise.resolve(this.bridge.plcStatusStop()).catch(() => undefined);
    if (had || this.store.getState().online.monitor) {
      this.patch({ monitor: null, monitorLines: null });
    }
  }

  /**
   * Reti visibili del blocco (indici da 0) e, in una rete lunga, la prima riga in vista; la finestra
   * segue, al più una volta ogni 250 ms.
   */
  setVisible(blockId: string, networks: number[], from?: WindowFrom): void {
    if (this.spec?.blockId !== blockId) return;
    const same =
      this.visible &&
      this.visible.length === networks.length &&
      this.visible.every((n, i) => n === networks[i]) &&
      this.from?.network === from?.network &&
      this.from?.line === from?.line;
    if (same) return;
    this.visible = networks;
    this.from = from;
    this.sync();
    this.scheduleWindow();
  }

  /** Il testo del blocco ha (o non ha più) modifiche non confermate. */
  setEdited(blockId: string, edited: boolean): void {
    if (this.spec?.blockId !== blockId || this.edited === edited) return;
    this.edited = edited;
    this.sync();
  }

  setRegs(regs: { accu2: boolean; ar1: boolean }): void {
    this.patch({ monitorRegs: regs });
    this.scheduleWindow();
  }

  private patch(p: Partial<AppState['online']>): void {
    this.store.getState().patchOnline(p);
  }

  private setMonitor(
    reason: PlcMonitorReason,
    extra: { message?: string; partial?: boolean } = {},
  ) {
    const m = this.store.getState().online.monitor;
    if (!this.spec || !m) return;
    const limit = reason === 'ok' ? this.clip : undefined;
    if (
      m.reason === reason &&
      m.message === extra.message &&
      m.partial === extra.partial &&
      m.limit === limit
    )
      return;
    this.patch({
      monitor: {
        deviceId: this.spec.deviceId,
        blockId: this.spec.blockId,
        reason,
        ...(extra.message !== undefined ? { message: extra.message } : {}),
        ...(extra.partial ? { partial: true } : {}),
        ...(limit !== undefined ? { limit } : {}),
      },
    });
  }

  private mask(): number {
    const r = this.store.getState().online.monitorRegs;
    return 0x03 | (r?.accu2 ? 0x04 : 0) | (r?.ar1 ? 0x08 : 0);
  }

  private visibleOf(): number[] {
    return this.visible ?? [];
  }

  /** Allinea l'osservazione allo stato dell'applicazione. */
  private sync(): void {
    const spec = this.spec;
    if (!spec) return;
    const st = this.store.getState();
    if (st.online.status !== 'on') {
      this.stop();
      return;
    }
    const input = this.resolve(st, spec.deviceId, spec.blockId);
    if (!input) {
      this.stop();
      return;
    }
    const base = this.edited ? 'edited' : input.reason;
    if (base !== 'ok') {
      this.dropRemote();
      this.setMonitor(base);
      return;
    }
    // Nessuna riga in vista: non c'è un job da tenere, e non si dice «osservazione attiva»
    if (
      this.visible !== null &&
      windowFor(input.lineMap, this.visible, 1, undefined, this.from).offsets.length === 0
    ) {
      this.dropRemote();
      this.setMonitor('noVisible');
      return;
    }
    const cur = st.online.monitor?.reason;
    if (cur && REMOTE_REASONS.includes(cur)) {
      // rifiutato o finito: si riprova solo se il compilato è cambiato
      if (this.blockedKey === input.key && this.blockedCompare === st.online.compare) return;
      this.blockedKey = undefined;
    }
    if (
      cur === 'stale' ||
      cur === 'noLines' ||
      cur === 'edited' ||
      cur === 'noVisible' ||
      cur === undefined
    ) {
      this.setMonitor('ok');
    }
    if (!this.remote && !this.starting) void this.startRemote(input);
  }

  /** Ferma il job senza spegnere l'osservazione (testo in modifica, compilato superato). */
  private dropRemote(): void {
    if (!this.remote && !this.starting) return;
    this.epoch++;
    this.remote = false;
    this.starting = false;
    this.sentKey = '';
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
    void Promise.resolve(this.bridge.plcStatusStop()).catch(() => undefined);
    this.patch({ monitorLines: null });
  }

  private requestFor(
    input: PlcMonitorInput,
    max: number,
  ): { req: PlcStatusRequest; key: string; clipped: boolean } | undefined {
    // Senza reti visibili note (la vista non ha ancora riferito) non si parte.
    if (!input.signature || this.visible === null) return undefined;
    const w = windowFor(input.lineMap, this.visibleOf(), max, input.signature.mc7Length, this.from);
    if (w.offsets.length === 0) return undefined;
    const mask = this.mask();
    const total = windowFor(input.lineMap, this.visibleOf(), Infinity, undefined, this.from).offsets
      .length;
    return {
      clipped: total > w.offsets.length,
      req: {
        type: input.type,
        number: input.number,
        expect: input.signature,
        offsets: w.offsets,
        saz: w.saz,
        mask,
      },
      key: `${w.offsets.join(',')}|${w.saz}|${mask}`,
    };
  }

  private async startRemote(input: PlcMonitorInput): Promise<void> {
    // già tagliata per la PDU di 240 byte: main non deve accorciare né ricreare il job
    const built = this.requestFor(input, maxBlockStatusLines(DEFAULT_PDU, this.mask()));
    if (!built) return; // nessuna istruzione visibile: si aspetta
    const epoch = ++this.epoch;
    this.starting = true;
    let r: PlcStatusStartResult;
    try {
      r = await this.bridge.plcStatusStart(built.req);
    } catch (e) {
      r = { ok: false, reason: 'error', error: e instanceof Error ? e.message : String(e) };
    }
    if (epoch !== this.epoch) {
      if (r.ok) void Promise.resolve(this.bridge.plcStatusStop()).catch(() => undefined);
      return;
    }
    this.starting = false;
    if (!r.ok) {
      this.blockedKey = input.key;
      this.blockedCompare = this.store.getState().online.compare;
      const reason: PlcMonitorReason =
        r.reason === 'different' ||
        r.reason === 'missing' ||
        r.reason === 'unsupported' ||
        r.reason === 'busy'
          ? r.reason
          : 'ended';
      this.setMonitor(reason, { message: r.error });
      return;
    }
    this.remote = true;
    this.pduLength = r.pduLength;
    this.sentKey = '';
    // la finestra chiesta può essere più larga di quanto la CPU concede: si riduce subito
    const fit = this.requestFor(input, maxBlockStatusLines(r.pduLength, built.req.mask));
    if (fit && fit.key !== built.key) await this.sendWindow(fit.req, fit.key, epoch);
    else {
      this.sentKey = built.key;
      this.offsets = built.req.offsets;
    }
    this.clip = (fit ?? built).clipped ? (fit ?? built).req.offsets.length : undefined;
    if (epoch === this.epoch) void this.poll(epoch);
  }

  private async sendWindow(req: PlcStatusRequest, key: string, epoch: number): Promise<void> {
    this.sentKey = key;
    this.offsets = req.offsets;
    this.lastWindowAt = this.timers.now();
    // finché la CPU non risponde sulla nuova finestra, i valori vecchi non valgono più
    this.patch({
      monitorLines: req.offsets.map((offset) => ({ offset, regs: null })),
      monitorLinesUnsure: true,
    });
    let ok = true;
    try {
      const r = await this.bridge.plcStatusWindow(req);
      ok = r.ok;
    } catch {
      ok = false;
    }
    if (!ok && epoch === this.epoch) this.sentKey = ''; // si riprova alla prossima occasione
  }

  /** Cambio di finestra: subito se è passato abbastanza, altrimenti alla scadenza dei 250 ms. */
  private scheduleWindow(): void {
    if (!this.remote || this.windowTimer !== undefined) return;
    const wait = this.lastWindowAt + PLC_MONITOR_PERIOD_MS - this.timers.now();
    const run = (): void => {
      this.windowTimer = undefined;
      void this.applyWindow();
    };
    if (wait <= 0) run();
    else this.windowTimer = this.timers.set(run, wait);
  }

  private async applyWindow(): Promise<void> {
    const spec = this.spec;
    if (!spec || !this.remote) return;
    const input = this.resolve(this.store.getState(), spec.deviceId, spec.blockId);
    if (!input) return;
    const built = this.requestFor(input, maxBlockStatusLines(this.pduLength, this.mask()));
    if (!built || built.key === this.sentKey) return;
    await this.sendWindow(built.req, built.key, this.epoch);
    this.clip = built.clipped ? built.req.offsets.length : undefined;
  }

  private async poll(epoch: number): Promise<void> {
    if (epoch !== this.epoch || !this.remote) return;
    let r: Awaited<ReturnType<BaaBridge['plcStatusRead']>>;
    try {
      r = await this.bridge.plcStatusRead();
    } catch (e) {
      r = { ok: false, ended: true, error: e instanceof Error ? e.message : String(e) };
    }
    if (epoch !== this.epoch) return;
    if (!r.ok) {
      const input =
        this.spec && this.resolve(this.store.getState(), this.spec.deviceId, this.spec.blockId);
      this.blockedKey = input ? input.key : undefined;
      this.blockedCompare = this.store.getState().online.compare;
      this.remote = false;
      this.epoch++;
      void Promise.resolve(this.bridge.plcStatusStop()).catch(() => undefined);
      this.setMonitor('ended', { message: r.error });
      this.patch({ monitorLines: null });
      return;
    }
    if (r.state === 'values') {
      this.patch({ monitorLines: r.lines, monitorLinesUnsure: r.partial === true });
      this.setMonitor('ok', r.partial ? { partial: true } : {});
    } else if (r.state === 'stop') {
      this.patch({ monitorLines: null });
      this.setMonitor('stop');
    } else {
      // nessun risultato: le righe della finestra restano, grigie
      const lines = this.offsets.map((offset) => ({ offset, regs: null }));
      this.patch({ monitorLines: lines, monitorLinesUnsure: true });
      this.setMonitor('waiting');
    }
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      void this.poll(epoch);
    }, PLC_MONITOR_PERIOD_MS);
  }
}

const controllers = new WeakMap<StoreApi<AppState>, PlcMonitorController>();

/** Il controllore del negozio (creato alla prima richiesta; `bridge` conta solo in quel momento). */
export function plcMonitorFor(store: StoreApi<AppState>, bridge: BaaBridge): PlcMonitorController {
  let c = controllers.get(store);
  if (!c) {
    c = new PlcMonitorController(store, bridge);
    controllers.set(store, c);
  }
  return c;
}
