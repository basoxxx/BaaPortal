import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { ladNetworkSchema } from '@baaportal/ladfbd';
import { z } from 'zod';
import {
  FORMAT_VERSION,
  type ExternalSource,
  type Library,
  type Member,
  type PlcDevice,
  type Project,
  type ProjectMeta,
  type TagTable,
  type Udt,
  type WatchTable,
} from './model';
import { HMI_FORMATS, HMI_MAX_SIZE, HMI_MAX_TEXT, HMI_OBJECT_KINDS } from './hmi';
import type { HmiFormat, HmiObjectKind } from './model';
import { liveTexts, liveTextSources, MAX_TRANSLATION_LENGTH } from './texts';
import { MPI_BUS_SPEEDS, MPI_HIGHEST_ADDRESSES } from './plcAccess';

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
const LIBRARY_FILE = 'library.json';

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
// Testi di progetto (7D, facoltativi). I tag di lingua sono anche chiavi di oggetto: restano regolari.
const langTag = z
  .string()
  .max(20)
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/);
const languagesSchema = obj({
  editing: langTag,
  others: z.array(langTag).max(20),
  display: langTag.optional(),
}).refine((l) => {
  const all = [l.editing, ...l.others];
  return new Set(all).size === all.length && (!l.display || all.includes(l.display));
});
const textsSchema = z.record(str.max(1000), z.record(langTag, str.max(MAX_TRANSLATION_LENGTH)));
const projectSchema = (version: 2 | 3 | 4) =>
  obj({
    formatVersion: z.literal(version),
    meta: obj(metaShape),
    devices: z.array(obj({ id, name: str })),
    languages: languagesSchema.optional(),
    texts: textsSchema.optional(),
    textSources: z.record(str.max(1000), str.max(MAX_TRANSLATION_LENGTH)).optional(),
    // Sottoreti (tappa 6B, facoltative). Indirizzi e parametri si controllano in checkNetworks.
    subnets: z
      .array(
        obj({
          id,
          name: str,
          type: z.enum(['MPI', 'PROFIBUS', 'ETHERNET']),
          rate: str.optional(),
          highestAddress: z.number().int().min(1).max(126).optional(),
          subnetMask: str.optional(),
          gateway: str.optional(),
        }),
      )
      .optional(),
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

const mpiAddress = z.number().int().min(0).max(126);

// Schermate HMI (1.9, facoltative). Colori solo `#rrggbb`: finiscono negli stili della schermata.
const hmiColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const hmiPos = z.number().int().min(0).max(HMI_MAX_SIZE);
const hmiLen = z.number().int().min(1).max(HMI_MAX_SIZE);
const hmiText = z.string().max(HMI_MAX_TEXT);
const hmiSchema = obj({
  screens: z
    .array(
      obj({
        id,
        name: str,
        width: hmiLen,
        height: hmiLen,
        background: hmiColor,
        objects: z
          .array(
            obj({
              id,
              kind: z.enum(HMI_OBJECT_KINDS as [HmiObjectKind, ...HmiObjectKind[]]),
              x: hmiPos,
              y: hmiPos,
              w: hmiLen,
              h: hmiLen,
              text: hmiText,
              tag: hmiText.optional(),
              format: z.enum(HMI_FORMATS as [HmiFormat, ...HmiFormat[]]).optional(),
              input: z.boolean().optional(),
              action: z.enum(['set', 'reset', 'toggle', 'write', 'jog']).optional(),
              value: hmiText.optional(),
              onColor: hmiColor.optional(),
              offColor: hmiColor.optional(),
              min: z.number().finite().optional(),
              max: z.number().finite().optional(),
              screen: str.optional(),
            }),
          )
          .max(2000),
      }),
    )
    .max(1000),
});

// Collegamento a una sottorete; l'indirizzo si controlla in checkNetworks.
const netFields = {
  subnetId: id.optional(),
  address: z.number().int().optional(),
  ip: str.optional(),
};
const deviceShape = {
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
    access: obj({
      host: z.string().max(64),
      port: z.number().int().min(1).max(65535).optional(),
      rack: z.number().int().min(0).max(7),
      slot: z.number().int().min(0).max(31),
      connectionType: z.enum(['PG', 'OP', 'S7_BASIC']),
      remoteTsap: z.number().int().min(0).max(0xffff).optional(),
      link: z
        .discriminatedUnion('kind', [
          obj({ kind: z.literal('tcp') }),
          obj({
            kind: z.literal('mpi'),
            port: z.string().min(1).max(255),
            baudRate: z.number().int().positive(),
            parity: z.enum(['odd', 'even', 'none']),
            localAddress: mpiAddress,
            cpuAddress: mpiAddress,
            highestAddress: z.union(MPI_HIGHEST_ADDRESSES.map((n) => z.literal(n))),
            busSpeed: z.enum(MPI_BUS_SPEEDS),
            variant: z.enum(['auto', 'v1', 'v2']),
          }).refine((l) => l.localAddress !== l.cpuAddress, {
            message: 'L’indirizzo MPI della CPU deve essere diverso da quello dell’adattatore',
            path: ['cpuAddress'],
          }),
        ])
        .optional(),
    }).optional(),
  }),
  groups: obj({ blocks: z.array(str), tags: z.array(str), types: z.array(str) }),
  // Configurazione hardware (tappa 6A, facoltativa: i file precedenti non ce l'hanno). Posti e
  // indirizzi si controllano in checkDevice, qui solo la forma.
  hardware: obj({
    modules: z.array(
      obj({
        id,
        rack: z.number().int().min(0).max(3),
        slot: z.number().int().min(1).max(11),
        orderNumber: str,
        name: str,
        comment: str,
        inputStart: z.number().int().min(0).optional(),
        outputStart: z.number().int().min(0).optional(),
      }),
    ),
    // Tappa 6B, facoltativi: interfacce collegate alle sottoreti e stazioni ET 200.
    interfaces: z.array(obj({ port: id, ...netFields })).optional(),
    stations: z
      .array(
        obj({
          ...netFields,
          id,
          orderNumber: str,
          name: str,
          comment: str,
          deviceName: str.optional(),
          modules: z.array(
            obj({
              id,
              rack: z.literal(0),
              slot: z.number().int().min(1).max(63),
              orderNumber: str,
              name: str,
              comment: str,
              inputStart: z.number().int().min(0).optional(),
              outputStart: z.number().int().min(0).optional(),
            }),
          ),
        }),
      )
      .optional(),
  }).optional(),
  hmi: hmiSchema.optional(),
  // Ordine degli oggetti: gli id dei file elencati.
  tagTables: z.array(id),
  udts: z.array(id),
  blocks: z.array(id),
};
// Formato 2: nessun elenco di sorgenti. Formato 3: elenco ordinato di sorgenti (il testo sta in file a parte).
const deviceSchemaV2 = obj(deviceShape);
const deviceSchemaV3 = obj({ ...deviceShape, sources: z.array(obj({ id, name: str })) });
// Formato 4: in piu l'elenco ordinato delle tabelle di controllo (ciascuna in un file a parte).
const deviceSchemaV4 = obj({
  ...deviceShape,
  sources: z.array(obj({ id, name: str })),
  watchTables: z.array(id),
});

const watchTableSchema = obj({
  id,
  name: str,
  rows: z.array(
    obj({
      id,
      operand: str,
      format: z.enum(['BOOL', 'DEC', 'HEX', 'BIN', 'CHAR', 'FLOAT', 'S5TIME', 'TIME', 'BCD']),
      modify: str.optional(),
      comment: str.optional(),
    }),
  ),
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
  // Assenti nei file scritti prima che l'UDT avesse titolo e nome di intestazione.
  title: str.default(''),
  comment: str,
  author: str,
  family: str,
  headerName: str.default(''),
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
  mc7: obj({ exact: z.boolean(), sourceHash: str, original: str }).optional(),
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
    networks: z.array(
      obj({ id, title: str, comment: str, source: str, lad: ladNetworkSchema.optional() }),
    ),
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

/** Tetti della libreria: difesa da file non fidati (`.baaplib`) prima di toccare i dati. */
const LIBRARY_MAX_ITEMS = 10_000;
const LIBRARY_MAX_OBJECTS = 2_000;

const libraryItemSchema = obj({
  id,
  name: str,
  group: str,
  comment: str.default(''),
  blocks: z.array(blockSchema).max(LIBRARY_MAX_OBJECTS),
  udts: z.array(udtSchema).max(LIBRARY_MAX_OBJECTS),
  tagTables: z.array(tagTableSchema).max(LIBRARY_MAX_OBJECTS),
  watchTables: z.array(watchTableSchema).max(LIBRARY_MAX_OBJECTS),
});
const librarySchema = obj({
  items: z.array(libraryItemSchema).max(LIBRARY_MAX_ITEMS),
  groups: z.array(str).max(LIBRARY_MAX_ITEMS),
});

/** Valida una libreria (di progetto o di un `.baaplib`): schema, id unici per modello e tra i modelli. */
export function parseLibrary(json: unknown): Library {
  const parsed = librarySchema.safeParse(json);
  if (!parsed.success) throw invalid();
  const library = parsed.data as Library;
  const itemIds = new Set<string>();
  for (const item of library.items) {
    if (itemIds.has(item.id)) throw invalid();
    itemIds.add(item.id);
    checkUniqueIds({ ...item, sources: [] } as unknown as PlcDevice);
  }
  return library;
}

function toJson(value: unknown): Uint8Array {
  return strToU8(JSON.stringify(value, null, 2));
}

const deviceDir = (deviceId: string) => `plc/${deviceId}`;

export function writeBaap(project: Project, opts: { appVersion: string }): Uint8Array {
  const { devices, library, ...projectRest } = project;
  // Solo le traduzioni di oggetti che esistono ancora.
  const texts = liveTexts(project);
  delete projectRest.texts;
  const textSources = liveTextSources(project);
  delete projectRest.textSources;
  const files: Record<string, Uint8Array> = {
    [MANIFEST_FILE]: toJson({
      format: 'baaportal-project',
      formatVersion: FORMAT_VERSION,
      savedWith: `BaaPortal ${opts.appVersion}`,
    }),
    [PROJECT_FILE]: toJson({
      ...projectRest,
      ...(texts ? { texts } : {}),
      ...(textSources ? { textSources } : {}),
      devices: devices.map((d) => ({ ...d.listExtras, id: d.id, name: d.name })),
    }),
  };
  // In un file a parte: le versioni precedenti lo ignorano e il progetto si apre lo stesso.
  if (library) files[LIBRARY_FILE] = toJson(library);
  for (const device of devices) {
    const dir = deviceDir(device.id);
    const { tagTables, udts, blocks, sources, watchTables, ...deviceRest } = device;
    // Le chiavi della voce di project.json restano lì.
    delete deviceRest.listExtras;
    files[`${dir}/device.json`] = toJson({
      ...deviceRest,
      tagTables: tagTables.map((t) => t.id),
      udts: udts.map((u) => u.id),
      blocks: blocks.map((b) => b.id),
      sources: sources.map((x) => ({ ...x.listExtras, id: x.id, name: x.name })),
      watchTables: watchTables.map((w) => w.id),
    });
    for (const t of tagTables) files[`${dir}/tags/${t.id}.json`] = toJson(t);
    for (const w of watchTables) files[`${dir}/watch/${w.id}.json`] = toJson(w);
    for (const u of udts) files[`${dir}/types/${u.id}.json`] = toJson(u);
    for (const b of blocks) files[`${dir}/blocks/${b.id}.json`] = toJson(b);
    // UTF-8 senza BOM, come in memoria (strToU8 non aggiunge il BOM).
    for (const x of sources) files[`${dir}/sources/${x.id}.awl`] = strToU8(x.text);
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
  for (const x of device.sources) add(x.id);
  for (const m of device.hardware?.modules ?? []) add(m.id);
  for (const st of device.hardware?.stations ?? []) {
    add(st.id);
    for (const m of st.modules) add(m.id);
  }
  for (const sc of device.hmi?.screens ?? []) {
    add(sc.id);
    for (const o of sc.objects) add(o.id);
  }
  for (const w of device.watchTables) {
    add(w.id);
    for (const r of w.rows) add(r.id);
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

// Gli id delle sorgenti diventano nomi di file: niente separatori, '..' o ':'.
const unsafeFileId = (x: string): boolean => /[/\\:]|\.\./.test(x);
// fflate/strFromU8 scarta un eventuale BOM iniziale: qui il testo va conservato com'e.
const textDecoder = new TextDecoder('utf-8', { ignoreBOM: true });

function readSources(
  files: Map<string, Uint8Array>,
  dir: string,
  listed: { id: string; name: string }[],
): ExternalSource[] {
  const seen = new Set<string>();
  return listed.map((l) => {
    if (unsafeFileId(l.id) || seen.has(l.id)) throw invalid();
    seen.add(l.id);
    const bytes = files.get(`${dir}/sources/${l.id}.awl`);
    if (!bytes) throw invalid();
    const extras = Object.entries(l).filter(([k]) => k !== 'id' && k !== 'name');
    return {
      id: l.id,
      name: l.name,
      text: textDecoder.decode(bytes),
      ...(extras.length > 0 ? { listExtras: Object.fromEntries(extras) } : {}),
    };
  });
}

function readDevice(
  files: Map<string, Uint8Array>,
  listedId: string,
  version: 2 | 3 | 4,
): PlcDevice {
  const dir = deviceDir(listedId);
  const raw = readListed(
    files,
    `${dir}/device.json`,
    version === 4 ? deviceSchemaV4 : version === 3 ? deviceSchemaV3 : deviceSchemaV2,
    listedId,
  );
  const { tagTables, udts, blocks, ...rest } = raw;
  const listedWatch = 'watchTables' in raw ? (raw.watchTables as string[]) : [];
  const listedSources = 'sources' in raw ? (raw.sources as { id: string; name: string }[]) : [];
  // Nel formato 2 una chiave `sources` non esiste: se c'e, e di un'altra origine e si ignora.
  delete (rest as { sources?: unknown }).sources;
  // Prima del formato 4 non ci sono tabelle di controllo: una chiave `watchTables` e di un'altra origine.
  delete (rest as { watchTables?: unknown }).watchTables;
  const device = {
    ...rest,
    tagTables: tagTables.map((x) =>
      readListed(files, `${dir}/tags/${x}.json`, tagTableSchema, x),
    ) as TagTable[],
    udts: udts.map((x) => readListed(files, `${dir}/types/${x}.json`, udtSchema, x)) as Udt[],
    blocks: blocks.map((x) => readListed(files, `${dir}/blocks/${x}.json`, blockSchema, x)),
    sources: version >= 3 ? readSources(files, dir, listedSources) : [],
    watchTables:
      version === 4
        ? listedWatch.map(
            (x) => readListed(files, `${dir}/watch/${x}.json`, watchTableSchema, x) as WatchTable,
          )
        : [],
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

  const version = manifest.data.formatVersion;
  if (version === 1) {
    // Migrazione dal formato 1: stessi metadati, nessun dispositivo.
    const v1 = projectV1Schema.safeParse(json);
    if (!v1.success) throw invalid();
    return { formatVersion: FORMAT_VERSION, meta: v1.data.meta as ProjectMeta, devices: [] };
  }
  // Il formato 2 si apre con `sources: []`, il 3 anche con `watchTables: []`; il 4 e quello attuale.
  // Altri valori non esistono.
  if (version !== 2 && version !== 3 && version !== 4) throw invalid();

  const project = projectSchema(version).safeParse(json);
  if (!project.success) throw invalid();
  const { devices: listed, ...rest } = project.data;
  // La libreria vale solo dal suo file, validata.
  delete (rest as { library?: unknown }).library;
  const libraryBytes = files.get(LIBRARY_FILE);
  const library = libraryBytes ? parseLibrary(parseJson(libraryBytes)) : undefined;
  const ids = new Set<string>();
  const devices = listed.map((l) => {
    if (ids.has(l.id)) throw invalid();
    ids.add(l.id);
    const device = readDevice(files, l.id, version);
    // La voce dell'elenco ripete id e nome; le altre chiavi (di versioni più recenti) si conservano.
    const extras = Object.entries(l).filter(([k]) => k !== 'id' && k !== 'name');
    if (extras.length > 0) device.listExtras = Object.fromEntries(extras);
    return device;
  });
  return {
    ...rest,
    formatVersion: FORMAT_VERSION,
    devices,
    ...(library ? { library } : {}),
  } as Project;
}
