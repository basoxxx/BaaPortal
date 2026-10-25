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

/** Tipi che si caricano: SFC, SFB e SDB no (il backup degli SDB è un altro compito). */
const TYPES: BlockType[] = ['OB', 'FB', 'FC', 'DB'];
export const MAX_BLOCKS = 4096;
export const MAX_BYTES = 64 * 1024 * 1024;
const CONNECTION_TYPES = { PG: 'pg', OP: 'op', S7_BASIC: 'basic' } as const;

export interface UploadServiceOptions {
  connect?: UploadConnectFn;
  connectTimeoutMs?: number;
  /** Intervallo minimo tra due avanzamenti (ms): al più 10 al secondo. */
  progressIntervalMs?: number;
  maxBlocks?: number;
  maxBytes?: number;
}

interface Run {
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
    if (this.runs.has(owner)) return { ok: false, error: 'Un caricamento è già in corso' };
    if (owner.isDestroyed()) return { ok: false, error: 'Finestra chiusa' };
    const ctl = new AbortController();
    const onGone = (): void => ctl.abort();
    owner.once('destroyed', onGone);
    const finished = this.run(owner, access, ctl.signal).finally(() => {
      owner.removeListener('destroyed', onGone);
      if (this.runs.get(owner)?.ctl === ctl) this.runs.delete(owner);
    });
    this.runs.set(owner, { ctl, onGone, finished });
    return finished;
  }

  cancel(owner: UploadOwner): void {
    this.runs.get(owner)?.ctl.abort();
  }

  /** Uscita dall'app: interrompe tutto e aspetta che i collegamenti siano chiusi. */
  async abortAll(): Promise<void> {
    const runs = [...this.runs.values()];
    for (const r of runs) r.ctl.abort();
    await Promise.all(runs.map((r) => r.finished.catch(() => undefined)));
  }

  private async run(
    owner: UploadOwner,
    access: PlcAccess,
    signal: AbortSignal,
  ): Promise<PlcUploadAllResult> {
    const cancelled = (): PlcUploadAllResult => ({ ok: false, cancelled: true });
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
          host: access.host,
          port: access.port ?? 102,
          rack: access.rack,
          slot: access.slot,
          connectionType: CONNECTION_TYPES[access.connectionType],
          ...(access.remoteTsap !== undefined ? { remoteTsap: access.remoteTsap } : {}),
          timeoutMs: this.connectTimeoutMs,
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

      const todo: { type: PlcUploadedFile['type']; number: number }[] = [];
      for (const type of TYPES) {
        const list = await raced(c.listBlocks(type));
        if (list === ABORTED) return cancelled();
        for (const e of list)
          todo.push({ type: type as PlcUploadedFile['type'], number: e.number });
        if (todo.length > this.maxBlocks) {
          return {
            ok: false,
            error: `Troppi blocchi nella CPU (oltre ${this.maxBlocks}): caricamento non eseguito`,
          };
        }
      }

      const files: PlcUploadedFile[] = [];
      const failed: Extract<PlcUploadAllResult, { ok: true }>['failed'] = [];
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
