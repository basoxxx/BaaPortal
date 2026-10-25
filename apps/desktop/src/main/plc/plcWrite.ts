import { createHash, randomUUID } from 'node:crypto';
import {
  diagRecordsFrom,
  modeFrom,
  parseBlockFile,
  planWrites,
  protectionFrom,
  S7Error,
} from '@baaportal/s7comm';
import type { BlockType, ConnectOptions, S7DateTime, S7WriteClient } from '@baaportal/s7comm';
import { connectWriteTcp } from '@baaportal/s7comm/node';
import { BACKUP_MAX_BYTES, BackupFormatError, decodeBackup } from '@baaportal/project';
import type {
  PlcAccess,
  PlcBlockRef,
  PlcControlOp,
  PlcClockResult,
  PlcControlResult,
  PlcDownloadResult,
  PlcRestorePlanResult,
  PlcRestoreResult,
  PlcWriteProgress,
  PlcWriteVarsResult,
  RestoreOutcomeRow,
} from '@baaportal/ui';
import type { ConfirmFn, WriteConfirmTexts } from './confirm';
import { FRCE_LED, forceFrom, view as diagView } from './diagnostics';
import { toPlcMode } from './plcMap';
import {
  planRestore,
  restoreLines,
  restoreRows,
  stepName,
  type RestorePlan,
  type RestoreStep,
} from './restore';
import { connectMessage, type PlcOwner, type PlcService } from './plcService';
import { confirmLine, parseWriteItems, toWriteItem } from './watchOnline';

/** PDU minima di una CPU S7-300: serve solo ad annunciare nella conferma quante richieste partiranno. */
const NOTICE_PDU = 240;

export const MAX_FILES = 2048;
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const LOADABLE = ['OB', 'FB', 'FC', 'DB'];
const DEFAULT_PORT = 102;
const CONNECTION_TYPES = { PG: 'pg', OP: 'op', S7_BASIC: 'basic' } as const;
const DELETABLE = ['OB', 'FB', 'FC', 'DB'];
const MAX_LIST_LINES = 20;
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
  | 'pduLength'
>;
export type PlcWriteConnectFn = (
  o: Omit<ConnectOptions, 'transport' | 'mode'>,
) => Promise<WriteClient>;

/** Il collegamento del ripristino: il client di scrittura più SZL, lista dei job e `_DELE` degli SDB. */
export type RestoreClient = WriteClient &
  Pick<S7WriteClient, 'readSzl' | 'readJobList' | 'deleteSystemBlock'>;
export type PlcRestoreConnectFn = (
  o: Omit<ConnectOptions, 'transport' | 'mode'>,
) => Promise<RestoreClient>;

/** Scelta e lettura del file da ripristinare (la finestra nativa sta in `ipc.ts`). */
export interface RestoreFileIo {
  pick(owner: PlcOwner): Promise<string | null>;
  size(path: string): Promise<number>;
  read(path: string): Promise<Uint8Array>;
}

export interface PlcWriteOptions {
  service: Pick<PlcService, 'target'> & Partial<Pick<PlcService, 'read' | 'modeOf' | 'onLinkEnd'>>;
  confirm: ConfirmFn;
  connectTimeoutMs?: number;
  /** Iniettabile nei test (collegamento finto). */
  connect?: PlcWriteConnectFn;
  /** Iniettabile nei test: orologio per il limite degli avanzamenti. */
  now?: () => number;
  /** Ripristino (sperimentale): collegamento `online-restore`, file e attese iniettabili. */
  restoreConnect?: PlcRestoreConnectFn;
  restoreFile?: RestoreFileIo;
  sleep?: (ms: number) => Promise<void>;
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
  /** Le CPU con un ripristino in corso: l'osservazione del blocco non parte (vedi `restoringOn`). */
  private readonly restoringCpus = new Set<string>();
  /** Dopo `abortAll` (uscita dall'app) non parte più nessuna scrittura. */
  private closing = false;
  private readonly connectFn: PlcWriteConnectFn;
  private readonly restoreConnectFn: PlcRestoreConnectFn;
  private readonly connectTimeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Piani di ripristino preparati: restano qui, legati alla finestra e al collegamento. */
  private readonly plans = new Map<
    string,
    {
      owner: PlcOwner;
      linkId: number;
      plan: RestorePlan;
      /** Gli SDB che la CPU aveva alla preparazione. */
      sdbs: number[];
      dispose: () => void;
    }
  >();
  /** Prima di un ripristino ferma l'osservazione del blocco sulla stessa CPU (la imposta `plcIpc`). */
  beforeRestore?: (owner: PlcOwner) => Promise<void>;
  private restoreFileIo?: RestoreFileIo;

  constructor(private readonly o: PlcWriteOptions) {
    this.connectFn = o.connect ?? ((a) => connectWriteTcp(a));
    this.restoreConnectFn =
      o.restoreConnect ?? ((a) => connectWriteTcp(a, 'online-restore') as Promise<RestoreClient>);
    this.restoreFileIo = o.restoreFile;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.connectTimeoutMs = o.connectTimeoutMs ?? 3000;
    this.now = o.now ?? Date.now;
  }

  /** Piani di ripristino ancora in attesa di essere usati (serve ai test). */
  pendingPlans(): number {
    return this.plans.size;
  }

  /** Toglie un piano (e i suoi byte) dalla memoria: usato, sostituito, finestra chiusa o link finito. */
  private dropPlan(token: string): void {
    const p = this.plans.get(token);
    if (!p) return;
    this.plans.delete(token);
    p.dispose();
  }

  /** Un ripristino è in corso su questa CPU. */
  restoringOn(access: PlcAccess): boolean {
    return this.restoringCpus.has(cpuKey(access));
  }

  /** C'è un ripristino in corso su una qualunque CPU (conta come lavoro sul PLC per `busy`). */
  restoring(): boolean {
    return this.restoringCpus.size > 0;
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

  /** Imposta la scelta e la lettura del file da ripristinare (la finestra nativa sta in `ipc.ts`). */
  setRestoreFile(io: RestoreFileIo): void {
    this.restoreFileIo = io;
  }

  /** Ferma il ripristino (o ogni scrittura) di questa finestra prima del passo successivo. */
  interrupt(owner: PlcOwner): void {
    const op = this.ops.get(owner);
    if (op) op.aborted = true;
  }

  /** Annulla `abortAll`: l'uscita o l'aggiornamento sono stati rinviati. */
  resume(): void {
    this.closing = false;
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
    const requests = planWrites(items, NOTICE_PDU).length;
    const notice =
      requests > 1
        ? `\nLe scritture partono in più richieste (fino a ${requests}): se una fallisce, quelle precedenti restano scritte.`
        : '';
    return this.exclusive<PlcWriteVarsResult>(
      owner,
      (m) => ({ ok: false, error: m }),
      (err) => ({ ok: false, error: errText(err) }),
      async (op) => {
        const p = await this.prepare(owner, op, (target) => ({
          title: 'Comanda variabili',
          message: `Scrivere ${items.length} ${items.length === 1 ? 'valore' : 'valori'} nella CPU ${cpuName(target)}?`,
          detail: `Operazione: Comanda variabili\n${listLines(lines)}${notice}`,
          confirmLabel: 'Comanda',
        }));
        if (!('c' in p)) return p.result;
        const results: ({ ok: true } | { ok: false; error: string })[] = [];
        let failed = false;
        try {
          // Un gruppo per richiesta, come la PDU negoziata col collegamento aperto.
          const groups = planWrites(items, p.c.pduLength);
          for (const group of groups) {
            if (failed || owner.isDestroyed() || op.aborted) {
              const why = failed
                ? 'Non scritto: scrittura interrotta dopo un errore'
                : op.aborted
                  ? "Uscita dall'app: non scritto"
                  : 'Finestra chiusa: non scritto';
              for (let j = 0; j < group.length; j++) results.push({ ok: false, error: why });
              continue;
            }
            try {
              const rcs = await p.c.writeItems(group);
              for (const rc of rcs) {
                results.push(rc.returnCode === 0xff ? { ok: true } : { ok: false, error: rc.name });
              }
            } catch (e) {
              // Un rifiuto nell'intestazione (p. es. protezione 0xD241) è certo: nulla è stato scritto.
              // Altrimenti la richiesta può essere arrivata alla CPU: l'esito non si conosce.
              // In ogni caso non si insiste.
              const error =
                e instanceof S7Error && e.code === 'CPU_ERROR'
                  ? `Rifiutato dalla CPU: ${e.message}`
                  : 'Esito sconosciuto: la CPU potrebbe averlo scritto';
              for (let j = 0; j < group.length; j++) results.push({ ok: false, error });
              failed = true;
            }
          }
          return { ok: true, results };
        } finally {
          await p.c.close().catch(() => undefined);
        }
      },
    );
  }

  // ---- ripristino di un backup (sperimentale, proto §19.5) -----------------------------------

  /**
   * Prepara il ripristino: finestra di apertura nativa, lettura sicura del `.baapbak`, elenco dei
   * blocchi e controllo del forzamento sulla CPU collegata. Nessuna scrittura e nessuna rete oltre
   * alla lettura sul collegamento della sorveglianza. Il piano resta qui; il renderer riceve le
   * righe e un `token` monouso.
   */
  async restorePlan(owner: PlcOwner): Promise<PlcRestorePlanResult> {
    const io = this.restoreFileIo;
    const svc = this.o.service;
    if (!io || !svc.read) return { ok: false, error: 'Ripristino non disponibile' };
    try {
      const target = this.o.service.target(owner);
      if (!target) return { ok: false, error: 'Nessun collegamento online' };
      const path = await io.pick(owner);
      if (path === null || owner.isDestroyed()) return { ok: false, cancelled: true };
      const now = this.o.service.target(owner);
      if (!now || now.linkId !== target.linkId) {
        return { ok: false, error: 'Nessun collegamento online' };
      }
      if ((await io.size(path)) > BACKUP_MAX_BYTES) {
        return { ok: false, error: 'File di backup troppo grande' };
      }
      let decoded;
      try {
        decoded = decodeBackup(await io.read(path), (b) =>
          createHash('sha256').update(b).digest('hex'),
        );
      } catch (e) {
        if (e instanceof BackupFormatError) return { ok: false, error: e.message };
        throw e;
      }
      const warnings: string[] = [];
      const online = await svc.read(owner, async (run) => {
        const blocks: { type: string; number: number }[] = [];
        for (const type of ['OB', 'FB', 'FC', 'DB', 'SDB'] as const) {
          for (const e of await run((c) => c.listBlocks(type)))
            blocks.push({ type, number: e.number });
        }
        let force = false;
        try {
          force = forceFrom(await run((c) => c.readSzl(0x0174, FRCE_LED)));
        } catch (e) {
          if (e instanceof S7Error && (e.code === 'CLOSED' || e.code === 'TIMEOUT')) throw e;
          warnings.push('Stato del forzamento non leggibile dalla CPU');
        }
        let protection: string | undefined;
        try {
          const p = protectionFrom(await run((c) => c.readSzl(0x0232, 4)));
          if ((p.validLevel ?? 0) >= 2) protection = PROTECTED;
        } catch (e) {
          if (e instanceof S7Error && (e.code === 'CLOSED' || e.code === 'TIMEOUT')) throw e;
          protection = PROTECTION_UNREADABLE;
        }
        return { blocks, force, protection };
      });
      if (!online.ok) return { ok: false, error: online.error };
      if (online.value.protection) return { ok: false, error: online.value.protection };
      if (online.value.force) {
        return {
          ok: false,
          error: FORCE_ACTIVE,
        };
      }
      // §19.5.0: il backup si ripristina solo su una CPU dello stesso tipo
      const backupCpu = decoded.manifest.cpu.orderNumber;
      if (backupCpu !== target.identity.orderNumber) {
        return {
          ok: false,
          error: `Il backup è di una CPU di tipo diverso (${backupCpu}) da quella collegata (${target.identity.orderNumber}): ripristino non possibile`,
        };
      }
      const plan = planRestore(decoded.manifest, decoded.files, online.value.blocks);
      if (typeof plan === 'string') return { ok: false, error: plan };
      for (const [t, p] of this.plans) if (p.owner === owner) this.dropPlan(t);
      const token = randomUUID();
      // I byte del backup non restano in memoria se la finestra si chiude o il collegamento finisce
      const drop = (): void => this.dropPlan(token);
      const offLink = this.o.service.onLinkEnd?.(owner, drop);
      owner.once('destroyed', drop);
      const dispose = (): void => {
        offLink?.();
        owner.removeListener('destroyed', drop);
      };
      const sdbs = online.value.blocks.filter((b) => b.type === 'SDB').map((b) => b.number);
      this.plans.set(token, { owner, linkId: target.linkId, plan, sdbs, dispose });
      return { ok: true, token, rows: restoreRows(plan), warnings };
    } catch (e) {
      return { ok: false, error: errText(e) }; // mai un'eccezione verso il renderer
    }
  }

  /**
   * Esegue il ripristino (SPERIMENTALE, mai provato su una CPU reale): osservazione fermata, conferma,
   * collegamento `online-restore` con identità ricontrollata,
   * lista dei job, conferma e STOP, i passi del piano uno dopo l'altro, riavvio solo se richiesto e
   * confermato, elenco dei blocchi riletto. Nessuna ripetizione, nessun annullamento di ciò che è
   * già stato fatto.
   */
  async restore(owner: PlcWriteOwner, raw: unknown): Promise<PlcRestoreResult> {
    const req = parseRestoreRequest(raw);
    if (typeof req === 'string') return restoreFail(req);
    return this.exclusive<PlcRestoreResult>(
      owner,
      (m) => restoreFail(m),
      (err) => restoreFail(errText(err)),
      async (op) => {
        const t = this.o.service.target(owner);
        const cpu = t && cpuKey(t.access);
        if (cpu !== undefined) this.restoringCpus.add(cpu);
        try {
          const res = await this.runRestore(owner, op, req);
          await this.settleOutcome(owner, res);
          return res;
        } finally {
          if (cpu !== undefined) this.restoringCpus.delete(cpu);
        }
      },
    );
  }

  private async runRestore(
    owner: PlcWriteOwner,
    op: Op,
    req: { token: string; restart: boolean },
  ): Promise<PlcRestoreResult> {
    const saved = this.plans.get(req.token);
    if (!saved || saved.owner !== owner) {
      return restoreFail('Piano di ripristino non valido o già usato: prepararlo di nuovo');
    }
    this.dropPlan(req.token); // monouso
    const plan = saved.plan;
    const target = this.o.service.target(owner);
    if (!target || target.linkId !== saved.linkId) {
      return restoreFail('Il collegamento online è cambiato dopo la preparazione: ripetere');
    }
    const rows: RestoreOutcomeRow[] = [
      ...plan.steps.map<RestoreOutcomeRow>((s) => ({
        name: stepName(s.type, s.number),
        outcome: 'notDone',
        error: 'Non caricato',
      })),
      ...plan.skipped.map<RestoreOutcomeRow>((s) => ({
        name: stepName(s.type, s.number),
        outcome: 'skipped',
        error: s.why,
      })),
      ...plan.cpuOnly.map<RestoreOutcomeRow>((b) => ({
        name: stepName(b.type, b.number),
        outcome: 'kept',
      })),
    ];
    let stopConfirmed = false;
    const cancelled = (): PlcRestoreResult => ({
      ok: false,
      cancelled: true,
      rows,
      cpuStopped: false,
    });
    const fin = (error: string, cpuStopped = false, stopUnconfirmed = false): PlcRestoreResult => ({
      ok: false,
      error,
      rows,
      cpuStopped,
      ...(stopUnconfirmed ? { stopUnconfirmed } : {}),
    });

    await this.beforeRestore?.(owner);
    const lines = restoreLines(plan);
    const go = await this.o.confirm(owner, {
      title: 'Ripristina backup (sperimentale)',
      message: `Ripristinare il backup nella CPU ${cpuName(target)}?`,
      detail: `${listLines(lines)}\n${RESTORE_NOTICE}`,
      confirmLabel: 'Ripristina backup (sperimentale)',
    });
    if (!go || op.aborted) return cancelled();
    if (owner.isDestroyed()) return fin('Finestra chiusa');
    const again = this.o.service.target(owner);
    if (!again || again.linkId !== target.linkId) {
      return fin('Collegamento online cambiato: operazione annullata');
    }
    op.stage = 'running';
    const opened = await this.open(target, this.restoreConnectFn);
    if (typeof opened === 'string') return fin(opened);
    const c = opened as RestoreClient;
    let stopSent = false;
    let restarted = false;
    try {
      // 1. nessun job di test: altrimenti la CPU rifiuterebbe l'assegnazione dei parametri
      const noJobs = async (): Promise<boolean> =>
        !(await c.readJobList()).some((j) => j.fn !== 0x10);
      if (!(await noJobs())) return fin(JOBS_ACTIVE);
      // forzamento e protezione si ricontrollano qui: dal piano può essere cambiato tutto
      const refusal = await safetyRefusal(c);
      if (refusal) return fin(refusal);
      // 2. STOP (conferma separata), poi si rilegge il modo: conta solo STOP, HOLD no
      const mode = async (): Promise<string> => toPlcMode(modeFrom(await c.readSzl(0x0424, 0)));
      const m0 = await mode();
      if (m0 === 'HOLD') {
        return fin('La CPU è in HOLD (arresto su breakpoint): ripristino rifiutato');
      }
      if (m0 !== 'STOP') {
        const stop = await this.o.confirm(owner, {
          title: 'Ripristina backup (sperimentale)',
          message: 'Portare la CPU in STOP?',
          detail: 'Il ripristino degli SDB si fa solo con la CPU in STOP.',
          confirmLabel: 'Porta in STOP',
        });
        if (!stop || op.aborted) return cancelled();
        stopSent = true;
        await c.stop();
        for (let waited = 0; waited <= STOP_WAIT_MS; waited += POLL_MS) {
          if ((await mode()) === 'STOP') {
            stopConfirmed = true;
            break;
          }
          await this.sleep(POLL_MS);
        }
        if (!stopConfirmed) {
          return fin(
            'STOP inviato ma non confermato entro 5 s: la CPU potrebbe fermarsi più tardi. Nulla è stato scritto',
            false,
            true,
          );
        }
      }
      // un job può essere nato durante le conferme: ultimo controllo prima del primo passo
      if (!(await noJobs())) {
        return fin(
          `${JOBS_ACTIVE}. La CPU è rimasta in STOP, nulla è stato scritto`,
          stopConfirmed,
        );
      }
      // la lista degli SDB può essere cambiata (altro PG) dopo la preparazione: si rilegge prima di scrivere
      const live = await this.o.service.read?.(owner, async (run) =>
        (await run((x) => x.listBlocks('SDB'))).map((e) => e.number),
      );
      if (!live || !live.ok) {
        return fin(
          'Elenco degli SDB della CPU non rileggibile. La CPU è rimasta in STOP, nulla è stato scritto',
          stopConfirmed,
        );
      }
      const expected = [...saved.sdbs].sort((a, b) => a - b);
      const now = [...live.value].sort((a, b) => a - b);
      if (now.length !== expected.length || now.some((n, i) => n !== expected[i])) {
        return fin(
          'Gli SDB della CPU sono cambiati dopo la preparazione del ripristino: prepararlo di nuovo. La CPU è rimasta in STOP, nulla è stato scritto',
          stopConfirmed,
        );
      }
      // 3. i passi
      const failedAt = await this.runRestoreSteps(owner, op, c, plan.steps, rows);
      const ok = failedAt === undefined;
      let diag: PlcRestoreResult['diag'];
      let startUnknown: string | undefined;
      // 4. riavvio, solo con tutti i passi riusciti, richiesto e confermato
      if (ok && req.restart) {
        const run = await this.o.confirm(owner, {
          title: 'Ripristina backup (sperimentale)',
          message: 'Avviare la CPU (avviamento a caldo)?',
          detail: 'Il ripristino è finito. La CPU è in STOP.',
          confirmLabel: 'Avvia',
        });
        if (run && !op.aborted) {
          try {
            await c.start();
          } catch (err) {
            // il comando può essere arrivato: lo stato della CPU non è noto
            startUnknown = `Avviamento inviato ma esito sconosciuto, lo stato della CPU non è noto (${errText(err)})`;
          }
          for (let waited = 0; !startUnknown && waited <= RUN_WAIT_MS; waited += POLL_MS) {
            if ((await mode()) === 'RUN') {
              restarted = true;
              break;
            }
            await this.sleep(POLL_MS);
          }
          if (!restarted && !startUnknown) {
            try {
              diag = diagRecordsFrom(await c.readSzl(0x00a0, 0))
                .slice(0, 5)
                .map(diagView);
            } catch {
              // il buffer è un di più
            }
          }
        }
      }
      const result: PlcRestoreResult = {
        ok,
        ...(failedAt !== undefined
          ? { error: failedAt }
          : startUnknown
            ? { error: startUnknown }
            : {}),
        rows,
        cpuStopped: stopConfirmed && !restarted && !startUnknown,
        ...(req.restart && ok ? { restarted } : {}),
        ...(diag ? { diag } : {}),
      };
      return result;
    } catch (err) {
      // errore fuori dai passi (lista dei job, modo, STOP): niente è stato scritto, a parte uno STOP
      return fin(errText(err), stopConfirmed && !restarted, stopSent && !stopConfirmed);
    } finally {
      await c.close().catch(() => undefined);
    }
  }

  /**
   * Riletto l'elenco dei blocchi, l'esito si ricalcola: una riga declassata a `unknown` non può stare
   * sotto «Ripristino completato.».
   */
  private async settleOutcome(owner: PlcOwner, res: PlcRestoreResult): Promise<void> {
    try {
      await this.verifyLoaded(owner, res.rows);
    } catch {
      // l'elenco è un di più: le righe restano come sono
    }
    if (!res.ok) return;
    const bad = res.rows.find((r) => r.outcome === 'unknown' || r.outcome === 'rejected');
    if (bad) {
      res.ok = false;
      res.error = `${bad.name}: ${bad.error ?? 'Esito sconosciuto'}`;
    }
  }

  /** I passi del piano; si ferma al primo errore. Dà il messaggio d'errore, `undefined` se tutti riusciti. */
  private async runRestoreSteps(
    owner: PlcWriteOwner,
    op: Op,
    c: RestoreClient,
    steps: RestoreStep[],
    rows: RestoreOutcomeRow[],
  ): Promise<string | undefined> {
    let lastSent = -Infinity;
    for (const [i, s] of steps.entries()) {
      const name = stepName(s.type, s.number);
      const row = rows[i]!;
      if (owner.isDestroyed() || op.aborted) {
        return `${op.aborted ? 'Interrotto' : 'Finestra chiusa'} prima di ${name}`;
      }
      try {
        if (s.kind === 'deleteSdb') await c.deleteSystemBlock(s.number);
        else await c.downloadBlock(s.file!, { busyRetry: { sleep: (ms) => this.sleep(ms) } });
      } catch (err) {
        // Un rifiuto certo (errore della CPU o del filtro) non ha scritto nulla; ogni altro errore,
        // collegamento caduto compreso, lascia l'esito sconosciuto.
        const certain =
          err instanceof S7Error && (err.code === 'CPU_ERROR' || err.code === 'FORBIDDEN');
        row.outcome = certain ? 'rejected' : 'unknown';
        row.error = !certain
          ? 'Esito sconosciuto'
          : err instanceof S7Error && err.code === 'FORBIDDEN'
            ? FILTER_REFUSED // l'ha fermato il nostro filtro, non la CPU
            : `Rifiutato dalla CPU: ${errText(err)}`;
        return `${name}: ${row.error}`;
      }
      row.outcome = s.kind === 'deleteSdb' ? 'deleted' : 'loaded';
      row.error = s.kind === 'deleteSdb' ? 'Cancellato' : 'Caricato';
      const done = i + 1;
      const t = this.now();
      if ((done === steps.length || t - lastSent >= PROGRESS_MIN_MS) && !owner.isDestroyed()) {
        lastSent = t;
        owner.send('plc:writeProgress', { done, total: steps.length, current: name });
      }
    }
    return undefined;
  }

  /** Riletto l'elenco, una riga `loaded` il cui blocco non c'è diventa `unknown`. */
  private async verifyLoaded(owner: PlcOwner, rows: RestoreOutcomeRow[]): Promise<void> {
    const svc = this.o.service;
    if (!svc.read || !rows.some((r) => r.outcome === 'loaded')) return;
    const r = await svc.read(owner, async (run) => {
      const names = new Set<string>();
      for (const type of ['OB', 'FB', 'FC', 'DB', 'SDB'] as const) {
        for (const e of await run((c) => c.listBlocks(type))) names.add(stepName(type, e.number));
      }
      return names;
    });
    if (!r.ok) return;
    for (const row of rows) {
      if (row.outcome === 'loaded' && !r.value.has(row.name)) {
        row.outcome = 'unknown';
        row.error = 'Esito sconosciuto: il blocco non risulta nella CPU';
      }
    }
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

  private async open(
    target: Target,
    connect: PlcWriteConnectFn = this.connectFn,
  ): Promise<WriteClient | string> {
    const access = target.access;
    let c: WriteClient;
    try {
      c = await connect({
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

const RESTORE_NOTICE = 'FUNZIONE SPERIMENTALE, mai provata su una CPU reale. La CPU andrà in STOP.';
const JOBS_ACTIVE =
  "Una funzione di test attiva impedisce l'assegnazione dei parametri (job di test sulla CPU). Chiudere osservazioni e forzamenti in TIA o STEP 7 e riprovare";
const FILTER_REFUSED = 'Rifiutato da BaaPortal (frame non ammesso)';
const FORCE_ACTIVE =
  'Forzamento attivo sulla CPU: terminarlo con TIA o STEP 7 prima del ripristino';
const PROTECTED =
  'La protezione della CPU (livello 2 o 3) non permette la scrittura e BaaPortal non gestisce le password: ripristino rifiutato';
const PROTECTION_UNREADABLE = 'Livello di protezione della CPU non leggibile: ripristino rifiutato';
const FORCE_UNREADABLE = 'Stato del forzamento non leggibile dalla CPU: ripristino rifiutato';

/** Forzamento e protezione letti sul collegamento del ripristino; il testo del rifiuto, se c'è. */
async function safetyRefusal(c: Pick<RestoreClient, 'readSzl'>): Promise<string | undefined> {
  try {
    if (forceFrom(await c.readSzl(0x0174, FRCE_LED))) return FORCE_ACTIVE;
  } catch {
    return FORCE_UNREADABLE;
  }
  try {
    if ((protectionFrom(await c.readSzl(0x0232, 4)).validLevel ?? 0) >= 2) return PROTECTED;
  } catch {
    return PROTECTION_UNREADABLE;
  }
  return undefined;
}
const POLL_MS = 200;
const STOP_WAIT_MS = 5000;
const RUN_WAIT_MS = 10_000;

function restoreFail(error: string): PlcRestoreResult {
  return { ok: false, error, rows: [], cpuStopped: false };
}

/** Controlla ciò che arriva dal renderer: un token e se riavviare. */
function parseRestoreRequest(raw: unknown): { token: string; restart: boolean } | string {
  if (typeof raw !== 'object' || raw === null) return 'Richiesta di ripristino non valida';
  const r = raw as { token?: unknown; restart?: unknown };
  if (typeof r.token !== 'string' || r.token.length === 0 || r.token.length > 100) {
    return 'Richiesta di ripristino non valida';
  }
  if (typeof r.restart !== 'boolean') return 'Richiesta di ripristino non valida';
  return { token: r.token, restart: r.restart };
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
