import {
  S7Error,
  decodeBlockStatusResult,
  maxBlockStatusLines,
  type BlockStatusRequest,
  type ConnectOptions,
  type S7TestClient,
} from '@baaportal/s7comm';
import { connectTestTcp } from '@baaportal/s7comm/node';
import type {
  PlcAccess,
  PlcStatusReadResult,
  PlcStatusRequest,
  PlcStatusStartResult,
  PlcStatusWindowResult,
} from '@baaportal/ui';
import { connectMessage, type PlcOwner, type PlcService } from './plcService';
import type { TisJobStore } from './tisJobs';
import { connectOptions, mpiKey } from './access';
import { tr } from './dialogText';

const FN = 0x13;
const DEFAULT_PORT = 102;
/** Quanto aspettare un enable prima di arrendersi del tutto (il job riparte da capo). */
const ENABLE_LONG_MS = 30_000;
const DELETE_LIMIT_MS = 1000;
const MAX_LINES = 64;
const STOP_ALL_LIMIT_MS = 2000;

export type StatusClient = Pick<
  S7TestClient,
  | 'identity'
  | 'close'
  | 'pduLength'
  | 'tisFunctions'
  | 'blockInfo'
  | 'readJobList'
  | 'createBlockStatus'
  | 'enableAndWait'
  | 'deleteJob'
>;
export type StatusConnectFn = (
  o: Omit<ConnectOptions, 'transport' | 'mode'>,
) => Promise<StatusClient>;

export interface BlockStatusOptions {
  service: Pick<PlcService, 'target' | 'modeOf' | 'onLinkEnd'>;
  connect?: StatusConnectFn;
  jobs: TisJobStore;
  now?: () => number;
  /** Attesa fra due enable e simili; iniettabile nei test con un orologio finto. */
  timers?: { sleep(ms: number): Promise<void> };
  idleMs?: number;
  resultTimeoutMs?: number;
  minEnableMs?: number;
  connectTimeoutMs?: number;
  /** Attesa massima di un enable (poi il job si cancella e si ricrea). */
  enableLongMs?: number;
  /** La CPU è in ripristino: l'osservazione si rifiuta (la imposta `plcIpc`). */
  blocked?: (access: PlcAccess) => boolean;
}

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** Controlla ciò che arriva dal renderer; il limite vero sulle righe lo applica `start`. */
export function parseStatusRequest(raw: unknown, maxLines = MAX_LINES): PlcStatusRequest | string {
  if (typeof raw !== 'object' || raw === null) return 'Richiesta di osservazione non valida';
  const r = raw as Record<string, unknown>;
  if (r['type'] !== 'OB' && r['type'] !== 'FB' && r['type'] !== 'FC')
    return 'Tipo di blocco non valido';
  if (!isInt(r['number'], 0, 65535)) return 'Numero di blocco non valido';
  const e = r['expect'];
  if (typeof e !== 'object' || e === null) return 'Firma del blocco non valida';
  const ex = e as Record<string, unknown>;
  if (!isInt(ex['checksum'], 0, 0xffff) || !isInt(ex['mc7Length'], 1, 0xffff)) {
    return 'Firma del blocco non valida';
  }
  const mc7Length = ex['mc7Length'];
  if (!isInt(r['mask'], 0, 0x0f) || (r['mask'] & 0x01) === 0)
    return 'Maschera dei registri non valida';
  if (!isInt(r['saz'], 1, mc7Length)) return 'Fine della finestra non valida';
  const saz = r['saz'];
  const offsets = r['offsets'];
  if (!Array.isArray(offsets) || offsets.length < 1 || offsets.length > maxLines) {
    return `Righe da osservare non valide (da 1 a ${maxLines})`;
  }
  let prev = -1;
  for (const o of offsets) {
    if (!isInt(o, 0, 0xffff) || o % 2 !== 0 || o <= prev || o >= saz) {
      return 'Offset delle righe non validi';
    }
    prev = o;
  }
  return {
    type: r['type'],
    number: r['number'],
    expect: { checksum: ex['checksum'], mc7Length },
    offsets: [...(offsets as number[])],
    saz,
    mask: r['mask'],
  };
}

/** Chiave della CPU nel registro: indirizzo e, se noto, numero di serie (stesso IP, altra CPU). */
export const cpuKey = (a: PlcAccess, serial?: string): string =>
  `${mpiKey(a) ?? `${a.host.toLowerCase()}:${a.port ?? DEFAULT_PORT}/${a.rack}/${a.slot}`}${serial ? `#${serial}` : ''}`;

/**
 * Se la finestra supera le righe concesse, taglia gli offset e la fine insieme: SAZ diventa
 * l'inizio della prima riga scartata (§18), mai la fine della finestra più lunga.
 */
function fitRequest(req: PlcStatusRequest, maxLines: number): PlcStatusRequest {
  if (req.offsets.length <= maxLines) return req;
  return { ...req, offsets: req.offsets.slice(0, maxLines), saz: req.offsets[maxLines]! };
}

const sameWindow = (a: PlcStatusRequest, b: PlcStatusRequest): boolean =>
  a.saz === b.saz &&
  a.mask === b.mask &&
  a.offsets.length === b.offsets.length &&
  a.offsets.every((o, i) => o === b.offsets[i]);

/** Il modo della CPU è cambiato fra il sondaggio e la creazione: non è un errore dell'osservazione. */
const isModeCode = (code: number | undefined): boolean =>
  code === 0xd081 || code === 0xd0c2 || code === 0xd0c7;

/** Codice d'errore della CPU di una S7Error (`classe << 8 | codice`). */
export function cpuCode(err: unknown): number | undefined {
  if (!(err instanceof S7Error) || err.code !== 'CPU_ERROR') return undefined;
  const d = err.detail;
  if (!d || d.errorClass === undefined || d.errorCode === undefined) return undefined;
  return (d.errorClass << 8) | d.errorCode;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

type FailReason = Extract<PlcStatusStartResult, { ok: false }>['reason'];

/** Dal codice TIS al motivo e al testo (§18.7.1). */
function classify(err: unknown): { reason: FailReason; message: string } {
  const code = cpuCode(err);
  switch (code) {
    case 0xd0a1:
      return {
        reason: 'protection',
        message: 'Livello di protezione della CPU: osservazione non permessa',
      };
    case 0xd003:
      return { reason: 'unsupported', message: 'Questa CPU non supporta lo stato del blocco v2' };
    case 0xd0c8:
      return {
        reason: 'different',
        message: 'Il blocco nella CPU è cambiato: confrontarlo di nuovo',
      };
    case 0xd062:
      return { reason: 'busy', message: 'Troppi job di test sulla CPU' };
    case 0xd063:
      return { reason: 'busy', message: 'Un altro PG osserva lo stesso punto' };
    case 0xd0ab:
    case 0xd0ac:
      return { reason: 'error', message: 'CPU in modo processo: lo stato del blocco è limitato' };
    default:
      return { reason: 'error', message: errText(err) };
  }
}

const DIFFERENT =
  'Il blocco nella CPU è diverso da quello del progetto: caricarlo o confrontarlo prima di osservarlo';

interface Pending {
  gen: number;
  p: Promise<
    { ok: true; r: { result: Uint8Array } | { timeout: true } } | { ok: false; e: unknown }
  >;
}

interface CpuLock {
  owner: PlcOwner;
}

interface Session {
  owner: PlcOwner;
  cpu: string;
  client: StatusClient;
  pduLength: number;
  maxLines: number;
  req: PlcStatusRequest;
  /** Finestra chiesta e non ancora applicata (si applica alla prossima lettura). */
  want?: PlcStatusRequest;
  job?: number;
  /** Cambia a ogni nuovo job: un risultato di un job vecchio si scarta. */
  gen: number;
  pending: Pending | null;
  lastEnableAt: number;
  reading: boolean;
  op: Promise<unknown> | null;
  /** Il possesso della CPU preso da questa start; solo chi lo ha preso lo rilascia. */
  lock: CpuLock;
  closed: boolean;
  closing?: Promise<void>;
  idle?: NodeJS.Timeout;
  offLink: () => void;
  onDestroyed: () => void;
}

/**
 * Osservazione di un blocco (block status v2) sul collegamento `online-test` della finestra: un
 * solo job per CPU. Il renderer chiede una lettura alla volta; il job si cancella sempre alla fine
 * (stop, nuova start, collegamento perso, uscita, finestra distrutta, renderer muto).
 */
export class BlockStatusService {
  private readonly sessions = new Map<PlcOwner, Session>();
  /** Chi osserva la CPU (una finestra sola). */
  private readonly cpuOwner = new Map<string, CpuLock>();
  /** Pulizie degli orfani in corso: una start sulla stessa CPU le aspetta. */
  private readonly cleaning = new Map<string, Promise<void>>();
  private readonly epochs = new WeakMap<PlcOwner, number>();
  /** Perché l'ultima osservazione della finestra è finita (si dice alla prossima lettura). */
  private readonly lastEnd = new WeakMap<PlcOwner, string>();
  private readonly connectFn: StatusConnectFn;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly idleMs: number;
  private readonly resultTimeoutMs: number;
  private readonly minEnableMs: number;
  private readonly connectTimeoutMs: number;
  private readonly enableLongMs: number;

  constructor(private readonly o: BlockStatusOptions) {
    this.connectFn = o.connect ?? connectTestTcp;
    this.now = o.now ?? Date.now;
    this.sleep = o.timers?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.idleMs = o.idleMs ?? 5000;
    this.resultTimeoutMs = o.resultTimeoutMs ?? 2000;
    this.minEnableMs = o.minEnableMs ?? 250;
    this.connectTimeoutMs = o.connectTimeoutMs ?? 3000;
    this.enableLongMs = o.enableLongMs ?? ENABLE_LONG_MS;
  }

  active(owner: PlcOwner): boolean {
    const s = this.sessions.get(owner);
    return !!s && !s.closed;
  }

  private async open(access: PlcAccess): Promise<StatusClient> {
    return this.connectFn(connectOptions(access, this.connectTimeoutMs));
  }

  async start(owner: PlcOwner, raw: unknown): Promise<PlcStatusStartResult> {
    const req = parseStatusRequest(raw);
    if (typeof req === 'string') return { ok: false, reason: 'error', error: req };
    const epoch = (this.epochs.get(owner) ?? 0) + 1;
    this.epochs.set(owner, epoch);
    const old = this.sessions.get(owner);
    if (old) await this.close(old);
    if (this.epochs.get(owner) !== epoch) {
      return { ok: false, reason: 'error', error: tr('Osservazione annullata') };
    }
    this.lastEnd.delete(owner);
    const target = this.o.service.target(owner);
    if (!target) {
      return { ok: false, reason: 'offline', error: tr('Nessun collegamento online') };
    }
    if (this.o.blocked?.(target.access)) {
      return { ok: false, reason: 'busy', error: tr('Ripristino in corso su questa CPU') };
    }
    const cpu = cpuKey(target.access, target.identity.serial);
    const holder = this.cpuOwner.get(cpu);
    if (holder && holder.owner !== owner) {
      return {
        ok: false,
        reason: 'busy',
        error: tr("Osservazione già attiva su questa CPU in un'altra finestra"),
      };
    }
    const lock: CpuLock = { owner };
    this.cpuOwner.set(cpu, lock);
    let client: StatusClient | undefined;
    const fail = async (reason: FailReason, error: string): Promise<PlcStatusStartResult> => {
      if (client) await client.close().catch(() => undefined);
      if (this.cpuOwner.get(cpu) === lock) this.cpuOwner.delete(cpu);
      return { ok: false, reason, error };
    };
    const superseded = (): boolean =>
      this.epochs.get(owner) !== epoch ||
      owner.isDestroyed() ||
      this.o.service.target(owner)?.linkId !== target.linkId;
    try {
      await this.cleaning.get(cpu);
      client = await this.open(target.access);
    } catch (err) {
      return fail('error', connectMessage(err, target.access));
    }
    try {
      const id = await client.identity();
      const want = target.identity;
      const serialDiffers =
        id.serialNumber !== undefined &&
        want.serial !== undefined &&
        id.serialNumber !== want.serial;
      if (id.orderNumber !== want.orderNumber || serialDiffers) {
        return fail(
          'error',
          'La CPU raggiunta non è quella collegata (numero di ordinazione o di serie diverso)',
        );
      }
      if (superseded()) return fail('error', tr('Osservazione annullata'));
      const fns = await client.tisFunctions();
      if (!fns.blockStatusV2 || !fns.codeAreaTrigger) {
        return fail('unsupported', 'Questa CPU non supporta lo stato del blocco v2');
      }
      let info;
      try {
        info = await client.blockInfo(req.type, req.number);
      } catch (err) {
        if (err instanceof S7Error && err.code === 'CPU_ERROR') {
          return fail('missing', `${req.type}${req.number} non è nella CPU`);
        }
        throw err;
      }
      if (info.checksum !== req.expect.checksum || info.mc7Length !== req.expect.mc7Length) {
        return fail('different', DIFFERENT);
      }
      await this.sweep(client, cpu);
      if (superseded()) return fail('error', tr('Osservazione annullata'));
      const pduLength = client.pduLength;
      const maxLines = maxBlockStatusLines(pduLength, req.mask);
      if (maxLines < 1) return fail('error', 'PDU troppo piccola per lo stato del blocco');
      if (superseded()) return fail('error', tr('Osservazione annullata'));
      const s: Session = {
        owner,
        cpu,
        client,
        pduLength,
        maxLines,
        req: fitRequest(req, maxLines),
        gen: 0,
        pending: null,
        lastEnableAt: -Infinity,
        reading: false,
        op: null,
        lock,
        closed: false,
        offLink: () => undefined,
        onDestroyed: () => void this.close(s),
      };
      if (this.o.service.modeOf(owner) === 'RUN') {
        // un ripristino può essere partito mentre ci si collegava: niente job nuovi durante il ripristino
        if (this.o.blocked?.(target.access)) {
          return fail('busy', tr('Ripristino in corso su questa CPU'));
        }
        try {
          await this.createJob(s);
        } catch (err) {
          // il modo è cambiato di mezzo: l'osservazione resta accesa, il job nascerà in RUN
          if (!isModeCode(cpuCode(err))) {
            const c = classify(err);
            return fail(c.reason, c.message);
          }
        }
      }
      if (superseded()) {
        await this.close(s);
        return { ok: false, reason: 'error', error: tr('Osservazione annullata') };
      }
      this.sessions.set(owner, s);
      s.offLink = this.o.service.onLinkEnd(owner, () => {
        this.lastEnd.set(owner, 'Collegamento online terminato');
        void this.close(s);
      });
      owner.once('destroyed', s.onDestroyed);
      this.touch(s);
      return { ok: true, maxLines, pduLength };
    } catch (err) {
      return fail('error', errText(err));
    }
  }

  /** Cambia la finestra: si applica alla prossima lettura (più cambi di fila si riducono all'ultimo). */
  window(owner: PlcOwner, raw: unknown): PlcStatusWindowResult {
    const s = this.sessions.get(owner);
    if (!s || s.closed) return { ok: false, error: tr('Nessuna osservazione attiva') };
    const req = parseStatusRequest(raw);
    if (typeof req === 'string') return { ok: false, error: req };
    if (
      req.type !== s.req.type ||
      req.number !== s.req.number ||
      req.expect.checksum !== s.req.expect.checksum ||
      req.expect.mc7Length !== s.req.expect.mc7Length
    ) {
      return { ok: false, error: tr('La finestra riguarda un altro blocco') };
    }
    const maxLines = maxBlockStatusLines(s.pduLength, req.mask);
    const fit = fitRequest(req, maxLines);
    // uguale a quella già attiva: nessun delete/create inutile
    s.want = sameWindow(fit, s.req) ? undefined : fit;
    this.touch(s);
    return { ok: true };
  }

  async read(owner: PlcOwner): Promise<PlcStatusReadResult> {
    const s = this.sessions.get(owner);
    if (!s || s.closed) return this.endedResult(owner);
    this.touch(s);
    if (s.reading) return { ok: true, state: 'waiting' };
    s.reading = true;
    try {
      return await this.readOnce(s);
    } finally {
      s.reading = false;
    }
  }

  private endedResult(owner: PlcOwner): PlcStatusReadResult {
    const error = this.lastEnd.get(owner) ?? tr('Nessuna osservazione attiva');
    this.lastEnd.delete(owner);
    return { ok: false, ended: true, error };
  }

  private async endWith(s: Session, message: string): Promise<PlcStatusReadResult> {
    this.lastEnd.set(s.owner, message);
    await this.close(s);
    return this.endedResult(s.owner);
  }

  private async readOnce(s: Session): Promise<PlcStatusReadResult> {
    const mode = this.o.service.modeOf(s.owner);
    if (mode === 'STOP' || mode === 'HOLD') {
      await this.dropJob(s);
      return s.closed ? this.endedResult(s.owner) : { ok: true, state: 'stop' };
    }
    if (s.want) {
      s.req = s.want;
      s.want = undefined;
      await this.dropJob(s);
    }
    if (s.closed) return this.endedResult(s.owner);
    if (s.job === undefined) {
      if (mode !== 'RUN') return { ok: true, state: 'waiting' };
      const t = this.o.service.target(s.owner);
      if (t && this.o.blocked?.(t.access))
        return this.endWith(s, tr('Ripristino in corso su questa CPU'));
      try {
        await this.createJob(s);
      } catch (err) {
        if (isModeCode(cpuCode(err))) return { ok: true, state: 'stop' };
        return this.endWith(s, classify(err).message);
      }
    }
    if (s.closed) return this.endedResult(s.owner);
    if (!s.pending || s.pending.gen !== s.gen) {
      const wait = s.lastEnableAt + this.minEnableMs - this.now();
      if (wait > 0) await this.sleep(wait);
      if (s.closed || s.job === undefined) return this.endedResult(s.owner);
      s.lastEnableAt = this.now();
      s.pending = {
        gen: s.gen,
        p: s.client.enableAndWait(FN, s.job, this.enableLongMs).then(
          (r) => ({ ok: true as const, r }),
          (e: unknown) => ({ ok: false as const, e }),
        ),
      };
    }
    const mine = s.pending;
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      mine.p,
      new Promise<'late'>((r) => {
        timer = setTimeout(() => r('late'), this.resultTimeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome === 'late') return { ok: true, state: 'waiting' };
    if (s.pending === mine) s.pending = null;
    if (s.closed) return this.endedResult(s.owner);
    if (mine.gen !== s.gen) return { ok: true, state: 'waiting' };
    if (!outcome.ok) return this.onEnableError(s, outcome.e);
    if ('timeout' in outcome.r) {
      // Un risultato che arrivasse dopo resterebbe in coda e il prossimo enable lo scambierebbe per
      // il suo: si cancella il job (che scarta le indication) e si ricrea alla lettura successiva.
      await this.dropJob(s);
      return { ok: true, state: 'waiting' };
    }
    const bs = this.toRequest(s);
    const partial = 'partial' in outcome.r && outcome.r.partial === true;
    const dec = decodeBlockStatusResult(outcome.r.result, bs);
    if (!dec.ok) {
      if (partial) {
        // dati limitati dal tempo e non leggibili: righe grigie, ma si dice che è parziale
        return {
          ok: true,
          state: 'values',
          lines: bs.lines.map((l) => ({ offset: l.offset, regs: null })),
          partial: true,
        };
      }
      return this.endWith(s, `Risposta della CPU non riconosciuta (${dec.why}): ${dec.hex}`);
    }
    return {
      ok: true,
      state: 'values',
      lines: bs.lines.map((l, i) => ({ offset: l.offset, regs: dec.lines[i] ?? null })),
      ...(partial ? { partial: true as const } : {}),
    };
  }

  private async onEnableError(s: Session, err: unknown): Promise<PlcStatusReadResult> {
    const code = cpuCode(err);
    if (code === 0xd0a5 || code === 0xd0c2 || code === 0xd0c7) {
      // il job è finito da solo: si ricrea alla lettura successiva (se il modo è RUN)
      this.forgetJob(s);
      return { ok: true, state: 'waiting' };
    }
    if (code === 0xd0cc) {
      // dati limitati dal tempo e senza valori: righe grigie, ma parziale
      const bs = this.toRequest(s);
      return {
        ok: true,
        state: 'values',
        lines: bs.lines.map((l) => ({ offset: l.offset, regs: null })),
        partial: true,
      };
    }
    return this.endWith(s, classify(err).message);
  }

  private toRequest(s: Session): BlockStatusRequest {
    return {
      type: s.req.type,
      number: s.req.number,
      initMask: s.req.mask,
      lines: s.req.offsets.map((offset) => ({ offset, mask: s.req.mask })),
    };
  }

  /** Crea il job e lo registra (serializzato: chi chiude aspetta). */
  private async createJob(s: Session): Promise<void> {
    const run = (async () => {
      const job = await s.client.createBlockStatus(this.toRequest(s), s.req.saz);
      s.job = job;
      s.gen++;
      s.pending = null;
      this.o.jobs.add(s.cpu, FN, job);
    })();
    s.op = run;
    try {
      await run;
    } finally {
      if (s.op === run) s.op = null;
    }
  }

  /** Il job non c'è più nella CPU (finito da solo): si toglie dal registro senza cancellarlo. */
  private forgetJob(s: Session): void {
    if (s.job !== undefined) this.o.jobs.remove(s.cpu, FN, s.job);
    s.job = undefined;
    s.gen++;
    s.pending = null;
  }

  /** Cancella il job (al più 1 s); se fallisce resta nel registro per la pulizia successiva. */
  private async dropJob(s: Session): Promise<void> {
    if (s.op) await this.withLimit(s.op).catch(() => undefined);
    const job = s.job;
    if (job === undefined) return;
    s.job = undefined;
    s.gen++;
    s.pending = null;
    try {
      const r = await this.withLimit(s.client.deleteJob(FN, job));
      if (r === 'deleted' || r === 'notFound' || r === 'otherConnection') {
        this.o.jobs.remove(s.cpu, FN, job);
      }
    } catch {
      // resta nel registro
    }
  }

  private async withLimit<T>(p: Promise<T>, ms = DELETE_LIMIT_MS): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error('cancellazione troppo lenta')), ms);
    });
    p.catch(() => undefined);
    try {
      return await Promise.race([p, limit]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private touch(s: Session): void {
    if (s.idle) clearTimeout(s.idle);
    if (s.closed) return;
    s.idle = setTimeout(() => {
      this.lastEnd.set(s.owner, 'Osservazione chiusa: nessuna richiesta dalla finestra');
      void this.close(s);
    }, this.idleMs);
    s.idle.unref?.();
  }

  /** Fine garantita: delete, poi registro, poi collegamento. Idempotente. */
  private close(s: Session): Promise<void> {
    if (s.closing) return s.closing;
    s.closed = true;
    if (s.idle) clearTimeout(s.idle);
    s.offLink();
    s.owner.removeListener('destroyed', s.onDestroyed);
    s.closing = (async () => {
      try {
        await this.dropJob(s);
      } finally {
        if (this.sessions.get(s.owner) === s) this.sessions.delete(s.owner);
        if (this.cpuOwner.get(s.cpu) === s.lock) this.cpuOwner.delete(s.cpu);
        await s.client.close().catch(() => undefined);
      }
    })();
    return s.closing;
  }

  async stop(owner: PlcOwner): Promise<void> {
    // una start in corso si annulla: non deve lasciare un job che nessuno vuole
    this.epochs.set(owner, (this.epochs.get(owner) ?? 0) + 1);
    this.lastEnd.delete(owner);
    const s = this.sessions.get(owner);
    if (s) await this.close(s);
  }

  /**
   * Ferma ogni osservazione sulla CPU del collegamento della finestra (di qualunque finestra): il
   * ripristino non deve trovare job di test. Aspetta che i job siano cancellati.
   */
  async stopForCpu(owner: PlcOwner): Promise<void> {
    const target = this.o.service.target(owner);
    if (!target) return;
    const cpu = cpuKey(target.access, target.identity.serial);
    const mine = [...this.sessions.values()].filter((s) => s.cpu === cpu);
    for (const s of mine)
      this.lastEnd.set(s.owner, 'Osservazione fermata dal ripristino del backup');
    await Promise.all(mine.map((s) => this.close(s)));
  }

  async stopAll(): Promise<void> {
    const all = Promise.all([...this.sessions.values()].map((s) => this.close(s)));
    try {
      await this.withLimit(all, STOP_ALL_LIMIT_MS);
    } catch {
      // oltre il limite: i job rimasti sono nel registro, li pulirà il prossimo collegamento
    }
    this.o.jobs.flush?.();
  }

  /**
   * Pulizia dei job orfani: sul collegamento dato, i job `0x13` dell'elenco che sono anche nel
   * registro si cancellano; le voci del registro che la CPU non ha più si tolgono. I job non
   * registrati non si toccano mai.
   */
  private async sweep(client: StatusClient, cpu: string): Promise<void> {
    if (this.o.jobs.list(cpu).length === 0) return;
    try {
      const live = await client.readJobList();
      const reg = this.o.jobs.list(cpu);
      for (const e of reg) {
        if (!live.some((j) => j.fn === e.fn && j.job === e.job))
          this.o.jobs.remove(cpu, e.fn, e.job);
      }
      for (const j of live) {
        if (j.fn !== FN || !reg.some((e) => e.fn === j.fn && e.job === j.job)) continue;
        try {
          await client.deleteJob(j.fn, j.job); // deleted, notFound e otherConnection tolgono la voce
          this.o.jobs.remove(cpu, j.fn, j.job);
        } catch {
          // resta nel registro
        }
      }
    } catch {
      // la pulizia è un di più: se non riesce, riproverà al prossimo collegamento
    }
  }

  /** A ogni nuovo collegamento: se la CPU ha voci nel registro, cancella i job orfani nostri. */
  cleanup(owner: PlcOwner): Promise<void> {
    const target = this.o.service.target(owner);
    if (!target) return Promise.resolve();
    const cpu = cpuKey(target.access, target.identity.serial);
    const running = this.cleaning.get(cpu);
    if (running) return running;
    if (this.o.jobs.list(cpu).length === 0 || this.cpuOwner.has(cpu)) return Promise.resolve();
    const run = this.cleanupCpu(target, cpu).finally(() => {
      if (this.cleaning.get(cpu) === run) this.cleaning.delete(cpu);
    });
    this.cleaning.set(cpu, run);
    return run;
  }

  private async cleanupCpu(
    target: NonNullable<ReturnType<BlockStatusOptions['service']['target']>>,
    cpu: string,
  ): Promise<void> {
    let client: StatusClient | undefined;
    try {
      client = await this.open(target.access);
      const id = await client.identity();
      const want = target.identity;
      if (id.orderNumber !== want.orderNumber) return;
      if (
        id.serialNumber !== undefined &&
        want.serial !== undefined &&
        id.serialNumber !== want.serial
      )
        return;
      // una osservazione nata nel frattempo ha il suo job: non si tocca
      if (this.cpuOwner.has(cpu)) return;
      await this.sweep(client, cpu);
    } catch {
      // niente da fare adesso
    } finally {
      await client?.close().catch(() => undefined);
    }
  }
}
