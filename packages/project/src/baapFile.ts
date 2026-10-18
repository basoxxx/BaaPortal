import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { z } from 'zod';
import {
  FORMAT_VERSION,
  type Member,
  type PlcDevice,
  type Project,
  type ProjectMeta,
  type TagTable,
  type Udt,
} from './model';

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

const str = z.string();
const id = z.string().min(1);
const obj = z.looseObject;

const metaShape = {
  name: str,
  author: str,
  comment: str,
  createdAt: z.iso.datetime(),
  modifiedAt: z.iso.datetime(),
};
// Formato 1: meta rigorosa come nel piano 1A.
const projectV1Schema = z.object({
  formatVersion: z.literal(1),
  meta: z.object(metaShape).strict(),
});
const projectV2Schema = obj({
  formatVersion: z.literal(FORMAT_VERSION),
  meta: obj(metaShape),
  devices: z.array(obj({ id, name: str })),
});

const manifestSchema = z.object({ formatVersion: z.number() });

const memberSchema: z.ZodType<Member> = z.lazy(() =>
  obj({
    id,
    name: str,
    type: str,
    initial: str.optional(),
    comment: str,
    members: z.array(memberSchema).optional(),
    overrides: z.record(str, str).optional(),
    readOnly: z.boolean().optional(),
  }),
);

const deviceSchema = obj({
  id,
  name: str,
  cpu: obj({ typeId: str, orderNumber: str, firmware: str }),
  properties: obj({
    comment: str,
    pn: obj({
      ipAddress: str,
      subnetMask: str,
      useRouter: z.boolean(),
      routerAddress: str,
    }).optional(),
    mpiAddress: z.number(),
    dpAddress: z.number().optional(),
    cycle: obj({ maxCycleMs: z.number(), minCycleMs: z.number(), commLoadPercent: z.number() }),
    clockMemory: obj({ enabled: z.boolean(), byte: z.number() }),
    retentivity: obj({ mBytes: z.number(), timers: z.number(), counters: z.number() }),
    cyclicInterrupts: obj({ ob35Ms: z.number() }),
  }),
  groups: obj({ blocks: z.array(str), tags: z.array(str), types: z.array(str) }),
  // Ordine degli oggetti: gli id dei file elencati.
  tagTables: z.array(id),
  udts: z.array(id),
  blocks: z.array(id),
});

const tagTableSchema = obj({
  id,
  name: str,
  group: str,
  tags: z.array(obj({ id, name: str, type: str, address: str, hmi: z.boolean(), comment: str })),
  constants: z.array(obj({ id, name: str, type: str, value: str, comment: str })),
});

const udtSchema = obj({
  id,
  name: str,
  number: z.number(),
  group: str,
  comment: str,
  author: str,
  family: str,
  version: str,
  members: z.array(memberSchema),
});

const headerSchema = obj({
  title: str,
  comment: str,
  author: str,
  family: str,
  headerName: str,
  version: str,
});
const attributesSchema = obj({
  unlinked: z.boolean(),
  readOnly: z.boolean(),
  nonRetain: z.boolean(),
});
const blockBase = {
  id,
  number: z.number(),
  name: str,
  group: str,
  header: headerSchema,
  knowHowProtected: z.boolean(),
};
const blockSchema = z.discriminatedUnion('kind', [
  obj({
    ...blockBase,
    kind: z.enum(['OB', 'FB', 'FC']),
    language: z.enum(['AWL', 'KOP', 'FUP', 'SCL']),
    interface: obj({
      input: z.array(memberSchema),
      output: z.array(memberSchema),
      inOut: z.array(memberSchema),
      static: z.array(memberSchema),
      temp: z.array(memberSchema),
      returnType: str,
    }),
    networks: z.array(obj({ id, title: str, comment: str, source: str })),
  }),
  obj({
    ...blockBase,
    kind: z.literal('DB'),
    members: z.array(memberSchema),
    attributes: attributesSchema,
  }),
  obj({
    ...blockBase,
    kind: z.literal('IDB'),
    instanceOf: str,
    overrides: z.record(str, str),
    attributes: attributesSchema,
  }),
]);

function toJson(value: unknown): Uint8Array {
  return strToU8(JSON.stringify(value, null, 2));
}

const deviceDir = (deviceId: string) => `plc/${deviceId}`;

export function writeBaap(project: Project, opts: { appVersion: string }): Uint8Array {
  const { devices, ...projectRest } = project;
  const files: Record<string, Uint8Array> = {
    [MANIFEST_FILE]: toJson({
      format: 'baaportal-project',
      formatVersion: FORMAT_VERSION,
      savedWith: `BaaPortal ${opts.appVersion}`,
    }),
    [PROJECT_FILE]: toJson({
      ...projectRest,
      devices: devices.map((d) => ({ id: d.id, name: d.name })),
    }),
  };
  for (const device of devices) {
    const dir = deviceDir(device.id);
    const { tagTables, udts, blocks, ...deviceRest } = device;
    files[`${dir}/device.json`] = toJson({
      ...deviceRest,
      tagTables: tagTables.map((t) => t.id),
      udts: udts.map((u) => u.id),
      blocks: blocks.map((b) => b.id),
    });
    for (const t of tagTables) files[`${dir}/tags/${t.id}.json`] = toJson(t);
    for (const u of udts) files[`${dir}/types/${u.id}.json`] = toJson(u);
    for (const b of blocks) files[`${dir}/blocks/${b.id}.json`] = toJson(b);
  }
  return zipSync(files);
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(strFromU8(bytes));
  } catch {
    throw new BaapFormatError('INVALID_JSON');
  }
}

const invalid = () => new BaapFormatError('INVALID_SCHEMA');

/** Legge e valida un file elencato; deve esistere e avere l'id atteso. */
function readListed<S extends z.ZodType<{ id: string }>>(
  files: Map<string, Uint8Array>,
  path: string,
  schema: S,
  expectedId: string,
): z.infer<S> {
  const bytes = files.get(path);
  if (!bytes) throw invalid();
  const parsed = schema.safeParse(parseJson(bytes));
  if (!parsed.success || parsed.data.id !== expectedId) throw invalid();
  return parsed.data;
}

function collectMemberIds(members: Member[], add: (id: string) => void): void {
  for (const m of members) {
    add(m.id);
    if (m.members) collectMemberIds(m.members, add);
  }
}

// Gli id devono essere unici in tutto il dispositivo.
function checkUniqueIds(device: PlcDevice): void {
  const seen = new Set<string>();
  const add = (x: string) => {
    if (seen.has(x)) throw invalid();
    seen.add(x);
  };
  for (const t of device.tagTables) {
    add(t.id);
    for (const x of t.tags) add(x.id);
    for (const x of t.constants) add(x.id);
  }
  for (const u of device.udts) {
    add(u.id);
    collectMemberIds(u.members, add);
  }
  for (const b of device.blocks) {
    add(b.id);
    if (b.kind === 'DB') collectMemberIds(b.members, add);
    else if (b.kind !== 'IDB') {
      const i = b.interface;
      for (const list of [i.input, i.output, i.inOut, i.static, i.temp]) {
        collectMemberIds(list, add);
      }
      for (const n of b.networks) add(n.id);
    }
  }
}

function readDevice(files: Map<string, Uint8Array>, listedId: string): PlcDevice {
  const dir = deviceDir(listedId);
  const raw = readListed(files, `${dir}/device.json`, deviceSchema, listedId);
  const { tagTables, udts, blocks, ...rest } = raw;
  const device = {
    ...rest,
    tagTables: tagTables.map((x) =>
      readListed(files, `${dir}/tags/${x}.json`, tagTableSchema, x),
    ) as TagTable[],
    udts: udts.map((x) => readListed(files, `${dir}/types/${x}.json`, udtSchema, x)) as Udt[],
    blocks: blocks.map((x) => readListed(files, `${dir}/blocks/${x}.json`, blockSchema, x)),
  } as PlcDevice;
  checkUniqueIds(device);
  return device;
}

export function readBaap(bytes: Uint8Array): Project {
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(bytes);
  } catch {
    throw new BaapFormatError('NOT_ZIP');
  }
  // Mappa: i percorsi derivano da id scelti dall'utente, niente chiavi di oggetto.
  const files = new Map(Object.entries(unzipped));

  const manifestBytes = files.get(MANIFEST_FILE);
  if (!manifestBytes) throw new BaapFormatError('MISSING_MANIFEST');

  const manifest = manifestSchema.safeParse(parseJson(manifestBytes));
  if (!manifest.success) throw invalid();
  if (manifest.data.formatVersion > FORMAT_VERSION) throw new BaapFormatError('NEWER_FORMAT');

  const projectBytes = files.get(PROJECT_FILE);
  if (!projectBytes) throw invalid();
  const json = parseJson(projectBytes);

  if (manifest.data.formatVersion < FORMAT_VERSION) {
    // Migrazione dal formato 1: stessi metadati, nessun dispositivo.
    const v1 = projectV1Schema.safeParse(json);
    if (!v1.success) throw invalid();
    return { formatVersion: FORMAT_VERSION, meta: v1.data.meta as ProjectMeta, devices: [] };
  }

  const project = projectV2Schema.safeParse(json);
  if (!project.success) throw invalid();
  const { devices: listed, ...rest } = project.data;
  const ids = new Set<string>();
  const devices = listed.map((l) => {
    if (ids.has(l.id)) throw invalid();
    ids.add(l.id);
    return readDevice(files, l.id);
  });
  return { ...rest, devices } as Project;
}
