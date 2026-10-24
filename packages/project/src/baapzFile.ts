import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { BaapFormatError, readBaap, writeBaap } from './baapFile';
import type { Project } from './model';
import { validateProjectName } from './names';

export const BAAPZ_FORMAT_VERSION = 1;
/** Oltre questa dimensione l'archivio non si decomprime (difesa da archivi gonfiati). */
export const BAAPZ_MAX_BYTES = 200 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 1024 * 1024;

export interface BaapzManifest {
  formatVersion: 1;
  appVersion: string;
  createdAt: string;
  projectFileName: string;
}

export type BaapzErrorCode =
  | 'NON_ZIP'
  | 'MANIFESTO_MANCANTE'
  | 'VERSIONE_FUTURA'
  | 'PROGETTO_MANCANTE'
  | 'PROGETTO_ILLEGGIBILE';

export class BaapzFormatError extends Error {
  readonly code: BaapzErrorCode;
  readonly detail: string | undefined;

  constructor(code: BaapzErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'BaapzFormatError';
    this.code = code;
    this.detail = detail;
  }
}

const MANIFEST_FILE = 'manifest.json';

/** Nome semplice di un `.baap`: niente percorsi, nome valido su Windows e macOS (viene da un file non fidato). */
function isSafeProjectFileName(name: unknown): name is string {
  if (typeof name !== 'string' || name === '.' || name === '..' || /[/\\:]/.test(name))
    return false;
  if (!name.endsWith('.baap')) return false;
  return validateProjectName(name.slice(0, -'.baap'.length)).ok;
}

export function writeBaapz(
  project: Project,
  o: {
    appVersion: string;
    projectFileName: string;
    now?: Date;
    /** Contenuto già pronto del `.baap` (es. il file su disco); altrimenti si genera dal progetto. */
    baap?: Uint8Array;
  },
): Uint8Array {
  if (!isSafeProjectFileName(o.projectFileName))
    throw new BaapzFormatError('PROGETTO_MANCANTE', 'nome non valido');
  const manifest: BaapzManifest = {
    formatVersion: 1,
    appVersion: o.appVersion,
    createdAt: (o.now ?? new Date()).toISOString(),
    projectFileName: o.projectFileName,
  };
  return zipSync(
    {
      [MANIFEST_FILE]: strToU8(JSON.stringify(manifest, null, 2)),
      [o.projectFileName]: o.baap ?? writeBaap(project, { appVersion: o.appVersion }),
    },
    { level: 9 },
  );
}

/** Decomprime solo la voce indicata, rifiutando prima di gonfiarla se supera il limite. */
function extractEntry(bytes: Uint8Array, name: string, cap: number): Uint8Array | undefined {
  let tooBig = false;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        if (f.name !== name) return false;
        if (f.originalSize > cap) tooBig = true;
        return !tooBig;
      },
    });
  } catch {
    throw new BaapzFormatError('NON_ZIP');
  }
  if (tooBig) throw new BaapzFormatError('NON_ZIP', 'troppo grande');
  const out = Object.hasOwn(files, name) ? files[name] : undefined;
  if (out && out.length > cap) throw new BaapzFormatError('NON_ZIP', 'troppo grande');
  return out;
}

export function readBaapz(bytes: Uint8Array): { manifest: BaapzManifest; baap: Uint8Array } {
  if (bytes.length > BAAPZ_MAX_BYTES) throw new BaapzFormatError('NON_ZIP', 'troppo grande');
  const rawManifest = extractEntry(bytes, MANIFEST_FILE, MANIFEST_MAX_BYTES);
  if (!rawManifest) throw new BaapzFormatError('MANIFESTO_MANCANTE');
  let parsed: unknown;
  try {
    parsed = JSON.parse(strFromU8(rawManifest));
  } catch {
    throw new BaapzFormatError('MANIFESTO_MANCANTE', 'JSON non valido');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new BaapzFormatError('MANIFESTO_MANCANTE', 'manifesto non valido');
  const m = parsed as Record<string, unknown>;
  if (
    typeof m.formatVersion !== 'number' ||
    !Number.isInteger(m.formatVersion) ||
    m.formatVersion < 1 ||
    typeof m.appVersion !== 'string' ||
    typeof m.createdAt !== 'string'
  )
    throw new BaapzFormatError('MANIFESTO_MANCANTE', 'manifesto non valido');
  if (m.formatVersion > BAAPZ_FORMAT_VERSION) throw new BaapzFormatError('VERSIONE_FUTURA');
  if (!isSafeProjectFileName(m.projectFileName))
    throw new BaapzFormatError('PROGETTO_MANCANTE', 'nome non valido');
  const baap = extractEntry(bytes, m.projectFileName, BAAPZ_MAX_BYTES);
  if (!baap) throw new BaapzFormatError('PROGETTO_MANCANTE');
  try {
    readBaap(baap);
  } catch (e) {
    throw new BaapzFormatError(
      'PROGETTO_ILLEGGIBILE',
      e instanceof BaapFormatError ? e.code : 'UNKNOWN',
    );
  }
  const manifest: BaapzManifest = {
    formatVersion: m.formatVersion as 1,
    appVersion: m.appVersion,
    createdAt: m.createdAt,
    projectFileName: m.projectFileName,
  };
  return { manifest, baap };
}
