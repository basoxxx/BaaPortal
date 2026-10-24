import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { BaapFormatError, readBaap, writeBaap } from './baapFile';
import type { Project } from './model';

export const BAAPZ_FORMAT_VERSION = 1;
/** Oltre questa dimensione l'archivio non si decomprime (difesa da archivi gonfiati). */
export const BAAPZ_MAX_BYTES = 200 * 1024 * 1024;

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

/** Nome semplice di un `.baap`: niente percorsi, niente '.'/'..' (il nome viene da un file non fidato). */
function isSafeProjectFileName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name !== '.' &&
    name !== '..' &&
    !/[/\\:]/.test(name) &&
    name.endsWith('.baap')
  );
}

export function writeBaapz(
  project: Project,
  o: { appVersion: string; projectFileName: string; now?: Date },
): Uint8Array {
  const manifest: BaapzManifest = {
    formatVersion: 1,
    appVersion: o.appVersion,
    createdAt: (o.now ?? new Date()).toISOString(),
    projectFileName: o.projectFileName,
  };
  return zipSync(
    {
      [MANIFEST_FILE]: strToU8(JSON.stringify(manifest, null, 2)),
      [o.projectFileName]: writeBaap(project, { appVersion: o.appVersion }),
    },
    { level: 9 },
  );
}

export function readBaapz(bytes: Uint8Array): { manifest: BaapzManifest; baap: Uint8Array } {
  if (bytes.length > BAAPZ_MAX_BYTES) throw new BaapzFormatError('NON_ZIP', 'troppo grande');
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new BaapzFormatError('NON_ZIP');
  }
  const rawManifest = files[MANIFEST_FILE];
  if (!rawManifest) throw new BaapzFormatError('MANIFESTO_MANCANTE');
  let parsed: unknown;
  try {
    parsed = JSON.parse(strFromU8(rawManifest));
  } catch {
    throw new BaapzFormatError('MANIFESTO_MANCANTE', 'JSON non valido');
  }
  const m = (parsed ?? {}) as Record<string, unknown>;
  if (typeof m.formatVersion !== 'number') throw new BaapzFormatError('MANIFESTO_MANCANTE');
  if (m.formatVersion > BAAPZ_FORMAT_VERSION) throw new BaapzFormatError('VERSIONE_FUTURA');
  if (!isSafeProjectFileName(m.projectFileName))
    throw new BaapzFormatError('PROGETTO_MANCANTE', 'nome non valido');
  const baap = Object.hasOwn(files, m.projectFileName) ? files[m.projectFileName] : undefined;
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
    formatVersion: 1,
    appVersion: typeof m.appVersion === 'string' ? m.appVersion : '',
    createdAt: typeof m.createdAt === 'string' ? m.createdAt : '',
    projectFileName: m.projectFileName,
  };
  return { manifest, baap };
}
