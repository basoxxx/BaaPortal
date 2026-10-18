import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { z } from 'zod';
import { FORMAT_VERSION, type Project } from './model';

export type BaapErrorCode =
  'NOT_ZIP' | 'MISSING_MANIFEST' | 'INVALID_JSON' | 'INVALID_SCHEMA' | 'NEWER_FORMAT';

export class BaapFormatError extends Error {
  readonly code: BaapErrorCode;

  constructor(code: BaapErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'BaapFormatError';
    this.code = code;
  }
}

const MANIFEST_FILE = 'baaportal.json';
const PROJECT_FILE = 'project.json';

const projectSchema = z.object({
  formatVersion: z.literal(FORMAT_VERSION),
  meta: z
    .object({
      name: z.string(),
      author: z.string(),
      comment: z.string(),
      createdAt: z.iso.datetime(),
      modifiedAt: z.iso.datetime(),
    })
    .strict(),
});

const manifestSchema = z.object({ formatVersion: z.number() });

function toJson(value: unknown): Uint8Array {
  return strToU8(JSON.stringify(value, null, 2));
}

export function writeBaap(project: Project, opts: { appVersion: string }): Uint8Array {
  return zipSync({
    [MANIFEST_FILE]: toJson({
      format: 'baaportal-project',
      formatVersion: FORMAT_VERSION,
      savedWith: `BaaPortal ${opts.appVersion}`,
    }),
    [PROJECT_FILE]: toJson(project),
  });
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(strFromU8(bytes));
  } catch {
    throw new BaapFormatError('INVALID_JSON');
  }
}

export function readBaap(bytes: Uint8Array): Project {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new BaapFormatError('NOT_ZIP');
  }

  const manifestBytes = files[MANIFEST_FILE];
  if (!manifestBytes) throw new BaapFormatError('MISSING_MANIFEST');

  const manifest = manifestSchema.safeParse(parseJson(manifestBytes));
  if (!manifest.success) throw new BaapFormatError('INVALID_SCHEMA');
  if (manifest.data.formatVersion > FORMAT_VERSION) throw new BaapFormatError('NEWER_FORMAT');

  const projectBytes = files[PROJECT_FILE];
  if (!projectBytes) throw new BaapFormatError('INVALID_SCHEMA');
  const project = projectSchema.safeParse(parseJson(projectBytes));
  if (!project.success) throw new BaapFormatError('INVALID_SCHEMA');
  return project.data;
}
