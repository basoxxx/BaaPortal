import { parseBlockFile } from '@baaportal/s7comm';
import type { BlockType, ConnectOptions, S7WriteClient } from '@baaportal/s7comm';
import { connectWriteTcp } from '@baaportal/s7comm/node';
import type {
  PlcAccess,
  PlcBlockRef,
  PlcControlOp,
  PlcControlResult,
  PlcDownloadResult,
  PlcWriteProgress,
} from '@baaportal/ui';
import type { ConfirmFn } from './confirm';
import { connectMessage, type PlcOwner, type PlcService } from './plcService';

export const MAX_FILES = 2048;
export const MAX_FILE_BYTES = 1024 * 1024;
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
  'close' | 'downloadBlock' | 'deleteBlock' | 'stop' | 'start' | 'copyRamToRom' | 'compressMemory'
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
  for (const f of files) {
    if (!(f instanceof Uint8Array)) return 'File non valido';
    if (f.length > MAX_FILE_BYTES) return 'File di blocco troppo grande (massimo 1 MB)';
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

function listLines(lines: string[]): string {
  if (lines.length <= MAX_LIST_LINES) return lines.join('\n');
  return [...lines.slice(0, MAX_LIST_LINES), `… e altri ${lines.length - MAX_LIST_LINES}`].join(
    '\n',
  );
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type Step = { name: string; run: (c: WriteClient) => Promise<void>; counts: 'delete' | 'load' };

/**
 * Scritture nella CPU, una alla volta per finestra. Ogni operazione: conferma nativa, poi apre un
 * collegamento `online-write`, esegue, chiude (sempre, anche in caso di errore). L'indirizzo è
 * quello del collegamento online della stessa finestra: il renderer non lo passa mai.
 */
export class PlcWriteService {
  private readonly busy = new WeakSet<PlcOwner>();
  private readonly connectFn: PlcWriteConnectFn;
  private readonly connectTimeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly o: PlcWriteOptions) {
    this.connectFn = o.connect ?? connectWriteTcp;
    this.connectTimeoutMs = o.connectTimeoutMs ?? 3000;
    this.now = o.now ?? Date.now;
  }

  async download(
    owner: PlcWriteOwner,
    files: Uint8Array[],
    opts: { deleteBlocks?: PlcBlockRef[] } = {},
  ): Promise<PlcDownloadResult> {
    const req = parseDownloadRequest(files, opts);
    if (typeof req === 'string') return { ok: false, loaded: [], error: req };
    const names: string[] = [];
    for (const f of req.files) {
      try {
        const h = parseBlockFile(f).header;
        if (h.type === undefined)
          return fail(`Blocco di tipo sconosciuto (0x${h.typeCode.toString(16)})`);
        names.push(`${h.type}${h.number}`);
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
    if (this.busy.has(owner)) return fail('Operazione già in corso');
    this.busy.add(owner);
    try {
      const target = this.o.service.target(owner);
      if (!target) return fail('Nessun collegamento online');
      const ok = await this.o.confirm(owner, {
        title: 'Carica nel dispositivo',
        message: `Caricare nella CPU ${cpuName(target)}?`,
        detail: `Operazione: Carica nel dispositivo\n${listLines(lines)}`,
        confirmLabel: 'Carica',
      });
      if (!ok) return { ok: false, cancelled: true };
      const c = await this.open(target.access);
      if (typeof c === 'string') return fail(c);
      return await this.runSteps(owner, c, steps);
    } catch (err) {
      return fail(errText(err)); // mai un'eccezione verso il renderer
    } finally {
      this.busy.delete(owner);
    }
  }

  async control(owner: PlcWriteOwner, op: PlcControlOp): Promise<PlcControlResult> {
    if (!isControlOp(op)) return { ok: false, error: 'Comando non valido' };
    const t = CONTROL_TEXTS[op];
    if (this.busy.has(owner)) return { ok: false, error: 'Operazione già in corso' };
    this.busy.add(owner);
    try {
      const target = this.o.service.target(owner);
      if (!target) return { ok: false, error: 'Nessun collegamento online' };
      const ok = await this.o.confirm(owner, {
        title: t.title,
        message: `${t.what} della CPU ${cpuName(target)}?`,
        detail: `Operazione: ${t.title}`,
        confirmLabel: t.label,
      });
      if (!ok) return { ok: false, cancelled: true };
      const c = await this.open(target.access);
      if (typeof c === 'string') return { ok: false, error: c };
      try {
        return { ok: true, result: await runControl(c, op) };
      } finally {
        await c.close().catch(() => undefined);
      }
    } catch (err) {
      return { ok: false, error: errText(err) };
    } finally {
      this.busy.delete(owner);
    }
  }

  private async open(access: PlcAccess): Promise<WriteClient | string> {
    try {
      return await this.connectFn({
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
  }

  private async runSteps(
    owner: PlcWriteOwner,
    c: WriteClient,
    steps: Step[],
  ): Promise<PlcDownloadResult> {
    const loaded: string[] = [];
    const total = steps.length;
    let lastSent = -Infinity;
    try {
      for (const [i, s] of steps.entries()) {
        if (owner.isDestroyed()) {
          return {
            ok: false,
            loaded,
            failedAt: s.name,
            error: 'Finestra chiusa: caricamento interrotto',
          };
        }
        try {
          await s.run(c);
        } catch (err) {
          return { ok: false, loaded, failedAt: s.name, error: errText(err) };
        }
        if (s.counts === 'load') loaded.push(s.name);
        const done = i + 1;
        const t = this.now();
        if ((done === total || t - lastSent >= PROGRESS_MIN_MS) && !owner.isDestroyed()) {
          lastSent = t;
          const p: PlcWriteProgress = { done, total, current: s.name };
          owner.send('plc:writeProgress', p);
        }
      }
      return { ok: true, loaded };
    } finally {
      await c.close().catch(() => undefined);
    }
  }
}

function fail(error: string): PlcDownloadResult {
  return { ok: false, loaded: [], error };
}

function cpuName(t: {
  access: PlcAccess;
  identity: { moduleName?: string; orderNumber: string };
}): string {
  const port =
    t.access.port !== undefined && t.access.port !== DEFAULT_PORT ? `:${t.access.port}` : '';
  return `${t.identity.moduleName ?? t.identity.orderNumber} (${t.access.host}${port})`;
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
