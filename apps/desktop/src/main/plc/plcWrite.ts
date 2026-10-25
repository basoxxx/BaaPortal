import { parseBlockFile } from '@baaportal/s7comm';
import type { BlockType, ConnectOptions, S7DateTime, S7WriteClient } from '@baaportal/s7comm';
import { connectWriteTcp } from '@baaportal/s7comm/node';
import type {
  PlcAccess,
  PlcBlockRef,
  PlcControlOp,
  PlcClockResult,
  PlcControlResult,
  PlcDownloadResult,
  PlcWriteProgress,
  PlcWriteVarsResult,
} from '@baaportal/ui';
import type { ConfirmFn, WriteConfirmTexts } from './confirm';
import { connectMessage, type PlcOwner, type PlcService } from './plcService';
import { confirmLine, parseWriteItems, toWriteItem } from './watchOnline';

export const MAX_FILES = 2048;
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const LOADABLE = ['OB', 'FB', 'FC', 'DB'];
const DEFAULT_PORT = 102;
const CONNECTION_TYPES = { PG: 'pg', OP: 'op', S7_BASIC: 'basic' } as const;
const DELETABLE = ['OB', 'FB', 'FC', 'DB'];
const MAX_LIST_LINES = 20;
/** Item per richiesta write var (proto §5.11). */
const MAX_WRITE_GROUP = 20;
const PROGRESS_MIN_MS = 100; // al massimo 10 eventi al secondo, più quello finale
const OPS: readonly PlcControlOp[] = ['RUN', 'STOP', 'COPY_RAM_TO_ROM', 'COMPRESS'];

/** Finestra a cui si inviano gli avanzamenti (in produzione il `webContents`). */
export interface PlcWriteOwner extends PlcOwner {
  send(channel: string, payload: unknown): void;
}

export type WriteClient = Pick<
  S7WriteClient,
  | 'close'
  | 'identity'
  | 'downloadBlock'
  | 'deleteBlock'
  | 'stop'
  | 'start'
  | 'copyRamToRom'
  | 'compressMemory'
  | 'setClock'
  | 'writeItems'
>;
export type PlcWriteConnectFn = (
  o: Omit<ConnectOptions, 'transport' | 'mode'>,
) => Promise<WriteClient>;

export interface PlcWriteOptions {
  service: Pick<PlcService, 'target'>;
  confirm: ConfirmFn;
  connectTimeoutMs?: number;
  /** Iniettabile nei test (collegamento finto). */
  connect?: PlcWriteConnectFn;
  /** Iniettabile nei test: orologio per il limite degli avanzamenti. */
  now?: () => number;
}

export interface DownloadRequest {
  files: Uint8Array[];
  deleteBlocks: PlcBlockRef[];
}

/** Controlla ciò che arriva dal renderer: forma, quantità e dimensioni. */
export function parseDownloadRequest(files: unknown, opts: unknown): DownloadRequest | string {
  if (!Array.isArray(files)) return 'Elenco di file non valido';
  if (files.length > MAX_FILES) return `Troppi file (massimo ${MAX_FILES})`;
  let total = 0;
  for (const f of files) {
    if (!(f instanceof Uint8Array)) return 'File non valido';
    if (f.length > MAX_FILE_BYTES) return 'File di blocco troppo grande (massimo 1 MB)';
    total += f.length;
    if (total > MAX_TOTAL_BYTES)
      return 'Dimensione complessiva dei file troppo grande (massimo 32 MB)';
  }
  const del: PlcBlockRef[] = [];
  if (opts !== undefined && opts !== null) {
    if (typeof opts !== 'object') return 'Opzioni non valide';
    const d = (opts as { deleteBlocks?: unknown }).deleteBlocks;
    if (d !== undefined) {
      if (!Array.isArray(d) || d.length > MAX_FILES)
        return 'Elenco di blocchi da cancellare non valido';
      for (const b of d) {
        const r = b as { type?: unknown; number?: unknown } | null;
        if (
          typeof r !== 'object' ||
          r === null ||
          typeof r.type !== 'string' ||
          !DELETABLE.includes(r.type) ||
          typeof r.number !== 'number' ||
          !Number.isInteger(r.number) ||
          r.number < 0 ||
          r.number > 65535
        ) {
          return 'Blocco da cancellare non valido (solo OB, FB, FC, DB, numero 0..65535)';
        }
        del.push({ type: r.type as PlcBlockRef['type'], number: r.number });
      }
    }
  }
  return { files: files as Uint8Array[], deleteBlocks: del };
}

export function isControlOp(v: unknown): v is PlcControlOp {
  return typeof v === 'string' && (OPS as readonly string[]).includes(v);
}

const CONTROL_TEXTS: Record<PlcControlOp, { title: string; label: string; what: string }> = {
  RUN: { title: 'Avvia la CPU', label: 'Avvia (RUN)', what: 'Portare la CPU in RUN' },
  STOP: { title: 'Ferma la CPU', label: 'Ferma (STOP)', what: 'Portare la CPU in STOP' },
  COPY_RAM_TO_ROM: {
    title: 'Copia RAM in ROM',
    label: 'Copia RAM in ROM',
    what: 'Copiare la memoria di caricamento RAM nella ROM',
  },
  COMPRESS: { title: 'Comprimi la memoria', label: 'Comprimi', what: 'Comprimere la memoria' },
};

const two = (n: number): string => String(n).padStart(2, '0');

function formatTime(t: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}): string {
  return `${two(t.day)}/${two(t.month)}/${t.year} ${two(t.hour)}:${two(t.minute)}:${two(t.second)}`;
}

const TIME_FIELDS = [
  ['year', 1990, 2089],
  ['month', 1, 12],
  ['day', 1, 31],
  ['hour', 0, 23],
  ['minute', 0, 59],
  ['second', 0, 59],
] as const;

/** Controlla un'ora: data di calendario vera (anno 1990-2089), ore, minuti e secondi. */
function checkTime(t: Record<string, unknown>): string | undefined {
  for (const [k, lo, hi] of TIME_FIELDS) {
    const v = t[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) {
      return `Ora non valida: ${k} fuori da ${lo}-${hi}`;
    }
  }
  const year = t['year'] as number;
  const month = t['month'] as number;
  // Il solo `% 4` basta nel 1990-2089 (il 2000 è bisestile): fuori da quel campo sarebbe sbagliato.
  const days = [31, year % 4 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  if ((t['day'] as number) > days) return 'Ora non valida: il giorno non esiste in quel mese';
  return undefined;
}

type ClockSpec = { pc: true } | { pc: false; time: S7DateTime };

/** Controlla ciò che arriva dal renderer prima di qualunque conferma. */
export function parseClockRequest(raw: unknown): ClockSpec | string {
  if (typeof raw !== 'object' || raw === null) return 'Richiesta di ora non valida';
  const r = raw as { source?: unknown; time?: unknown };
  if (r.source === 'pc') return { pc: true };
  if (r.source !== 'manual') return "Origine dell'ora non valida";
  if (typeof r.time !== 'object' || r.time === null) return 'Ora non valida';
  const t = r.time as Record<string, unknown>;
  const bad = checkTime(t);
  if (bad) return bad;
  return {
    pc: false,
    time: {
      year: t['year'] as number,
      month: t['month'] as number,
      day: t['day'] as number,
      hour: t['hour'] as number,
      minute: t['minute'] as number,
      second: t['second'] as number,
      ms: 0,
    },
  };
}

function listLines(lines: string[]): string {
  if (lines.length <= MAX_LIST_LINES) return lines.join('\n');
  return [...lines.slice(0, MAX_LIST_LINES), `… e altri ${lines.length - MAX_LIST_LINES}`].join(
    '\n',
  );
}

/** Identifica una CPU: indirizzo, porta, rack e slot. */
function cpuKey(a: PlcAccess): string {
  return `${a.host.trim().toLowerCase()}:${a.port ?? DEFAULT_PORT}/${a.rack}/${a.slot}`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type Step = { name: string; run: (c: WriteClient) => Promise<void>; counts: 'delete' | 'load' };

/** Un'operazione di scrittura in corso: `aborted` la ferma prima del passo successivo. */
interface Op {
  aborted: boolean;
  /** `confirming` finché la finestra nativa è aperta, poi `running` (c'è un collegamento). */
  stage: 'confirming' | 'running';
  settled: Promise<void>;
}

type Prepared =
  { c: WriteClient } | { result: { ok: false; cancelled: true } | { ok: false; error: string } };

/**
 * Scritture nella CPU, una alla volta per finestra. Ogni operazione: conferma nativa, poi apre un
 * collegamento `online-write`, esegue, chiude (sempre, anche in caso di errore). L'indirizzo è
 * quello del collegamento online della stessa finestra: il renderer non lo passa mai.
 */
export class PlcWriteService {
  private readonly ops = new Map<PlcOwner, Op>();
  /** Le CPU (host:porta/rack/slot) con una scrittura in corso, da qualunque finestra. */
  private readonly busyCpus = new Set<string>();
  /** Dopo `abortAll` (uscita dall'app) non parte più nessuna scrittura. */
  private closing = false;
  private readonly connectFn: PlcWriteConnectFn;
  private readonly connectTimeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly o: PlcWriteOptions) {
    this.connectFn = o.connect ?? connectWriteTcp;
    this.connectTimeoutMs = o.connectTimeoutMs ?? 3000;
    this.now = o.now ?? Date.now;
  }

  /** C'è una scrittura con il collegamento aperto (serve all'uscita dall'app). */
  writing(): boolean {
    return [...this.ops.values()].some((op) => op.stage === 'running');
  }

  /**
   * Uscita dall'app: ferma ogni scrittura prima del passo successivo e aspetta che chiuda il
   * collegamento. Quelle ancora alla finestra di conferma vengono annullate senza attendere.
   */
  /** Ferma le scritture in corso prima del blocco successivo, senza impedirne di nuove. */
  interruptAll(): void {
    for (const op of this.ops.values()) op.aborted = true;
  }

  async abortAll(): Promise<void> {
    this.closing = true;
    const running: Promise<void>[] = [];
    for (const op of this.ops.values()) {
      op.aborted = true;
      if (op.stage === 'running') running.push(op.settled);
    }
    await Promise.all(running);
  }

  async download(
    owner: PlcWriteOwner,
    files: unknown,
    opts: unknown = {},
  ): Promise<PlcDownloadResult> {
    // L'unico controllo dei dati del renderer: il canale IPC li passa così come arrivano.
    const req = parseDownloadRequest(files, opts);
    if (typeof req === 'string') return fail(req);
    const names: string[] = [];
    for (const f of req.files) {
      try {
        const h = parseBlockFile(f).header;
        const name = h.type === undefined ? `0x${h.typeCode.toString(16)}` : `${h.type}${h.number}`;
        if (h.type === undefined || !LOADABLE.includes(h.type)) {
          return fail(
            `Tipo di blocco non ammesso per il caricamento: ${name} (solo OB, FB, FC, DB)`,
          );
        }
        names.push(name);
      } catch (err) {
        return fail(`File di blocco non valido: ${errText(err)}`);
      }
    }
    if (req.files.length === 0 && req.deleteBlocks.length === 0)
      return fail('Nessun blocco da caricare');
    const steps: Step[] = [
      ...req.deleteBlocks.map<Step>((b) => ({
        name: `${b.type}${b.number}`,
        counts: 'delete',
        run: (c) => c.deleteBlock(b.type as BlockType, b.number),
      })),
      ...req.files.map<Step>((f, i) => ({
        name: names[i]!,
        counts: 'load',
        run: (c) => c.downloadBlock(f),
      })),
    ];
    const lines = [
      ...req.deleteBlocks.map((b) => `Cancella ${b.type}${b.number}`),
      ...names.map((n) => `Carica ${n}`),
    ];
    return this.exclusive<PlcDownloadResult>(
      owner,
      (m) => fail(m),
      (err) => fail(errText(err)), // mai un'eccezione verso il renderer
      async (op) => {
        const p = await this.prepare(owner, op, (t) => ({
          title: 'Carica nel dispositivo',
          message: `Caricare nella CPU ${cpuName(t)}?`,
          detail: `Operazione: Carica nel dispositivo\n${listLines(lines)}`,
          confirmLabel: 'Carica',
        }));
        if (!('c' in p)) return 'cancelled' in p.result ? p.result : fail(p.result.error);
        return this.runSteps(owner, op, p.c, steps);
      },
    );
  }

  async control(owner: PlcWriteOwner, cmd: PlcControlOp): Promise<PlcControlResult> {
    if (!isControlOp(cmd)) return { ok: false, error: 'Comando non valido' };
    const t = CONTROL_TEXTS[cmd];
    return this.exclusive<PlcControlResult>(
      owner,
      (m) => ({ ok: false, error: m }),
      (err) => ({ ok: false, error: errText(err) }),
      async (op) => {
        const p = await this.prepare(owner, op, (target) => ({
          title: t.title,
          message: `${t.what} della CPU ${cpuName(target)}?`,
          detail: `Operazione: ${t.title}`,
          confirmLabel: t.label,
        }));
        if (!('c' in p)) return p.result;
        try {
          if (owner.isDestroyed() || op.aborted)
            return { ok: false, error: 'Operazione interrotta' };
          return { ok: true, result: await runControl(p.c, cmd) };
        } finally {
          await p.c.close().catch(() => undefined);
        }
      },
    );
  }

  /**
   * Imposta l'ora della CPU. Dal PC: l'ora si prende dopo la conferma, con un solo `Date` e i campi
   * locali (la CPU non conosce fuso né ora legale). A mano: si scrive così com'è, millisecondi 0.
   */
  async setClock(owner: PlcWriteOwner, raw: unknown): Promise<PlcClockResult> {
    const spec = parseClockRequest(raw);
    if (typeof spec === 'string') return { ok: false, error: spec };
    // Solo un'indicazione per la conferma; l'ora scritta si prende dopo. Se la CPU non può averla,
    // non si chiede nemmeno la conferma.
    const preview = spec.pc ? fromDate(new Date(this.now())) : undefined;
    if (preview) {
      const bad = checkTime(preview as unknown as Record<string, unknown>);
      if (bad) return { ok: false, error: `L'ora del PC non è impostabile: ${bad}` };
    }
    const shown = spec.pc
      ? `Ora del PC al momento della conferma (adesso: ${formatTime(preview!)})`
      : `Nuova ora: ${formatTime(spec.time)}`;
    return this.exclusive<PlcClockResult>(
      owner,
      (m) => ({ ok: false, error: m }),
      (err) => ({ ok: false, error: errText(err) }),
      async (op) => {
        const p = await this.prepare(owner, op, (target) => {
          return {
            title: 'Imposta ora',
            message: `Impostare l'ora della CPU ${cpuName(target)}?`,
            detail: `${shown}\nGli interrupt dall'orologio (OB10) possono saltare`,
            confirmLabel: 'Imposta ora',
          };
        });
        if (!('c' in p)) return p.result;
        try {
          if (owner.isDestroyed() || op.aborted)
            return { ok: false, error: 'Operazione interrotta' };
          let t: S7DateTime;
          if (spec.pc) {
            t = fromDate(new Date(this.now())); // un solo istante: data e ora insieme
            const bad = checkTime(t as unknown as Record<string, unknown>);
            if (bad) return { ok: false, error: `L'ora del PC non è impostabile: ${bad}` };
          } else {
            t = spec.time;
          }
          await p.c.setClock(t);
          return { ok: true, written: t };
        } finally {
          await p.c.close().catch(() => undefined);
        }
      },
    );
  }

  /**
   * Scrive valori negli operandi I, Q, M e DB (tabella di controllo). Il renderer manda gli
   * operandi e i byte grezzi; qui si controlla tutto prima della conferma e le righe della
   * conferma si costruiscono dai byte che verranno scritti. Poi un collegamento `online-write`,
   * i gruppi da 20 item uno dopo l'altro (con la possibilità di interrompere fra l'uno e l'altro)
   * e la chiusura. L'esito è per operando; nessuna ripetizione.
   */
  async writeVars(owner: PlcWriteOwner, raw: unknown): Promise<PlcWriteVarsResult> {
    const parsed = parseWriteItems(raw);
    if (typeof parsed === 'string') return { ok: false, error: parsed };
    const items = parsed.map((x) => toWriteItem(x.target, x.data));
    const lines = parsed.map((x) => confirmLine(x.target, x.data));
    return this.exclusive<PlcWriteVarsResult>(
      owner,
      (m) => ({ ok: false, error: m }),
      (err) => ({ ok: false, error: errText(err) }),
      async (op) => {
        const p = await this.prepare(owner, op, (target) => ({
          title: 'Comanda variabili',
          message: `Scrivere ${items.length} ${items.length === 1 ? 'valore' : 'valori'} nella CPU ${cpuName(target)}?`,
          detail: `Operazione: Comanda variabili\n${listLines(lines)}`,
          confirmLabel: 'Comanda',
        }));
        if (!('c' in p)) return p.result;
        const results: ({ ok: true } | { ok: false; error: string })[] = [];
        try {
          for (let i = 0; i < items.length; i += MAX_WRITE_GROUP) {
            const group = items.slice(i, i + MAX_WRITE_GROUP);
            if (owner.isDestroyed() || op.aborted) {
              const why = op.aborted ? "Uscita dall'app" : 'Finestra chiusa';
              for (let j = 0; j < group.length; j++) {
                results.push({ ok: false, error: `${why}: non scritto` });
              }
              continue;
            }
            try {
              const rcs = await p.c.writeItems(group);
              for (const rc of rcs) {
                results.push(rc.returnCode === 0xff ? { ok: true } : { ok: false, error: rc.name });
              }
            } catch (err) {
              // La connessione di scrittura è una per operazione: dopo un errore non si insiste.
              for (let j = 0; j < group.length; j++) {
                results.push({ ok: false, error: errText(err) });
              }
              op.aborted = true;
            }
          }
          return { ok: true, results };
        } finally {
          await p.c.close().catch(() => undefined);
        }
      },
    );
  }

  /**
   * Una scrittura per finestra, anche durante la conferma, e una per CPU fra tutte le finestre;
   * registra l'operazione per `abortAll`.
   */
  private async exclusive<R>(
    owner: PlcOwner,
    busy: (message: string) => R,
    onError: (err: unknown) => R,
    fn: (op: Op) => Promise<R>,
  ): Promise<R> {
    if (this.closing) return onError(new Error('Chiusura in corso'));
    if (this.ops.has(owner)) return busy('Operazione già in corso');
    const t = this.o.service.target(owner);
    const cpu = t && cpuKey(t.access);
    if (cpu !== undefined && this.busyCpus.has(cpu)) {
      return busy('Operazione già in corso su questa CPU');
    }
    if (cpu !== undefined) this.busyCpus.add(cpu);
    let settle!: () => void;
    const op: Op = {
      aborted: false,
      stage: 'confirming',
      settled: new Promise<void>((r) => (settle = r)),
    };
    this.ops.set(owner, op);
    try {
      return await fn(op);
    } catch (err) {
      return onError(err);
    } finally {
      this.ops.delete(owner);
      if (cpu !== undefined) this.busyCpus.delete(cpu);
      settle();
    }
  }

  /**
   * Bersaglio, conferma nativa, poi collegamento in scrittura. Dopo la conferma si ricontrolla che
   * il collegamento online sia lo stesso, e dopo l'apertura che la CPU sia quella confermata.
   */
  private async prepare(
    owner: PlcWriteOwner,
    op: Op,
    texts: (target: Target) => WriteConfirmTexts,
  ): Promise<Prepared> {
    const target = this.o.service.target(owner);
    if (!target) return { result: { ok: false, error: 'Nessun collegamento online' } };
    const ok = await this.o.confirm(owner, texts(target));
    if (!ok || op.aborted) return { result: { ok: false, cancelled: true } };
    if (owner.isDestroyed()) return { result: { ok: false, error: 'Finestra chiusa' } };
    const again = this.o.service.target(owner);
    if (!again || again.linkId !== target.linkId) {
      return { result: { ok: false, error: 'Collegamento online cambiato: operazione annullata' } };
    }
    op.stage = 'running';
    const c = await this.open(target);
    return typeof c === 'string' ? { result: { ok: false, error: c } } : { c };
  }

  private async open(target: Target): Promise<WriteClient | string> {
    const access = target.access;
    let c: WriteClient;
    try {
      c = await this.connectFn({
        host: access.host,
        port: access.port ?? DEFAULT_PORT,
        rack: access.rack,
        slot: access.slot,
        connectionType: CONNECTION_TYPES[access.connectionType],
        ...(access.remoteTsap !== undefined ? { remoteTsap: access.remoteTsap } : {}),
        timeoutMs: this.connectTimeoutMs,
      });
    } catch (err) {
      return connectMessage(err, access);
    }
    try {
      const id = await c.identity();
      const want = target.identity;
      const serialDiffers =
        id.serialNumber !== undefined &&
        want.serial !== undefined &&
        id.serialNumber !== want.serial;
      if (id.orderNumber !== want.orderNumber || serialDiffers) {
        await c.close().catch(() => undefined);
        return 'La CPU raggiunta non è quella confermata (numero di ordinazione o di serie diverso): operazione annullata';
      }
    } catch (err) {
      await c.close().catch(() => undefined);
      return `Verifica della CPU non riuscita: ${errText(err)}`;
    }
    return c;
  }

  private async runSteps(
    owner: PlcWriteOwner,
    op: Op,
    c: WriteClient,
    steps: Step[],
  ): Promise<PlcDownloadResult> {
    const loaded: string[] = [];
    const deleted: string[] = [];
    const total = steps.length;
    let lastSent = -Infinity;
    try {
      for (const [i, s] of steps.entries()) {
        if (owner.isDestroyed() || op.aborted) {
          const why = op.aborted ? "Uscita dall'app" : 'Finestra chiusa';
          return { ok: false, loaded, deleted, error: `${why}: interrotto prima di ${s.name}` };
        }
        try {
          await s.run(c);
        } catch (err) {
          return { ok: false, loaded, deleted, failedAt: s.name, error: errText(err) };
        }
        (s.counts === 'load' ? loaded : deleted).push(s.name);
        const done = i + 1;
        const t = this.now();
        if ((done === total || t - lastSent >= PROGRESS_MIN_MS) && !owner.isDestroyed()) {
          lastSent = t;
          const p: PlcWriteProgress = { done, total, current: s.name };
          owner.send('plc:writeProgress', p);
        }
      }
      return { ok: true, loaded, deleted };
    } finally {
      await c.close().catch(() => undefined);
    }
  }
}

type Target = NonNullable<ReturnType<PlcService['target']>>;

function fail(error: string): PlcDownloadResult {
  return { ok: false, loaded: [], deleted: [], error };
}

function cpuName(t: {
  access: PlcAccess;
  identity: { moduleName?: string; orderNumber: string };
}): string {
  const port =
    t.access.port !== undefined && t.access.port !== DEFAULT_PORT ? `:${t.access.port}` : '';
  return `${t.identity.moduleName ?? t.identity.orderNumber} (${t.access.host}${port})`;
}

function fromDate(d: Date): S7DateTime {
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    hour: d.getHours(),
    minute: d.getMinutes(),
    second: d.getSeconds(),
    ms: d.getMilliseconds(),
  };
}

async function runControl(c: WriteClient, op: PlcControlOp): Promise<string> {
  switch (op) {
    case 'RUN':
      return (await c.start()).name;
    case 'STOP':
      return (await c.stop()).name;
    case 'COPY_RAM_TO_ROM':
      await c.copyRamToRom();
      return 'ok';
    case 'COMPRESS':
      await c.compressMemory();
      return 'ok';
  }
}
