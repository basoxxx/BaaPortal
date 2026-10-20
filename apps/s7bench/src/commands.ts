import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  S7Error,
  blockLanguageName,
  createRecorder,
  framesToJsonl,
  jsonlToFrames,
  kitZip,
  readKitZip,
  readPcap,
  type Area,
  type BlockType,
  type CapturedFrame,
  type CaptureRecorder,
  type ConnectionType,
  type KitProgress,
  type S7Client,
} from '@baaportal/s7comm';
import { collectTcp, connectTcp } from '@baaportal/s7comm/node';
import { FakeCpu } from '@baaportal/s7-server';
import { listen } from '@baaportal/s7-server/node';
import {
  formatBlockInfo,
  formatSzl,
  hexDump,
  hexN,
  isoOf,
  summarizeFrame,
  weekdayOf,
  hex2,
} from './format';

/** Argomenti sbagliati: codice di uscita 2. */
export class UsageError extends Error {}
/** Errore di lettura o scrittura di file: codice di uscita 3. */
export class FileError extends Error {}

export interface Ctx {
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
  out(line: string): void;
  err(line: string): void;
}

export interface Command {
  name: string;
  usage: string;
  summary: string;
  /** Parla con una CPU: vuole --host e accetta le opzioni di connessione. */
  network: boolean;
  /** Opzioni specifiche del comando, oltre a quelle comuni. */
  options: string[];
  run(ctx: Ctx): Promise<void>;
}

export const COMMON_OPTIONS = ['host', 'port', 'rack', 'slot', 'tipo', 'timeout', 'log'];

// ---- validazione ---------------------------------------------------------------------------

function intValue(name: string, raw: string, min: number, max: number): number {
  if (!/^\d+$/.test(raw)) throw new UsageError(`--${name}: "${raw}" non è un numero intero`);
  const n = Number(raw);
  if (n < min || n > max)
    throw new UsageError(`--${name}: ${n} fuori dall'intervallo ${min}-${max}`);
  return n;
}

function optInt(ctx: Ctx, name: string, def: number, min: number, max: number): number {
  const v = ctx.values[name];
  if (v === undefined) return def;
  if (typeof v !== 'string') throw new UsageError(`--${name} vuole un valore`);
  return intValue(name, v, min, max);
}

function optStr(ctx: Ctx, name: string): string | undefined {
  const v = ctx.values[name];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v === '') throw new UsageError(`--${name} vuole un valore`);
  return v;
}

function positionalCount(ctx: Ctx, cmd: Command, min: number, max: number): void {
  if (ctx.positionals.length < min || ctx.positionals.length > max) {
    throw new UsageError(`argomenti sbagliati.\nuso: s7bench ${cmd.usage}`);
  }
}

function numberArg(what: string, raw: string, min: number, max: number): number {
  const m = /^(?:0x([0-9a-f]+)|([0-9]+))$/i.exec(raw);
  if (!m) throw new UsageError(`${what}: "${raw}" non è un numero`);
  const n = m[1] !== undefined ? parseInt(m[1], 16) : Number(m[2]);
  if (n < min || n > max) throw new UsageError(`${what}: ${n} fuori dall'intervallo ${min}-${max}`);
  return n;
}

const BLOCK_TYPES: BlockType[] = ['OB', 'FB', 'FC', 'DB', 'SDB', 'SFC', 'SFB'];

function blockTypeArg(raw: string): BlockType {
  const t = BLOCK_TYPES.find((x) => x === raw.toUpperCase());
  if (!t) throw new UsageError(`tipo di blocco "${raw}" sconosciuto (${BLOCK_TYPES.join(', ')})`);
  return t;
}

const AREAS: Record<string, Area> = {
  I: 'I',
  E: 'I',
  Q: 'Q',
  A: 'Q',
  M: 'M',
  DB: 'DB',
  T: 'T',
  C: 'C',
};

function areaArg(raw: string): Area {
  const a = AREAS[raw.toUpperCase()];
  if (!a) throw new UsageError(`area "${raw}" sconosciuta (I/E, Q/A, M, DB, T, C)`);
  return a;
}

// ---- connessione ---------------------------------------------------------------------------

interface Conn {
  host: string;
  port: number;
  rack: number;
  slot: number;
  connectionType: ConnectionType;
  timeoutMs: number;
  log?: string;
}

function connOptions(ctx: Ctx): Conn {
  const host = optStr(ctx, 'host');
  if (host === undefined) throw new UsageError('manca --host');
  const tipo = optStr(ctx, 'tipo') ?? 'pg';
  if (tipo !== 'pg' && tipo !== 'op' && tipo !== 'base') {
    throw new UsageError(`--tipo: "${tipo}" non è pg, op o base`);
  }
  const timeoutMs = optInt(ctx, 'timeout', 5000, 1, 2 ** 31 - 1);
  return {
    host,
    port: optInt(ctx, 'port', 102, 1, 65535),
    rack: optInt(ctx, 'rack', 0, 0, 7),
    slot: optInt(ctx, 'slot', 2, 0, 31),
    connectionType: tipo === 'base' ? 'basic' : tipo,
    timeoutMs,
    ...(optStr(ctx, 'log') !== undefined ? { log: optStr(ctx, 'log')! } : {}),
  };
}

function writeFileOrThrow(path: string, data: string | Uint8Array, flag = 'w'): void {
  try {
    writeFileSync(path, data, { flag });
  } catch (e) {
    throw new FileError(
      `impossibile scrivere ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function readFileOrThrow(path: string): Uint8Array {
  try {
    return new Uint8Array(readFileSync(path));
  } catch (e) {
    throw new FileError(
      `impossibile leggere ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Salva la cattura della connessione anche se il comando è fallito. */
function saveLog(ctx: Ctx, c: Conn, rec: CaptureRecorder | undefined, failed: boolean): void {
  if (!c.log || !rec) return;
  try {
    writeFileOrThrow(c.log, framesToJsonl(rec.frames()));
  } catch (e) {
    if (!failed) throw e;
    ctx.err(`avviso: ${(e as Error).message}`);
  }
}

async function withClient<T>(ctx: Ctx, fn: (c: S7Client) => Promise<T>): Promise<T> {
  const c = connOptions(ctx);
  const recorder = c.log ? createRecorder() : undefined;
  let failed = false;
  try {
    const client = await connectTcp({
      host: c.host,
      port: c.port,
      rack: c.rack,
      slot: c.slot,
      connectionType: c.connectionType,
      timeoutMs: c.timeoutMs,
      ...(recorder ? { recorder } : {}),
    });
    try {
      return await fn(client);
    } finally {
      await client.close().catch(() => undefined);
    }
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    saveLog(ctx, c, recorder, failed);
  }
}

/** Un campo che la CPU può non fornire: l'errore della CPU diventa "assente", il resto no. */
async function optional<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof S7Error && e.code === 'CPU_ERROR') return undefined;
    throw e;
  }
}

const dash = (v: unknown): string => (v === undefined || v === '' ? '—' : String(v));

// ---- comandi -------------------------------------------------------------------------------

const info: Command = {
  name: 'info',
  usage: 'info --host <indirizzo>',
  summary: 'identità, modo, protezione, PDU, connessioni',
  network: true,
  options: [],
  async run(ctx) {
    positionalCount(ctx, info, 0, 0);
    await withClient(ctx, async (cl) => {
      const id = await optional(() => cl.identity());
      const mode = await optional(() => cl.mode());
      const prot = await optional(() => cl.protection());
      const comm = await optional(() => cl.communication());
      const rows: [string, string][] = [
        ["Numero d'ordine", dash(id?.orderNumber)],
        ['Versione', dash(id?.version)],
        ['Nome AS', dash(id?.asName)],
        ['Nome modulo', dash(id?.moduleName)],
        ['Numero di serie', dash(id?.serialNumber)],
        ['Modo', dash(mode)],
        [
          'Protezione',
          prot
            ? `livello valido ${dash(prot.validLevel)}, selettore ${dash(prot.modeSwitch)}`
            : '—',
        ],
        ['PDU', String(cl.pduLength)],
        ['Connessioni massime', dash(comm?.maxConnections)],
      ];
      const w = Math.max(...rows.map(([k]) => k.length));
      for (const [k, v] of rows) ctx.out(`${k.padEnd(w)} : ${v}`);
    });
  },
};

const szl: Command = {
  name: 'szl',
  usage: 'szl <id> [indice] --host <indirizzo>',
  summary: 'lista SZL in esadecimale e decodificata',
  network: true,
  options: [],
  async run(ctx) {
    positionalCount(ctx, szl, 1, 2);
    const id = numberArg('id SZL', ctx.positionals[0]!, 0, 0xffff);
    const index = ctx.positionals[1] ? numberArg('indice SZL', ctx.positionals[1], 0, 0xffff) : 0;
    await withClient(ctx, async (cl) => ctx.out(formatSzl(await cl.readSzl(id, index))));
  },
};

const leggi: Command = {
  name: 'leggi',
  usage: 'leggi <area> <db> <inizio> <lunghezza> --host <indirizzo>',
  summary: 'byte in esadecimale (aree I/E, Q/A, M, DB, T, C)',
  network: true,
  options: [],
  async run(ctx) {
    positionalCount(ctx, leggi, 4, 4);
    const area = areaArg(ctx.positionals[0]!);
    const db = numberArg('db', ctx.positionals[1]!, 0, 0xffff);
    const start = numberArg('inizio', ctx.positionals[2]!, 0, 0x1fffff);
    const length = numberArg('lunghezza', ctx.positionals[3]!, 1, 0xffff * 16);
    await withClient(ctx, async (cl) =>
      ctx.out(hexDump(await cl.readArea(area, db, start, length), start)),
    );
  },
};

const blocchi: Command = {
  name: 'blocchi',
  usage: 'blocchi [tipo] --host <indirizzo>',
  summary: 'conteggi dei blocchi, o elenco di un tipo',
  network: true,
  options: [],
  async run(ctx) {
    positionalCount(ctx, blocchi, 0, 1);
    const type = ctx.positionals[0] ? blockTypeArg(ctx.positionals[0]) : undefined;
    await withClient(ctx, async (cl) => {
      if (!type) {
        const counts = await cl.blockCounts();
        for (const t of BLOCK_TYPES) ctx.out(`${t.padEnd(4)} ${counts[t]}`);
        return;
      }
      const list = await cl.listBlocks(type);
      ctx.out(`${type}: ${list.length} blocchi`);
      for (const b of list) {
        ctx.out(
          `${String(b.number).padStart(6)}  ${blockLanguageName(b.language).padEnd(10)}  flag ${hexN(b.flags, 2)}`,
        );
      }
    });
  },
};

const infoblocco: Command = {
  name: 'infoblocco',
  usage: 'infoblocco <tipo> <n> --host <indirizzo>',
  summary: 'informazioni di un blocco',
  network: true,
  options: [],
  async run(ctx) {
    positionalCount(ctx, infoblocco, 2, 2);
    const type = blockTypeArg(ctx.positionals[0]!);
    const n = numberArg('numero', ctx.positionals[1]!, 0, 0xffff);
    await withClient(ctx, async (cl) => ctx.out(formatBlockInfo(await cl.blockInfo(type, n))));
  },
};

const carica: Command = {
  name: 'carica',
  usage: 'carica <tipo> <n> -o <file> [--sovrascrivi] --host <indirizzo>',
  summary: 'carica un blocco dal dispositivo e lo salva',
  network: true,
  options: ['output', 'sovrascrivi'],
  async run(ctx) {
    positionalCount(ctx, carica, 2, 2);
    const type = blockTypeArg(ctx.positionals[0]!);
    const n = numberArg('numero', ctx.positionals[1]!, 0, 0xffff);
    const file = optStr(ctx, 'output');
    if (!file) throw new UsageError('manca -o <file>');
    const overwrite = ctx.values['sovrascrivi'] === true;
    if (!overwrite && existsSync(file)) {
      throw new FileError(`${file} esiste già: usa --sovrascrivi per sostituirlo`);
    }
    await withClient(ctx, async (cl) => {
      const r = await cl.uploadWithInfo(type, n);
      writeFileOrThrow(file, r.bytes, overwrite ? 'w' : 'wx');
      for (const w of r.warnings) ctx.err(`avviso: ${w}`);
      ctx.out(`${type}${n}: ${r.bytes.length} byte scritti in ${file}`);
    });
  },
};

const ora: Command = {
  name: 'ora',
  usage: 'ora --host <indirizzo>',
  summary: "ora dell'orologio della CPU",
  network: true,
  options: [],
  async run(ctx) {
    positionalCount(ctx, ora, 0, 0);
    await withClient(ctx, async (cl) => {
      const t = await cl.readClock();
      ctx.out(`${isoOf(t)} (${weekdayOf(t)})`);
    });
  },
};

/** Annullamento con Ctrl+C: separato per poterlo sostituire. */
export const interruption = {
  /** Registra `fn` per SIGINT/SIGTERM; restituisce la funzione che toglie la registrazione. */
  on(fn: () => void): () => void {
    process.on('SIGINT', fn);
    process.on('SIGTERM', fn);
    return () => {
      process.off('SIGINT', fn);
      process.off('SIGTERM', fn);
    };
  },
};

const raccogli: Command = {
  name: 'raccogli',
  usage: 'raccogli -o <file.zip> [--senza-blocchi] [--sovrascrivi] --host <indirizzo>',
  summary: 'il kit di raccolta in sola lettura, in uno zip',
  network: true,
  options: ['output', 'senza-blocchi', 'sovrascrivi'],
  async run(ctx) {
    positionalCount(ctx, raccogli, 0, 0);
    const file = optStr(ctx, 'output');
    if (!file) throw new UsageError('manca -o <file.zip>');
    const overwrite = ctx.values['sovrascrivi'] === true;
    // Si controlla prima di raccogliere: la raccolta dura minuti e non va buttata per un file che c'è già.
    if (!overwrite && existsSync(file)) {
      throw new FileError(`${file} esiste già: usa --sovrascrivi per sostituirlo`);
    }
    const c = connOptions(ctx);
    const abort = new AbortController();
    const off = interruption.on(() => {
      ctx.err('interruzione richiesta: chiudo e salvo quanto raccolto');
      abort.abort();
    });
    let lastPhase = '';
    const onProgress = (p: KitProgress): void => {
      if (p.phase !== lastPhase || (p.done > 0 && p.done % 10 === 0)) {
        ctx.err(`[${p.phase}] ${p.done}/${p.total} ${p.message}`);
      }
      lastPhase = p.phase;
    };
    let result;
    try {
      result = await collectTcp(
        {
          host: c.host,
          port: c.port,
          rack: c.rack,
          slot: c.slot,
          connectionType: c.connectionType,
          timeoutMs: c.timeoutMs,
          includeBlocks: ctx.values['senza-blocchi'] !== true,
        },
        onProgress,
        abort.signal,
        's7bench',
      );
    } finally {
      off();
    }
    writeFileOrThrow(file, kitZip(result), overwrite ? 'w' : 'wx');
    if (c.log) {
      const cap = result.files['capture.jsonl'];
      if (cap) writeFileOrThrow(c.log, cap);
    }
    const s = result.summary;
    ctx.out(`kit scritto in ${file}`);
    ctx.out(`CPU: ${s.identity?.orderNumber ?? '—'}, modo ${s.mode ?? '—'}`);
    ctx.out(`SZL lette: ${s.szlRead}`);
    ctx.out(`blocchi elencati: ${s.blocksListed}, caricati: ${s.blocksUploaded}`);
    ctx.out(`frame rifiutati dal filtro di sola lettura: ${s.refusedCount}`);
    for (const w of s.warnings) ctx.out(`avviso: ${w}`);
    for (const e of s.errors) ctx.out(`errore ${e.code} in ${e.step}: ${e.message}`);
    if (abort.signal.aborted) {
      throw new S7Error('ABORTED', `raccolta interrotta: zip parziale in ${file}`);
    }
  },
};

const finto: Command = {
  name: 'finto',
  usage: 'finto [--porta 0] [--protezione 1|2|3] [--modo RUN|STOP] [--blocchi <cartella>]',
  summary: 'avvia il finto PLC su 127.0.0.1 e stampa "porta <n>"',
  network: false,
  options: ['porta', 'protezione', 'modo', 'blocchi'],
  async run(ctx) {
    positionalCount(ctx, finto, 0, 0);
    const port = optInt(ctx, 'porta', 0, 0, 65535);
    const level = optInt(ctx, 'protezione', 1, 1, 3) as 1 | 2 | 3;
    const mode = optStr(ctx, 'modo') ?? 'RUN';
    if (mode !== 'RUN' && mode !== 'STOP')
      throw new UsageError(`--modo: "${mode}" non è RUN o STOP`);
    const dir = optStr(ctx, 'blocchi');
    const cpu = new FakeCpu({ protectionLevel: level, mode });
    if (dir) {
      let names: string[];
      try {
        names = readdirSync(dir)
          .filter((n) => n.toLowerCase().endsWith('.blk'))
          .sort();
      } catch (e) {
        throw new FileError(
          `impossibile leggere la cartella ${dir}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      for (const n of names) {
        const bytes = readFileOrThrow(join(dir, n));
        try {
          cpu.addBlock(bytes);
        } catch (e) {
          throw new FileError(
            `blocco ${n} non valido: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }
    const server = await listen(cpu, { port });
    // Prima riga dell'uscita: i test e l'e2e la leggono per sapere la porta.
    ctx.out(`porta ${server.port}`);
    await new Promise<void>((done) => {
      const off = interruption.on(() => {
        off();
        done();
      });
    });
    await server.close();
  },
};

type Kind = 'pcap' | 'zip' | 'jsonl';

/** Il tipo si riconosce dal contenuto, non dall'estensione. */
function detect(bytes: Uint8Array): Kind {
  const w = (bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)
    return 'zip';
  const magic = w >>> 0;
  if ([0xa1b2c3d4, 0xd4c3b2a1, 0xa1b23c4d, 0x4d3cb2a1, 0x0a0d0d0a].includes(magic)) return 'pcap';
  return 'jsonl';
}

function listFrames(ctx: Ctx, frames: CapturedFrame[], withHex: boolean): void {
  const state = { szlFirst: false };
  frames.forEach((f, i) => {
    const { kind, summary } = summarizeFrame(f.dir, f.bytes, state);
    ctx.out(
      `${String(i).padStart(4)}  ${(f.t / 1000).toFixed(3).padStart(9)}s  ${f.dir}  ${kind.padEnd(9)} ${summary}`,
    );
    if (withHex) ctx.out(`      ${hex2(f.bytes)}`);
  });
}

const decodifica: Command = {
  name: 'decodifica',
  usage: 'decodifica <file.pcap|file.jsonl|file.zip> [--hex]',
  summary: 'elenco dei frame decodificati di una cattura',
  network: false,
  options: ['hex'],
  async run(ctx) {
    positionalCount(ctx, decodifica, 1, 1);
    const bytes = readFileOrThrow(ctx.positionals[0]!);
    const withHex = ctx.values['hex'] === true;
    switch (detect(bytes)) {
      case 'zip':
        listFrames(ctx, readKitZip(bytes).frames, withHex);
        break;
      case 'pcap': {
        const streams = readPcap(bytes);
        if (streams.length === 0) ctx.out('nessuna connessione S7 nella cattura');
        streams.forEach((s, i) => {
          ctx.out(`# connessione ${i + 1}: ${s.client} -> ${s.server}, ${s.frames.length} frame`);
          listFrames(ctx, s.frames, withHex);
        });
        break;
      }
      case 'jsonl':
        listFrames(ctx, jsonlToFrames(new TextDecoder().decode(bytes)), withHex);
        break;
    }
  },
};

/** Tabella dei comandi: nessuno scrive sulla CPU. */
export const COMMANDS: readonly Command[] = [
  info,
  szl,
  leggi,
  blocchi,
  infoblocco,
  carica,
  ora,
  raccogli,
  finto,
  decodifica,
];

export const COMMAND_NAMES: readonly string[] = COMMANDS.map((c) => c.name);
