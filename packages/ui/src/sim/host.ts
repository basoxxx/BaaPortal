import { parseBlockFile, type S7WriteClient } from '@baaportal/s7comm';
import { SimCpu, connectToSim, type ForceEntry, type MonitorRequest } from '@baaportal/sim';
import {
  INTERRUPT_OBS,
  MAX_WATCH_ITEMS,
  WATCH_SIZES,
  type SimNotice,
  type SimRequest,
  type SimWarning,
  type WatchItem,
  type WatchValue,
  type WriteItemReq,
  type WriteResult,
} from './protocol';

/** Ambiente dell'ospite: tutto ciò che tocca il mondo esterno è iniettato (nessun globale del Worker). */
export interface SimHostEnv {
  post(notice: SimNotice): void;
  /** Orologio in ms (`performance.now()` nel Worker). */
  now(): number;
  /** Pianifica `fn` fra `ms` ms; restituisce l'annullamento. */
  schedule(fn: () => void, ms: number): () => void;
}

/** Intervallo minimo fra due notifiche dello stesso tipo. */
export const NOTICE_INTERVAL_MS = 200;
/** Esecuzione massima prima di cedere il controllo al ciclo degli eventi. */
export const SLICE_MS = 10;
/** Tetto di cicli per fetta, nel caso l'orologio non avanzi. */
const MAX_CYCLES_PER_SLICE = 5000;
const MAX_WARNINGS = 100;
export { MAX_WATCH_ITEMS };

const SIZE_BYTES = { X: 1, B: 1, W: 2, D: 4 } as const;

/** Rifiuta la richiesta se una voce ha una dimensione sconosciuta (il renderer non è fidato). */
function checkSizes(items: readonly WatchItem[]): void {
  for (const it of items)
    if (!(WATCH_SIZES as readonly unknown[]).includes(it.size))
      throw new RangeError(`dimensione non valida: ${String(it.size)}`);
}

/**
 * Ospite della CPU simulata, puro: gira nel Worker (`simWorker.ts`) ma i test lo usano in memoria.
 *
 * Download, RUN e STOP passano per `connectToSim` (stesso percorso di rete di un PLC). Osservazione
 * e scrittura delle variabili leggono e scrivono invece direttamente la memoria della CPU: così
 * valgono anche PQ, T e C come byte grezzi, senza i limiti di PDU, e l'ospite è a thread unico
 * (nessuna corsa col ciclo).
 */
export class SimHost {
  private cpu: SimCpu | undefined;
  private client: S7WriteClient | undefined;
  private dead = false;
  private warnings: SimWarning[] = [];
  private watchItems: WatchItem[] = [];
  private monitorReq: MonitorRequest | undefined;
  private cancelPump: (() => void) | undefined;
  private cancelTick: (() => void) | undefined;
  private nextCycleAt = 0;
  private minCycleMs = 0;
  /** Le richieste si eseguono una alla volta, nell'ordine di arrivo. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly env: SimHostEnv) {}

  /** Esegue una richiesta; l'esito è il valore della risposta, o un'eccezione con il motivo. */
  handle(req: SimRequest): Promise<unknown> {
    const run = this.queue.then(() => this.dispatch(req));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async dispatch(req: SimRequest): Promise<unknown> {
    if (this.dead) throw new Error('simulazione terminata');
    if (req.op === 'start') return this.start(req);
    const cpu = this.cpu;
    if (!cpu || !this.client) throw new Error('simulazione non avviata');
    switch (req.op) {
      case 'download':
        return this.download(req.files, req.keep);
      case 'mode':
        if (req.to === 'RUN') await this.client.start();
        else await this.client.stop();
        return undefined;
      case 'mres':
        cpu.memoryReset();
        this.warnings = [];
        this.sendStatus();
        return undefined;
      case 'setInputs': {
        const buf = cpu.memory.physIn;
        if (!Number.isInteger(req.byte) || req.byte < 0 || req.byte + req.bytes.length > buf.length)
          throw new RangeError(`ingressi fuori area: byte ${req.byte}, ${req.bytes.length} byte`);
        buf.set(req.bytes, req.byte);
        return undefined;
      }
      case 'interrupt':
        if (!(INTERRUPT_OBS as readonly unknown[]).includes(req.ob))
          throw new RangeError(`OB di allarme non supportato: ${String(req.ob)}`);
        if (
          req.address !== undefined &&
          !(Number.isInteger(req.address) && req.address >= 0 && req.address <= 0xffff)
        )
          throw new RangeError(`indirizzo del modulo non valido: ${req.address}`);
        cpu.raiseInterrupt(req.ob, req.address === undefined ? {} : { address: req.address });
        return undefined;
      case 'monitor':
        this.monitorReq = req.block;
        cpu.setMonitor(req.block);
        return undefined;
      case 'watch':
        if (req.items.length > MAX_WATCH_ITEMS)
          throw new RangeError(
            `troppe voci da osservare: ${req.items.length} (al più ${MAX_WATCH_ITEMS})`,
          );
        checkSizes(req.items);
        this.watchItems = req.items;
        return undefined;
      case 'read':
        if (req.items.length > MAX_WATCH_ITEMS)
          throw new RangeError(
            `troppe voci da leggere: ${req.items.length} (al più ${MAX_WATCH_ITEMS})`,
          );
        checkSizes(req.items);
        return req.items.map((it) => this.readOne(cpu, it));
      case 'write':
        if (req.items.length > MAX_WATCH_ITEMS)
          throw new RangeError(
            `troppe voci da scrivere: ${req.items.length} (al più ${MAX_WATCH_ITEMS})`,
          );
        checkSizes(req.items);
        return req.items.map((it) => this.writeOne(cpu, it));
      case 'force':
        if (req.items.length > MAX_WATCH_ITEMS)
          throw new RangeError(`troppe voci da forzare: ${req.items.length}`);
        checkSizes(req.items);
        for (const it of req.items)
          if (it.area !== 'I' && it.area !== 'Q' && it.area !== 'M')
            throw new RangeError(`area non forzabile: ${String(it.area)}`);
        // La CPU convalida indirizzi e lunghezze e rifiuta tutta la tabella se una voce è sbagliata.
        cpu.setForce(req.items as ForceEntry[]);
        this.sendStatus();
        return undefined;
      case 'stop':
        await this.shutdown();
        return undefined;
    }
  }

  private async start(req: Extract<SimRequest, { op: 'start' }>): Promise<void> {
    if (this.cpu) throw new Error('simulazione già avviata');
    this.minCycleMs = req.props.minCycleMs;
    const cpu = new SimCpu({ cpuTypeId: req.cpuTypeId, props: req.props, now: this.env.now });
    cpu.onEvent((e) => {
      if (e.type === 'mode') {
        this.sendStatus(); // subito a ogni cambio di modo
        if (e.mode === 'RUN') {
          this.warnings = [];
          this.nextCycleAt = this.env.now();
          this.kickPump();
        }
      } else if (e.type === 'warning') {
        if (this.warnings.length < MAX_WARNINGS)
          this.warnings.push({ code: e.code, block: e.block, message: e.message });
      }
    });
    this.client = await connectToSim(cpu);
    this.cpu = cpu;
    this.scheduleTick();
  }

  private async download(
    files: Uint8Array[],
    keep?: { kind: string; number: number }[],
  ): Promise<void> {
    for (const [i, file] of files.entries()) {
      let name = `file ${i + 1}`;
      try {
        const h = parseBlockFile(file).header;
        name = `${h.type ?? `0x${h.typeCode.toString(16)}`}${h.number}`;
      } catch {
        // intestazione illeggibile: resta il numero del file
      }
      try {
        await this.client!.downloadBlock(file);
      } catch (e) {
        throw new Error(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (keep) this.deleteMissing(keep);
  }

  /** Cancella dalla CPU i blocchi (compresi i DB) che non sono in `keep`. */
  private deleteMissing(keep: { kind: string; number: number }[]): void {
    const cpu = this.cpu!;
    const wanted = new Set(keep.map((b) => `${b.kind}${b.number}`));
    const gone: { kind: string; number: number }[] = [];
    for (const b of cpu.program.list())
      if (!wanted.has(`${b.kind}${b.number}`)) gone.push({ kind: b.kind, number: b.number });
    for (const n of cpu.memory.dbs.keys())
      if (!wanted.has(`DB${n}`)) gone.push({ kind: 'DB', number: n });
    for (const b of gone) cpu.deleteBlock(b.kind, b.number);
  }

  // ---- ciclo -----------------------------------------------------------------------------

  private kickPump(): void {
    this.cancelPump?.();
    this.cancelPump = this.env.schedule(() => this.pump(), 0);
  }

  /**
   * Una fetta di esecuzione: cicli finché non passa `minCycleMs` d'attesa o `SLICE_MS` di lavoro;
   * poi cede (`schedule(…, 0)`) o attende il prossimo ciclo.
   */
  private pump(): void {
    this.cancelPump = undefined;
    try {
      this.pumpSlice();
    } catch (e) {
      this.fatal(e);
    }
  }

  private pumpSlice(): void {
    const cpu = this.cpu;
    if (!cpu || this.dead || cpu.mode !== 'RUN') return;
    const minMs = Math.max(0, this.minCycleMs);
    const t0 = this.env.now();
    let n = 0;
    for (;;) {
      const t = this.env.now();
      if (t < this.nextCycleAt) {
        this.cancelPump = this.env.schedule(() => this.pump(), this.nextCycleAt - t);
        return;
      }
      cpu.cycle();
      if (cpu.mode !== 'RUN') return; // il modo è cambiato: l'evento ha già avvisato
      this.nextCycleAt = t + minMs;
      n++;
      if (this.env.now() - t0 >= SLICE_MS || n >= MAX_CYCLES_PER_SLICE) {
        this.cancelPump = this.env.schedule(() => this.pump(), 0);
        return;
      }
    }
  }

  /** Eccezione inattesa in un timer: si avvisa il renderer e si ferma tutto. */
  private fatal(e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    this.dead = true;
    this.cancelPump?.();
    this.cancelTick?.();
    this.cancelPump = this.cancelTick = undefined;
    this.env.post({ kind: 'error', message });
  }

  // ---- notifiche -------------------------------------------------------------------------

  private scheduleTick(): void {
    this.cancelTick = this.env.schedule(() => {
      this.cancelTick = undefined;
      if (this.dead) return;
      try {
        this.tick();
      } catch (e) {
        this.fatal(e);
        return;
      }
      this.scheduleTick();
    }, NOTICE_INTERVAL_MS);
  }

  private tick(): void {
    const cpu = this.cpu;
    if (!cpu) return;
    this.sendStatus();
    if (this.monitorReq) {
      const steps = cpu.monitorSnapshot();
      if (steps) this.env.post({ kind: 'monitor', block: this.monitorReq, steps });
    }
    if (this.watchItems.length > 0) {
      this.env.post({ kind: 'watch', values: this.watchItems.map((it) => this.readOne(cpu, it)) });
    }
  }

  private sendStatus(): void {
    const cpu = this.cpu;
    if (!cpu || this.dead) return;
    this.env.post({
      kind: 'status',
      mode: cpu.mode,
      stats: cpu.stats(),
      diagnostics: [...cpu.diagnostics],
      warnings: [...this.warnings],
      inputs: cpu.memory.physIn.slice(),
      outputs: cpu.memory.physOut.slice(),
      forces: cpu.forceTable.map((f) => ({ ...f, data: f.data.slice() })),
    });
  }

  // ---- variabili -------------------------------------------------------------------------

  /** Buffer dell'area e posizione del primo byte; un messaggio d'errore se non esiste. */
  private locate(
    cpu: SimCpu,
    it: WatchItem,
  ): { buf: Uint8Array; at: number; len: number } | string {
    const len = SIZE_BYTES[it.size];
    if (!Number.isInteger(it.byte) || it.byte < 0) return `byte ${it.byte} non valido`;
    if (it.size === 'X' && !(Number.isInteger(it.bit) && it.bit! >= 0 && it.bit! <= 7))
      return `bit ${String(it.bit)} non valido`;
    const m = cpu.memory;
    let buf: Uint8Array | undefined;
    switch (it.area) {
      case 'I':
        buf = m.I;
        break;
      case 'Q':
        buf = m.Q;
        break;
      case 'M':
        buf = m.M;
        break;
      case 'PI':
        buf = m.physIn;
        break;
      case 'PQ':
        buf = m.physOut;
        break;
      case 'DB': {
        const db = m.dbs.get(it.db ?? -1);
        if (!db) return `DB${it.db ?? '?'} non caricato`;
        buf = db.data;
        break;
      }
      default:
        return `area ${it.area} non valida`;
    }
    if (it.byte + len > buf.length) return `fuori area: ${it.area} byte ${it.byte} (${len} byte)`;
    return { buf, at: it.byte, len };
  }

  private bank(cpu: SimCpu, it: WatchItem) {
    const b = it.area === 'T' ? cpu.timers : cpu.counters;
    if (!Number.isInteger(it.byte) || it.byte < 0 || it.byte >= b.count)
      return `${it.area} ${it.byte} fuori area`;
    return b;
  }

  private readOne(cpu: SimCpu, it: WatchItem): WatchValue {
    if (it.area === 'T' || it.area === 'C') {
      const b = this.bank(cpu, it);
      if (typeof b === 'string') return { error: b };
      const w = b.bcd(it.byte); // parola BCD come LC / LC C
      return { bytes: Uint8Array.of(w >> 8, w & 255) };
    }
    const loc = this.locate(cpu, it);
    if (typeof loc === 'string') return { error: loc };
    if (it.size === 'X') return { bytes: Uint8Array.of((loc.buf[loc.at]! >> it.bit!) & 1) };
    return { bytes: loc.buf.slice(loc.at, loc.at + loc.len) };
  }

  private writeOne(cpu: SimCpu, it: WriteItemReq): WriteResult {
    if (it.area === 'T' || it.area === 'C')
      return { error: `scrittura di ${it.area} non supportata` };
    const loc = this.locate(cpu, it);
    if (typeof loc === 'string') return { error: loc };
    if (it.data.length !== loc.len)
      return { error: `servono ${loc.len} byte, ne arrivano ${it.data.length}` };
    const put = (buf: Uint8Array) => {
      if (it.size === 'X') {
        const mask = 1 << it.bit!;
        buf[loc.at] = it.data[0] ? buf[loc.at]! | mask : buf[loc.at]! & ~mask;
      } else buf.set(it.data, loc.at);
    };
    put(loc.buf);
    // Come l'accesso diretto di writeBits: una scrittura su PQ aggiorna anche la PIQ (Q) se
    // l'indirizzo vi cade, altrimenti la copia di fine ciclo (physOut = Q) la cancellerebbe.
    if (it.area === 'PQ' && loc.at + loc.len <= cpu.memory.Q.length) put(cpu.memory.Q);
    return { ok: true };
  }

  // ---- fine ------------------------------------------------------------------------------

  private async shutdown(): Promise<void> {
    const cpu = this.cpu;
    if (cpu && cpu.mode !== 'STOP') cpu.stop('simulazione terminata');
    this.sendStatus(); // ultimo stato (STOP) prima di spegnersi
    this.dead = true;
    this.cancelPump?.();
    this.cancelTick?.();
    this.cancelPump = this.cancelTick = undefined;
    const c = this.client;
    this.client = undefined;
    await c?.close().catch(() => undefined);
  }
}
