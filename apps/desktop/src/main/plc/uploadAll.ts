import { S7Error, type BlockType, type S7Client } from '@baaportal/s7comm';
import { connectTcp } from '@baaportal/s7comm/node';
import type { ConnectOptions } from '@baaportal/s7comm';
import type {
  PlcAccess,
  PlcIdentity,
  PlcUploadAllResult,
  PlcUploadProgress,
  PlcUploadedFile,
} from '@baaportal/ui';
import { toPlcIdentity } from './plcMap';
import { connectOptions } from './access';
import { connectMessage } from './plcService';

/** Quanto serve di una finestra: abbastanza per i test senza Electron. */
export interface UploadOwner {
  isDestroyed(): boolean;
  send(channel: string, event: PlcUploadProgress): void;
  once(event: 'destroyed', cb: () => void): unknown;
  removeListener(event: 'destroyed', cb: () => void): unknown;
}

type UploadClient = Pick<S7Client, 'identity' | 'close' | 'listBlocks' | 'uploadWithInfo'>;
export type UploadConnectFn = (
  o: Omit<ConnectOptions, 'transport'> & { signal?: AbortSignal },
) => Promise<UploadClient>;

/** Tipi che si caricano da «Carica dal dispositivo»: SFC, SFB e SDB no. */
const TYPES: BlockType[] = ['OB', 'FB', 'FC', 'DB'];
/** Tipi del backup: in più gli SDB; SFC e SFB stanno nel sistema operativo della CPU. */
export const BACKUP_TYPES: BlockType[] = ['OB', 'FB', 'FC', 'DB', 'SDB'];

export type CollectedType = PlcUploadedFile['type'] | 'SDB';
export interface CollectedFile {
  type: CollectedType;
  number: number;
  bytes: Uint8Array;
}
export type CollectResult =
  | {
      ok: true;
      files: CollectedFile[];
      identity: PlcIdentity;
      failed: { type: CollectedType; number: number; error: string }[];
    }
  | { ok: false; error: string }
  | { ok: false; cancelled: true };

/** Chi ha avviato l'esecuzione: `cancel` interrompe solo le proprie, un backup non è un caricamento. */
export type RunKind = 'upload' | 'backup';

export interface CollectOptions {
  /** Il tipo di esecuzione (predefinito: `upload`). */
  kind?: RunKind;
  /** I tipi da elencare e caricare (predefiniti: OB, FB, FC e DB). */
  types?: readonly BlockType[];
  /** Controlla l'identità appena letta: una stringa è il motivo per cui non si prosegue. */
  verifyIdentity?: (id: PlcIdentity) => string | undefined;
}
export const MAX_BLOCKS = 4096;
export const MAX_BYTES = 64 * 1024 * 1024;

export interface UploadServiceOptions {
  connect?: UploadConnectFn;
  connectTimeoutMs?: number;
  /** Intervallo minimo tra due avanzamenti (ms): al più 10 al secondo. */
  progressIntervalMs?: number;
  maxBlocks?: number;
  maxBytes?: number;
}

interface Run {
  kind: RunKind;
  ctl: AbortController;
  onGone: () => void;
  finished: Promise<unknown>;
}

const ABORTED = Symbol('aborted');

/**
 * Carica tutti i blocchi OB, FB, FC e DB di una CPU, in sola lettura, su un collegamento proprio
 * aperto dall'`access` dato (non serve essere online nel progetto). Un caricamento per finestra;
 * la finestra distrutta o `abortAll` lo interrompono, `cancel` pure.
 */
export class UploadService {
  private readonly runs = new Map<UploadOwner, Run>();
  /** Dopo `abortAll` (uscita o aggiornamento) non parte più nessun caricamento. */
  private closing = false;
  private readonly connectFn: UploadConnectFn;
  private readonly connectTimeoutMs: number;
  private readonly progressIntervalMs: number;
  private readonly maxBlocks: number;
  private readonly maxBytes: number;

  constructor(o: UploadServiceOptions = {}) {
    this.connectFn = o.connect ?? (connectTcp as unknown as UploadConnectFn);
    this.connectTimeoutMs = o.connectTimeoutMs ?? 3000;
    this.progressIntervalMs = o.progressIntervalMs ?? 100;
    this.maxBlocks = o.maxBlocks ?? MAX_BLOCKS;
    this.maxBytes = o.maxBytes ?? MAX_BYTES;
  }

  async start(owner: UploadOwner, access: PlcAccess): Promise<PlcUploadAllResult> {
    // Con i tipi predefiniti i file sono solo OB, FB, FC e DB.
    return this.collect(owner, access) as Promise<PlcUploadAllResult>;
  }

  /** Il giro generico: `start` lo usa con i tipi predefiniti, il backup con gli SDB in più. */
  async collect(
    owner: UploadOwner,
    access: PlcAccess,
    opts: CollectOptions = {},
  ): Promise<CollectResult> {
    if (this.closing) return { ok: false, error: 'Chiusura in corso' };
    if (this.runs.has(owner)) return { ok: false, error: 'Un caricamento è già in corso' };
    if (owner.isDestroyed()) return { ok: false, error: 'Finestra chiusa' };
    const ctl = new AbortController();
    const onGone = (): void => ctl.abort();
    owner.once('destroyed', onGone);
    const finished = this.run(owner, access, ctl.signal, opts).finally(() => {
      owner.removeListener('destroyed', onGone);
      if (this.runs.get(owner)?.ctl === ctl) this.runs.delete(owner);
    });
    this.runs.set(owner, { kind: opts.kind ?? 'upload', ctl, onGone, finished });
    return finished;
  }

  /** Interrompe l'esecuzione della finestra solo se è del tipo dato (predefinito: il caricamento). */
  cancel(owner: UploadOwner, kind: RunKind = 'upload'): void {
    const run = this.runs.get(owner);
    if (run && run.kind === kind) run.ctl.abort();
  }

  /** C'è un caricamento (o il suo giro per un backup) in corso. */
  active(): boolean {
    return this.runs.size > 0;
  }

  /** Uscita dall'app: interrompe tutto e aspetta che i collegamenti siano chiusi. */
  resume(): void {
    this.closing = false;
  }

  async abortAll(): Promise<void> {
    this.closing = true;
    const runs = [...this.runs.values()];
    for (const r of runs) r.ctl.abort();
    await Promise.all(runs.map((r) => r.finished.catch(() => undefined)));
  }

  private async run(
    owner: UploadOwner,
    access: PlcAccess,
    signal: AbortSignal,
    opts: CollectOptions,
  ): Promise<CollectResult> {
    const types = opts.types ?? TYPES;
    const cancelled = (): CollectResult => ({ ok: false, cancelled: true });
    const aborted = new Promise<typeof ABORTED>((resolve) => {
      if (signal.aborted) resolve(ABORTED);
      else signal.addEventListener('abort', () => resolve(ABORTED), { once: true });
    });
    /** Corre contro l'interruzione: l'attesa finisce subito, la richiesta in corso muore con il socket. */
    const raced = <T>(p: Promise<T>): Promise<T | typeof ABORTED> => {
      p.catch(() => undefined);
      return Promise.race([p, aborted]);
    };
    let client: UploadClient | undefined;
    try {
      const opened = await raced(
        this.connectFn({
          ...connectOptions(access, this.connectTimeoutMs),
          mode: 'read-only',
          signal,
        }),
      );
      if (opened === ABORTED) return cancelled();
      client = opened;
      const c = client;
      if (signal.aborted) return cancelled();
      const idRaw = await raced(c.identity());
      if (idRaw === ABORTED) return cancelled();
      const identity: PlcIdentity = toPlcIdentity(idRaw);
      const refusal = opts.verifyIdentity?.(identity);
      if (refusal !== undefined) return { ok: false, error: refusal };

      const todo: { type: CollectedType; number: number }[] = [];
      for (const type of types) {
        const list = await raced(c.listBlocks(type));
        if (list === ABORTED) return cancelled();
        for (const e of list) todo.push({ type: type as CollectedType, number: e.number });
        if (todo.length > this.maxBlocks) {
          return {
            ok: false,
            error: `Troppi blocchi nella CPU (oltre ${this.maxBlocks}): caricamento non eseguito`,
          };
        }
      }

      const files: CollectedFile[] = [];
      const failed: Extract<CollectResult, { ok: true }>['failed'] = [];
      let bytes = 0;
      let last = 0;
      const emit = (done: number, current: string): void => {
        if (!owner.isDestroyed() && !signal.aborted) {
          owner.send('plc:uploadProgress', { done, total: todo.length, current });
        }
      };
      for (let i = 0; i < todo.length; i++) {
        const { type, number } = todo[i]!;
        let data: Uint8Array;
        try {
          const r = await raced(c.uploadWithInfo(type, number));
          if (r === ABORTED) return cancelled();
          data = r.bytes;
        } catch (e) {
          // La CPU rifiuta un blocco (p. es. protetto): gli altri si caricano lo stesso.
          if (e instanceof S7Error && e.code === 'CPU_ERROR') {
            failed.push({ type, number, error: e.message });
            continue;
          }
          throw e;
        }
        bytes += data.length;
        if (bytes > this.maxBytes) {
          return {
            ok: false,
            error: `Troppi dati dalla CPU (oltre ${this.maxBytes / (1024 * 1024)} MB): caricamento non eseguito`,
          };
        }
        files.push({ type, number, bytes: data });
        const now = Date.now();
        if (i < todo.length - 1 && now - last >= this.progressIntervalMs) {
          last = now;
          emit(i + 1, `${type}${number}`);
        }
      }
      if (signal.aborted) return cancelled();
      // L'ultimo avanzamento parte sempre, anche se l'ultimo blocco non è stato dato dalla CPU.
      const tail = todo[todo.length - 1];
      if (tail) emit(todo.length, `${tail.type}${tail.number}`);
      return { ok: true, files, identity, failed };
    } catch (e) {
      if (signal.aborted) return cancelled();
      if (
        e instanceof S7Error &&
        ['CONNECT_REFUSED', 'CONNECT_TIMEOUT', 'COTP_REJECTED'].includes(e.code)
      ) {
        return { ok: false, error: connectMessage(e, access) };
      }
      return {
        ok: false,
        error: client
          ? `Caricamento non riuscito: ${e instanceof Error ? e.message : String(e)}`
          : connectMessage(e, access),
      };
    } finally {
      if (client) await client.close().catch(() => undefined);
    }
  }
}
