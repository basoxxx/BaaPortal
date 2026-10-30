import { Unzip, UnzipInflate, UnzipPassThrough, strFromU8, strToU8, zipSync } from 'fflate';

export const BACKUP_FORMAT = 'baaportal-backup';
export const BACKUP_VERSION = 1;
/** Oltre questa dimensione l'archivio non si legge (difesa da archivi gonfiati). */
export const BACKUP_MAX_BYTES = 256 * 1024 * 1024;
/** Tetti sui byte veri decompressi: il manifest, e ogni blocco (la `length` del manifest, al più). */
const MANIFEST_MAX_BYTES = 64 * 1024;
const BLOCK_MAX_BYTES = 1024 * 1024;
const MANIFEST_FILE = 'manifest.json';
const BACKUP_TYPES = ['OB', 'FB', 'FC', 'DB', 'SDB'] as const;
export type BackupBlockType = (typeof BACKUP_TYPES)[number];

export interface BackupBlockEntry {
  type: BackupBlockType;
  number: number;
  /** Percorso nello zip: `blocks/<TIPO><numero>.blk`. */
  file: string;
  length: number;
  sha256: string;
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  createdAt: string;
  app: string;
  cpu: {
    orderNumber: string;
    serial?: string;
    moduleName?: string;
    firmware?: string;
    host: string;
    port: number;
    rack: number;
    slot: number;
  };
  mode: string;
  blocks: BackupBlockEntry[];
  failed: { type: BackupBlockType; number: number; error: string }[];
}

export class BackupFormatError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`File di backup non valido: ${detail}`);
    this.name = 'BackupFormatError';
    this.detail = detail;
  }
}

/** Percorso sicuro nello zip: relativo, senza `..`, senza barre rovesce né unità. */
function isSafePath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 200) return false;
  if (p.startsWith('/') || p.includes('\\') || /^[A-Za-z]:/.test(p) || p.includes('\0')) {
    return false;
  }
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

export const backupFileName = (type: BackupBlockType, number: number): string =>
  `blocks/${type}${number}.blk`;

/** Funzione di hash SHA-256 in esadecimale (la dà chi chiama: `node:crypto` nel processo principale). */
export type HashFn = (bytes: Uint8Array) => string;

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** Scrive il `.baapbak`: `manifest.json` e i file dei blocchi (`files` per percorso). */
export function encodeBackup(
  manifest: BackupManifest,
  files: Record<string, Uint8Array>,
): Uint8Array {
  const listed = manifest.blocks.map((b) => b.file);
  if (new Set(listed).size !== listed.length) throw new BackupFormatError('file duplicati');
  const given = Object.keys(files);
  if (given.length !== listed.length || !listed.every((f) => f in files)) {
    throw new BackupFormatError('i file non corrispondono al manifest');
  }
  for (const b of manifest.blocks) {
    if (b.file !== backupFileName(b.type, b.number) || files[b.file]!.length !== b.length) {
      throw new BackupFormatError(`voce non coerente (${b.file})`);
    }
  }
  const entries: Record<string, Uint8Array> = {
    [MANIFEST_FILE]: strToU8(JSON.stringify(manifest, null, 2)),
  };
  for (const [path, bytes] of Object.entries(files)) {
    if (!isSafePath(path)) throw new BackupFormatError(`percorso non valido (${path})`);
    entries[path] = bytes;
  }
  return zipSync(entries, { level: 0 });
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * Decomprime a flusso solo le voci richieste (`cap` dà il tetto in byte di ciascuna, `undefined`
 * la salta). I byte si contano mentre escono: appena un tetto è superato la voce si ferma, senza
 * fidarsi della dimensione dichiarata nell'archivio.
 */
/** Solo per i test: quanti byte ha gonfiato fflate in tutto. */
export interface InflateStats {
  inflated: number;
}

/** Pezzo di archivio dato a fflate per volta: limita ogni blocco gonfiato (circa 1 MB al massimo). */
const PUSH_SLICE = 1024;

export function inflateCapped(
  bytes: Uint8Array,
  cap: (name: string) => number | undefined,
  stats?: InflateStats,
): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  let total = 0;
  let failure: BackupFormatError | undefined;
  const tooBig = (): BackupFormatError => new BackupFormatError('contenuto troppo grande');
  const unzip = new Unzip((file) => {
    const limit = cap(file.name);
    if (limit === undefined || failure) return;
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (err, chunk, final) => {
      if (failure) return;
      if (err) {
        failure = new BackupFormatError('non è un archivio zip');
        return;
      }
      if (stats) stats.inflated += chunk.length;
      size += chunk.length;
      total += chunk.length;
      if (size > limit || total > BACKUP_MAX_BYTES) {
        failure = tooBig();
        file.terminate();
        return;
      }
      chunks.push(chunk);
      if (final) {
        const data = new Uint8Array(size);
        let at = 0;
        for (const c of chunks) {
          data.set(c, at);
          at += c.length;
        }
        out[file.name] = data;
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  try {
    // A pezzi piccoli, e ci si ferma al primo errore: fflate gonfia ogni pezzo per intero
    for (let at = 0; at < bytes.length && !failure; at += PUSH_SLICE) {
      const end = Math.min(at + PUSH_SLICE, bytes.length);
      unzip.push(bytes.subarray(at, end), end === bytes.length);
    }
  } catch {
    throw failure ?? new BackupFormatError('non è un archivio zip');
  }
  if (failure) throw failure;
  return out;
}

/** Legge e controlla un `.baapbak`: formato, versione, file presenti, `sha256` e percorsi. */
export function decodeBackup(
  bytes: Uint8Array,
  hash: HashFn,
  stats?: InflateStats,
): {
  manifest: BackupManifest;
  files: Record<string, Uint8Array>;
} {
  if (bytes.length > BACKUP_MAX_BYTES) throw new BackupFormatError('file troppo grande');
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new BackupFormatError('non è un archivio zip');
  }
  const raw = inflateCapped(bytes, (n) => (n === MANIFEST_FILE ? MANIFEST_MAX_BYTES : undefined))[
    MANIFEST_FILE
  ];
  if (!raw) throw new BackupFormatError('manifest.json mancante');
  let m: unknown;
  try {
    m = JSON.parse(strFromU8(raw));
  } catch {
    throw new BackupFormatError('manifest.json illeggibile');
  }
  if (!isObj(m) || m['format'] !== BACKUP_FORMAT) throw new BackupFormatError('formato sbagliato');
  if (m['version'] !== BACKUP_VERSION) throw new BackupFormatError('versione non supportata');
  if (!Array.isArray(m['blocks']) || !Array.isArray(m['failed']) || !isObj(m['cpu'])) {
    throw new BackupFormatError('manifest incompleto');
  }
  for (const f of m['failed'] as unknown[]) {
    if (
      !isObj(f) ||
      !BACKUP_TYPES.includes(f['type'] as BackupBlockType) ||
      !isInt(f['number']) ||
      typeof f['error'] !== 'string'
    ) {
      throw new BackupFormatError('voce di blocco rifiutato non valida');
    }
  }
  const seenBlocks = new Set<string>();
  const seenFiles = new Set<string>();
  const wanted = new Map<string, number>();
  for (const b of m['blocks'] as unknown[]) {
    if (
      !isObj(b) ||
      !BACKUP_TYPES.includes(b['type'] as BackupBlockType) ||
      !isInt(b['number']) ||
      b['number'] < 0 ||
      !isInt(b['length']) ||
      b['length'] < 0 ||
      typeof b['sha256'] !== 'string'
    ) {
      throw new BackupFormatError('voce di blocco non valida');
    }
    if (!isSafePath(b['file'])) {
      throw new BackupFormatError(`percorso non valido (${String(b['file'])})`);
    }
    if (b['file'] !== backupFileName(b['type'] as BackupBlockType, b['number'])) {
      throw new BackupFormatError(`nome del file non coerente (${b['file']})`);
    }
    const key = `${String(b['type'])}${b['number']}`;
    if (seenBlocks.has(key) || seenFiles.has(b['file'])) {
      throw new BackupFormatError(`voce duplicata (${key})`);
    }
    seenBlocks.add(key);
    seenFiles.add(b['file']);
    if ((b['length'] as number) > BLOCK_MAX_BYTES)
      throw new BackupFormatError('contenuto troppo grande');
    wanted.set(b['file'], b['length'] as number);
  }
  const zip = inflateCapped(bytes, (n) => wanted.get(n), stats);
  const files: Record<string, Uint8Array> = {};
  for (const b of m['blocks'] as { file: string; length: number; sha256: string }[]) {
    const data = zip[b.file];
    if (!data) throw new BackupFormatError(`file mancante (${b.file})`);
    if (data.length !== b.length || hash(data) !== b.sha256) {
      throw new BackupFormatError(`${b.file}: contenuto diverso dal manifest`);
    }
    files[b.file] = data;
  }
  return { manifest: m as unknown as BackupManifest, files };
}
