import { strFromU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { jsonlToFrames, type CapturedFrame } from '../capture/captureLog';
import { S7Error } from '../errors';
import type { KitResult, KitSummary, SzlFile } from './collect';

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

const LEGGIMI = `BaaPortal - kit di raccolta dati da una CPU S7-300
===================================================

Questo archivio è stato creato dal kit di raccolta di BaaPortal, che ha letto la CPU
senza modificare nulla.

NULLA È STATO SCRITTO NEL PLC.
Il kit usa soltanto richieste di lettura (identificazione, liste di sistema, elenco e
caricamento dei blocchi, ora). Non cambia il programma, non cambia lo stato della CPU
(RUN/STOP), non scrive variabili e non imposta l'orologio. Il numero di richieste rifiutate
dal filtro di sola lettura è scritto in summary.json (refusedCount): deve essere 0.

Che cosa contiene
-----------------
- summary.json: riepilogo della raccolta (identità della CPU, modo, conteggi, avvisi ed
  errori incontrati passo per passo).
- capture.jsonl: il registro completo dei telegrammi scambiati con la CPU, uno per riga
  (istante in ms, direzione tx/rx, byte in esadecimale).
- szl/: le liste di stato di sistema (SZL) lette, con i record in esadecimale.
- blockinfo/: le informazioni di ogni blocco elencato dalla CPU.
- blocchi/: i blocchi del programma (OB, FB, FC, DB, SFC, SFB, SDB) esattamente come la
  CPU li ha consegnati. Ci sono solo se la raccolta e stata fatta con il caricamento dei
  blocchi.

ATTENZIONE: riservatezza
------------------------
Se contiene la cartella blocchi/, questo archivio contiene il PROGRAMMA DEL TUO PLC, cioè
il codice e i dati del tuo impianto. Inviarlo solo a persone di cui ti fidi.

Grazie per l'aiuto: questi dati servono a migliorare BaaPortal.
`;

const NAME_RE =
  /^(LEGGIMI\.txt|summary\.json|capture\.jsonl|szl\/[0-9A-F]{4}-[0-9A-F]{4}\.json|(blocchi\/(?:OB|FB|FC|DB|SFC|SFB|SDB|T\d+)\d+\.blk)|(blockinfo\/(?:OB|FB|FC|DB|SFC|SFB|SDB|T\d+)\d+\.json))$/;

/** Data DOS senza fuso: fflate usa i campi locali, quindi si costruisce una data locale uguale all'UTC. */
function stableMtime(startedAt: string): Date {
  const d = new Date(startedAt);
  const t = Number.isNaN(d.getTime()) ? new Date(Date.UTC(2026, 0, 1)) : d;
  return new Date(
    Math.max(1980, t.getUTCFullYear()),
    t.getUTCMonth(),
    t.getUTCDate(),
    t.getUTCHours(),
    t.getUTCMinutes(),
    t.getUTCSeconds() - (t.getUTCSeconds() % 2),
  );
}

/** Zip deterministico: voci in ordine alfabetico, data fissa da `startedAt`, deflate livello 6. */
export function kitZip(r: KitResult): Uint8Array {
  const all: Record<string, Uint8Array> = {
    ...r.files,
    'LEGGIMI.txt': new TextEncoder().encode(LEGGIMI),
    'summary.json': new TextEncoder().encode(`${JSON.stringify(r.summary, null, 2)}\n`),
  };
  const mtime = stableMtime(r.summary.startedAt);
  const z: Zippable = {};
  for (const name of Object.keys(all).sort()) z[name] = [all[name]!, { level: 6, mtime }];
  return zipSync(z);
}

export interface ReadKit {
  summary: KitSummary;
  frames: CapturedFrame[];
  /** Per nome senza cartella né estensione, p.es. `DB5`. */
  blocks: Record<string, Uint8Array>;
  /** Per `<ID>-<INDICE>`, p.es. `0011-0000`. */
  szl: Record<string, SzlFile>;
  /** Per nome come i blocchi. */
  blockInfo: Record<string, unknown>;
}

const bad = (why: string): S7Error => new S7Error('PROTOCOL', `zip del kit non valido: ${why}`);

function parse(name: string, bytes: Uint8Array): unknown {
  try {
    return JSON.parse(strFromU8(bytes));
  } catch {
    throw bad(`${name} non è JSON valido`);
  }
}

/** Legge e controlla uno zip del kit. Lancia `S7Error('PROTOCOL')` se la struttura non è quella attesa. */
export function readKitZip(bytes: Uint8Array): ReadKit {
  let total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        if (f.originalSize > MAX_FILE_BYTES) throw bad(`${f.name} troppo grande`);
        total += f.originalSize;
        if (total > MAX_TOTAL_BYTES) throw bad('contenuto troppo grande');
        return true;
      },
    });
  } catch (e) {
    if (e instanceof S7Error) throw e;
    throw bad('non è un archivio zip leggibile');
  }
  for (const name of Object.keys(files)) {
    if (!NAME_RE.test(name)) throw bad(`file inatteso "${name}"`);
  }
  for (const need of ['summary.json', 'capture.jsonl', 'LEGGIMI.txt']) {
    if (!files[need]) throw bad(`manca ${need}`);
  }
  const summary = parse('summary.json', files['summary.json']!) as Partial<KitSummary> | null;
  if (typeof summary !== 'object' || summary === null || summary.kitFormat !== 1) {
    throw bad(
      `kitFormat ${String((summary as { kitFormat?: unknown } | null)?.kitFormat)} non supportato`,
    );
  }
  let frames: CapturedFrame[];
  try {
    frames = jsonlToFrames(strFromU8(files['capture.jsonl']!));
  } catch (e) {
    throw bad(e instanceof Error ? e.message : String(e));
  }
  const blocks: Record<string, Uint8Array> = {};
  const szl: Record<string, SzlFile> = {};
  const blockInfo: Record<string, unknown> = {};
  for (const [name, data] of Object.entries(files)) {
    let m = /^blocchi\/(.+)\.blk$/.exec(name);
    if (m) blocks[m[1]!] = data;
    m = /^szl\/(.+)\.json$/.exec(name);
    if (m) szl[m[1]!] = parse(name, data) as SzlFile;
    m = /^blockinfo\/(.+)\.json$/.exec(name);
    if (m) blockInfo[m[1]!] = parse(name, data);
  }
  return { summary: summary as KitSummary, frames, blocks, szl, blockInfo };
}
