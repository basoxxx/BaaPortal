import { readU16 } from '../bytes';
import { createRecorder, framesToJsonl } from '../capture/captureLog';
import { S7Client } from '../client';
import { S7Error, type S7ErrorCode } from '../errors';
import type { BlockInfo, BlockListEntry, BlockType } from '../s7/blocks';
import type { S7DateTime } from '../s7/clock';
import type { SzlList } from '../s7/szl';
import {
  commFrom,
  diagFrom,
  identityFrom,
  modeFrom,
  protectionFrom,
  type CpuIdentity,
  type CpuMode,
  type ProtectionInfo,
} from '../s7/szlLists';
import type { ConnectionType } from '../tsap';
import { pacedFactory, type TransportFactory } from '../transport';

export interface KitOptions {
  host: string;
  port?: number;
  rack?: number;
  slot?: number;
  connectionType?: ConnectionType;
  includeBlocks: boolean;
  /** Pausa minima tra la risposta e la richiesta successiva (predefinito 50 ms). */
  minIntervalMs?: number;
  timeoutMs?: number;
  /** Attesa prima dell'unica riapertura della connessione (predefinito 1000 ms). */
  reconnectDelayMs?: number;
  /** Obbligatorio per `collect`; `collectTcp` (in `./node`) mette quello TCP. */
  transport?: TransportFactory;
}

export interface KitProgress {
  phase: 'connect' | 'identity' | 'szl' | 'blocks' | 'upload' | 'done';
  done: number;
  total: number;
  message: string;
}

export interface KitError {
  step: string;
  code: S7ErrorCode;
  message: string;
}

export interface KitSummary {
  kitFormat: 1;
  baaportalVersion: string;
  startedAt: string;
  finishedAt: string;
  host: string;
  identity?: CpuIdentity;
  mode?: CpuMode;
  protection?: ProtectionInfo;
  /** Ora della CPU, senza fuso orario (come la dà la CPU). */
  clock?: string;
  pduLength?: number;
  blockCounts?: Record<BlockType, number>;
  szlRead: number;
  blocksListed: number;
  blocksUploaded: number;
  /** Frame rifiutati dal filtro di sola lettura, somma delle connessioni: deve essere 0. */
  refusedCount: number;
  /** Avvisi degli upload (p.es. lunghezza dichiarata diversa da quella ricevuta). */
  warnings: string[];
  errors: KitError[];
}

export interface KitResult {
  files: Record<string, Uint8Array>;
  summary: KitSummary;
}

const CONNECTION_CODES = new Set<S7ErrorCode>([
  'CLOSED',
  'TIMEOUT',
  'COTP_REJECTED',
  'CONNECT_REFUSED',
  'CONNECT_TIMEOUT',
]);

/** Riaperture consentite di fila; si ricarica dopo RECONNECT_RESET_STEPS passi riusciti. */
const RECONNECT_BUDGET = 1;
const RECONNECT_RESET_STEPS = 20;

/** Ordine dei tipi, come nel conteggio delle CPU. */
const TYPES: BlockType[] = ['OB', 'FB', 'FC', 'DB', 'SDB', 'SFC', 'SFB'];
/** Tetto alle SZL elencate dalla 0x0000 che il kit legge una per una. */
const MAX_SWEEP = 150;
/** (id, indice) sempre letti, oltre all'elenco della CPU. */
const EXPLICIT_SZL: [number, number][] = [
  [0x0011, 0],
  [0x001c, 0],
  [0x0131, 1],
  [0x0131, 2],
  [0x0131, 3],
  [0x0132, 4],
  [0x0232, 4],
  [0x0424, 0],
  [0x00a0, 0],
];

/** Attesa che finisce subito se il segnale scatta. */
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
const h4 = (n: number): string => n.toString(16).toUpperCase().padStart(4, '0');
const p2 = (n: number, w = 2): string => String(n).padStart(w, '0');

/** Nome del tipo nei file dello zip: `OB`, `DB`...; un tipo sconosciuto è `T<codice>`. */
export function kitTypeName(t: string | number): string {
  return typeof t === 'string' ? t : `T${t}`;
}

export function szlKey(id: number, index: number): string {
  return `${h4(id)}-${h4(index)}`;
}

export interface SzlFile {
  id: number;
  index: number;
  recordLength: number;
  records: string[];
  decoded?: unknown;
}

const hexUpper = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).toUpperCase().padStart(2, '0')).join('');

function toJson(v: unknown): string {
  return `${JSON.stringify(v, (_k, x: unknown) => (x instanceof Uint8Array ? hexUpper(x) : x), 2)}\n`;
}

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

function decodeSzl(l: SzlList): unknown {
  try {
    if (l.id === 0x0011 && l.index === 0) return identityFrom(l);
    if (l.id === 0x0424) return { mode: modeFrom(l) };
    if (l.id === 0x0131 && l.index === 1) return commFrom(l);
    if (l.id === 0x0132 || l.id === 0x0232) return protectionFrom(l);
    if (l.id === 0x00a0) return diagFrom(l);
  } catch {
    // niente campi decodificati: restano i record grezzi
  }
  return undefined;
}

function asS7(e: unknown): S7Error {
  return e instanceof S7Error
    ? e
    : new S7Error('PROTOCOL', e instanceof Error ? e.message : String(e));
}

class EndRun extends Error {}

function iso(t: S7DateTime): string {
  return `${p2(t.year, 4)}-${p2(t.month)}-${p2(t.day)}T${p2(t.hour)}:${p2(t.minute)}:${p2(t.second)}.${p2(t.ms, 3)}`;
}

/**
 * Raccolta in sola lettura da una CPU. Usa solo `S7Client`, quindi vale il filtro di sola
 * lettura. Non lancia per errori della CPU o della rete: ogni errore va in `summary.errors` e
 * lo zip si può comporre comunque.
 */
export async function collect(
  o: KitOptions,
  onProgress: (p: KitProgress) => void,
  signal?: AbortSignal,
  appVersion = 'dev',
): Promise<KitResult> {
  if (!o.transport) throw new TypeError('collect: manca il trasporto (usare collectTcp)');
  const factory = pacedFactory(o.transport, o.minIntervalMs ?? 50);
  const recorder = createRecorder();
  const startedAt = new Date();
  const errors: KitError[] = [];
  const warnings: string[] = [];
  const files: Record<string, Uint8Array> = {};
  const szlLists = new Map<string, SzlList>();
  let client: S7Client | undefined;
  let reconnects = 0;
  /** Passi riusciti di fila dall'ultimo errore: a RECONNECT_RESET_STEPS il budget di riapertura si ricarica. */
  let okStreak = 0;
  let refused = 0;
  let pduLength: number | undefined;
  const summary: Partial<KitSummary> = {};
  let szlRead = 0;
  let blocksListed = 0;
  let blocksUploaded = 0;

  const progress = (phase: KitProgress['phase'], done: number, total: number, message: string) => {
    try {
      onProgress({ phase, done, total, message });
    } catch {
      // un ascoltatore che lancia non ferma la raccolta
    }
  };

  const drop = async (): Promise<void> => {
    const c = client;
    client = undefined;
    if (!c) return;
    refused += c.refusedCount;
    try {
      await c.close();
    } catch {
      // già chiusa
    }
  };

  /** Riapre la connessione, se il budget lo permette: una per volta, con l'attesa prevista. */
  const reopen = async (name: string): Promise<void> => {
    if (reconnects >= RECONNECT_BUDGET) throw new EndRun();
    reconnects++;
    await sleep(o.reconnectDelayMs ?? 1000, signal);
    if (signal?.aborted) {
      errors.push({ step: name, code: 'ABORTED', message: 'operazione annullata' });
      throw new EndRun();
    }
  };

  const ensure = async (): Promise<S7Client> => {
    if (client?.closed) {
      // Un client chiuso non si riusa mai: se ne crea uno nuovo, e questo conta come riapertura.
      await drop();
      errors.push({ step: 'connect', code: 'CLOSED', message: 'connessione chiusa' });
      okStreak = 0;
      await reopen('connect');
    }
    if (client) return client;
    client = await S7Client.connect({
      host: o.host,
      port: o.port,
      rack: o.rack,
      slot: o.slot,
      connectionType: o.connectionType,
      timeoutMs: o.timeoutMs,
      transport: factory,
      recorder,
      signal,
    });
    pduLength = client.pduLength;
    return client;
  };

  /** Registra l'errore; 'retry' se la connessione si può riaprire, altrimenti 'fail' o fine. */
  const handle = async (name: string, e: unknown): Promise<'retry' | 'fail'> => {
    const err = asS7(e);
    errors.push({ step: name, code: err.code, message: err.message });
    if (err.code === 'ABORTED') throw new EndRun();
    okStreak = 0;
    if (!CONNECTION_CODES.has(err.code)) return 'fail';
    await drop();
    await reopen(name);
    return 'retry';
  };

  const step = async <T>(
    name: string,
    fn: (c: S7Client) => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false }> => {
    for (;;) {
      if (signal?.aborted) {
        errors.push({ step: name, code: 'ABORTED', message: 'operazione annullata' });
        throw new EndRun();
      }
      let c: S7Client;
      try {
        c = await ensure();
      } catch (e) {
        // La fine della raccolta non è un errore da registrare né da ritentare: sale fino al ciclo principale.
        if (e instanceof EndRun) throw e;
        if ((await handle('connect', e)) === 'retry') continue;
        return { ok: false };
      }
      try {
        const value = await fn(c);
        // Dopo abbastanza passi riusciti di fila una caduta isolata non pesa più sul budget.
        if (++okStreak >= RECONNECT_RESET_STEPS) reconnects = 0;
        return { ok: true, value };
      } catch (e) {
        if (e instanceof EndRun) throw e;
        if ((await handle(name, e)) === 'retry') continue;
        return { ok: false };
      }
    }
  };

  try {
    progress('connect', 0, 1, `Connessione a ${o.host}`);
    // la connessione si apre con la prima richiesta; la SZL 0x0000 è il primo passo
    const first = await step('szl 0000/0000', (c) => c.readSzl(0x0000, 0));
    progress('connect', 1, 1, 'Connesso');

    // ---- SZL ----
    const plan: [number, number][] = [];
    const seen = new Set<string>();
    const add = (id: number, index: number): void => {
      const k = szlKey(id, index);
      if (!seen.has(k)) {
        seen.add(k);
        plan.push([id, index]);
      }
    };
    add(0x0000, 0);
    if (first.ok) {
      szlLists.set(szlKey(0, 0), first.value);
      const listed = first.value.records
        .filter((r) => r.length >= 2)
        .map((r) => readU16(r, 0))
        .filter((id) => id >> 8 !== 0x0f);
      for (const id of listed.slice(0, MAX_SWEEP)) add(id, 0);
    }
    for (const [id, index] of EXPLICIT_SZL) add(id, index);
    const store = (l: SzlList): void => {
      const f: SzlFile = {
        id: l.id,
        index: l.index,
        recordLength: l.recordLength,
        records: l.records.map(hexUpper),
      };
      const d = decodeSzl(l);
      if (d !== undefined) f.decoded = d;
      files[`szl/${szlKey(l.id, l.index)}.json`] = text(toJson(f));
      szlRead++;
    };
    if (first.ok) store(first.value);
    let done = 1;
    for (const [id, index] of plan.slice(1)) {
      progress('szl', done, plan.length, `SZL 0x${h4(id)} indice ${index}`);
      const r = await step(`szl ${h4(id)}/${h4(index)}`, (c) => c.readSzl(id, index));
      if (r.ok) {
        szlLists.set(szlKey(id, index), r.value);
        store(r.value);
      }
      done++;
    }
    progress('identity', 0, 1, 'Identità della CPU');
    const l = (id: number, i: number): SzlList | undefined => szlLists.get(szlKey(id, i));
    try {
      const l11 = l(0x0011, 0);
      if (l11) summary.identity = identityFrom(l11, l(0x001c, 0));
    } catch (e) {
      errors.push({ step: 'identity', code: asS7(e).code, message: asS7(e).message });
    }
    try {
      const m = l(0x0424, 0);
      if (m) summary.mode = modeFrom(m);
    } catch (e) {
      errors.push({ step: 'mode', code: asS7(e).code, message: asS7(e).message });
    }
    try {
      const p = l(0x0132, 4) ?? l(0x0232, 4);
      if (p) summary.protection = protectionFrom(p);
    } catch (e) {
      errors.push({ step: 'protection', code: asS7(e).code, message: asS7(e).message });
    }
    progress('identity', 1, 1, 'Identità letta');

    // ---- blocchi ----
    const counts = await step('blockCounts', (c) => c.blockCounts());
    const listed: { type: BlockType; entry: BlockListEntry }[] = [];
    if (counts.ok) {
      summary.blockCounts = counts.value;
      const toList = TYPES.filter((t) => counts.value[t] > 0);
      for (const [i, t] of toList.entries()) {
        progress('blocks', i, toList.length, `Elenco ${t}`);
        const r = await step(`listBlocks ${t}`, (c) => c.listBlocks(t));
        if (r.ok) for (const entry of r.value) listed.push({ type: t, entry });
      }
    }
    blocksListed = listed.length;
    let n = 0;
    for (const { type, entry } of listed) {
      progress('blocks', n, listed.length, `Info ${type}${entry.number}`);
      const r = await step(`blockInfo ${type}${entry.number}`, (c) =>
        c.blockInfo(type, entry.number),
      );
      if (r.ok) {
        const info: BlockInfo = r.value;
        files[`blockinfo/${kitTypeName(type)}${entry.number}.json`] = text(
          toJson({ listEntry: entry, info }),
        );
      }
      n++;
    }

    if (o.includeBlocks) {
      n = 0;
      for (const { type, entry } of listed) {
        progress('upload', n, listed.length, `Caricamento ${type}${entry.number}`);
        const r = await step(`upload ${type}${entry.number}`, (c) =>
          c.uploadWithInfo(type, entry.number),
        );
        if (r.ok) {
          files[`blocchi/${kitTypeName(type)}${entry.number}.blk`] = r.value.bytes;
          blocksUploaded++;
          for (const w of r.value.warnings) warnings.push(`${type}${entry.number}: ${w}`);
        }
        n++;
      }
    }

    const clock = await step('clock', (c) => c.readClock());
    if (clock.ok) summary.clock = iso(clock.value);
  } catch (e) {
    if (!(e instanceof EndRun)) {
      const err = asS7(e);
      errors.push({ step: 'kit', code: err.code, message: err.message });
    }
  } finally {
    await drop();
  }

  files['capture.jsonl'] = text(framesToJsonl(recorder.frames()));
  const out: KitSummary = {
    kitFormat: 1,
    baaportalVersion: appVersion,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    host: o.host,
    ...summary,
    ...(pduLength !== undefined ? { pduLength } : {}),
    szlRead,
    blocksListed,
    blocksUploaded,
    refusedCount: refused,
    warnings,
    errors,
  };
  progress('done', 1, 1, 'Raccolta finita');
  return { files, summary: out };
}
