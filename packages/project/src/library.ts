// Librerie (tappa 7B): modelli di progetto e file `.baaplib` delle librerie globali.
import { strFromU8, strToU8, zipSync } from 'fflate';
import { parseType, sameName } from '@baaportal/s7-types';
import { BaapFormatError, parseLibrary } from './baapFile';
import { BackupFormatError, inflateCapped } from './backupFile';
import { callGraph } from './callGraph';
import type {
  Block,
  Library,
  LibraryItem,
  Member,
  ObjectRef,
  PlcDevice,
  TagTable,
  Udt,
  WatchTable,
} from './model';
import { findBlock, findTagTable, findUdt, findWatchTable, type NewId } from './plc';

export const emptyLibrary = (): Library => ({ items: [], groups: [] });

/** Nomi dei tipi (UDT o FB) usati da un membro, anche come elemento di un ARRAY e nelle STRUCT. */
function namedTypes(members: Member[], out: string[] = []): string[] {
  for (const m of members) {
    const p = parseType(m.type);
    if (p.ok) {
      const t = p.type.kind === 'array' ? p.type.element : p.type;
      if (t.kind === 'named') out.push(t.name);
    }
    if (m.members) namedTypes(m.members, out);
  }
  return out;
}

const blockMembers = (b: Block): Member[] =>
  b.kind === 'DB'
    ? b.members
    : b.kind === 'IDB'
      ? []
      : [...b.interface.input, ...b.interface.output, ...b.interface.inOut, ...b.interface.static];

const keyOf = (b: { kind: string; number: number }) =>
  `${b.kind === 'IDB' ? 'DB' : b.kind}${b.number}`;

/**
 * Gli oggetti dati più le loro dipendenze, in profondità: gli UDT e gli FB usati come tipo, l'FB di
 * un DB di istanza e i blocchi chiamati (CALL, UC, CC, dai riferimenti incrociati). L'ordine è
 * quello in cui si incollano: prima gli UDT, poi i blocchi (l'FB prima dei suoi DB di istanza).
 */
export function withDependencies(dev: PlcDevice, refs: ObjectRef[]): ObjectRef[] {
  const seen = new Map<string, ObjectRef>();
  const byName = (name: string): ObjectRef | undefined => {
    const u = dev.udts.find((x) => sameName(x.name, name));
    if (u) return { kind: 'udt', deviceId: dev.id, id: u.id };
    const b = dev.blocks.find((x) => x.kind === 'FB' && sameName(x.name, name));
    return b && { kind: 'block', deviceId: dev.id, id: b.id };
  };
  let graph: ReturnType<typeof callGraph> | undefined;
  const queue = [...refs];
  while (queue.length > 0) {
    const r = queue.shift()!;
    if (!('id' in r) || seen.has(`${r.kind}:${r.id}`)) continue;
    const add = (x: ObjectRef | undefined) => x && queue.push(x);
    if (r.kind === 'udt') {
      const u = findUdt(dev, r.id);
      if (!u) continue;
      namedTypes(u.members).forEach((n) => add(byName(n)));
    } else if (r.kind === 'block') {
      const b = findBlock(dev, r.id);
      if (!b) continue;
      namedTypes(blockMembers(b)).forEach((n) => add(byName(n)));
      if (b.kind === 'IDB') add(byName(b.instanceOf));
      graph ??= callGraph(dev);
      for (const e of graph.calls.get(keyOf(b)) ?? []) {
        const id = graph.blocks.get(e.callee)?.blockId;
        if (id) add({ kind: 'block', deviceId: dev.id, id });
      }
    } else if (r.kind === 'tagTable') {
      if (!findTagTable(dev, r.id)) continue;
    } else if (r.kind === 'watchTable') {
      if (!findWatchTable(dev, r.id)) continue;
    } else continue;
    seen.set(`${r.kind}:${r.id}`, r);
  }
  const rank = (r: ObjectRef) => {
    if (r.kind === 'udt') return 0;
    if (r.kind !== 'block') return 3;
    return findBlock(dev, r.id)?.kind === 'IDB' ? 2 : 1;
  };
  return [...seen.values()].sort((a, b) => rank(a) - rank(b));
}

/** Nuovo modello: copia profonda degli oggetti (con le dipendenze se `deps`). Gli id restano. */
export function createLibraryItem(
  dev: PlcDevice,
  refs: ObjectRef[],
  o: { name?: string; group?: string; deps?: boolean; newId: NewId },
): LibraryItem | null {
  const all = o.deps === false ? refs : withDependencies(dev, refs);
  const pick = <T>(kind: ObjectRef['kind'], find: (id: string) => T | undefined): T[] =>
    all
      .flatMap((r) => (r.kind === kind && 'id' in r ? [find(r.id)] : []))
      .filter((x): x is T => x !== undefined);
  const item: LibraryItem = {
    id: o.newId(),
    name: '',
    group: o.group ?? '',
    comment: '',
    udts: structuredClone(pick<Udt>('udt', (id) => findUdt(dev, id))),
    blocks: structuredClone(pick<Block>('block', (id) => findBlock(dev, id))),
    tagTables: structuredClone(pick<TagTable>('tagTable', (id) => findTagTable(dev, id))),
    watchTables: structuredClone(pick<WatchTable>('watchTable', (id) => findWatchTable(dev, id))),
  };
  const objects = libraryItemObjects(item);
  if (objects.length === 0) return null;
  // Il nome è quello del primo oggetto scelto (non di una dipendenza).
  const first = refs[0] && objects.find((x) => 'id' in refs[0]! && x.id === refs[0].id);
  item.name = o.name ?? first?.name ?? objects[0]!.name;
  return item;
}

/** Tutti gli oggetti del modello, nell'ordine in cui si incollano. */
export function libraryItemObjects(
  item: Pick<LibraryItem, 'blocks' | 'udts' | 'tagTables' | 'watchTables'>,
): { kind: ObjectRef['kind']; id: string; name: string; label: string }[] {
  return [
    ...item.udts.map((u) => ({
      kind: 'udt' as const,
      id: u.id,
      name: u.name,
      label: `UDT${u.number}`,
    })),
    ...item.blocks.map((b) => ({
      kind: 'block' as const,
      id: b.id,
      name: b.name,
      label: keyOf(b),
    })),
    ...item.tagTables.map((t) => ({
      kind: 'tagTable' as const,
      id: t.id,
      name: t.name,
      label: '',
    })),
    ...item.watchTables.map((w) => ({
      kind: 'watchTable' as const,
      id: w.id,
      name: w.name,
      label: '',
    })),
  ];
}

// ---- file `.baaplib` --------------------------------------------------------------------------

export const BAAPLIB_FORMAT = 'baaportal-library';
export const BAAPLIB_VERSION = 1;
/** Oltre questa dimensione il file non si legge (difesa da archivi gonfiati). */
export const BAAPLIB_MAX_BYTES = 64 * 1024 * 1024;
/** Tetti sui byte veri decompressi. */
const LIB_MANIFEST_MAX_BYTES = 64 * 1024;
const LIB_CONTENT_MAX_BYTES = 128 * 1024 * 1024;
const LIB_MANIFEST = 'manifest.json';
const LIB_CONTENT = 'library.json';

export type LibraryFileErrorCode =
  'TOO_BIG' | 'NOT_ZIP' | 'MISSING_MANIFEST' | 'WRONG_FORMAT' | 'NEWER_FORMAT' | 'INVALID';

export class LibraryFileError extends Error {
  readonly code: LibraryFileErrorCode;

  constructor(code: LibraryFileErrorCode) {
    super(code);
    this.name = 'LibraryFileError';
    this.code = code;
  }
}

export function writeBaaplib(library: Library, opts: { appVersion: string }): Uint8Array {
  return zipSync({
    [LIB_MANIFEST]: strToU8(
      JSON.stringify({
        format: BAAPLIB_FORMAT,
        formatVersion: BAAPLIB_VERSION,
        savedWith: `BaaPortal ${opts.appVersion}`,
      }),
    ),
    [LIB_CONTENT]: strToU8(JSON.stringify(library, null, 2)),
  });
}

function parseEntry(bytes: Uint8Array | undefined, missing: LibraryFileErrorCode): unknown {
  if (!bytes) throw new LibraryFileError(missing);
  try {
    return JSON.parse(strFromU8(bytes));
  } catch {
    throw new LibraryFileError(missing === 'MISSING_MANIFEST' ? missing : 'INVALID');
  }
}

/** Legge un `.baaplib` non fidato: dimensione, decompressione a tetto, formato, schema e id. */
export function readBaaplib(bytes: Uint8Array): Library {
  if (bytes.length > BAAPLIB_MAX_BYTES) throw new LibraryFileError('TOO_BIG');
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new LibraryFileError('NOT_ZIP');
  }
  let files: Record<string, Uint8Array>;
  try {
    files = inflateCapped(bytes, (n) =>
      n === LIB_MANIFEST
        ? LIB_MANIFEST_MAX_BYTES
        : n === LIB_CONTENT
          ? LIB_CONTENT_MAX_BYTES
          : undefined,
    );
  } catch (e) {
    throw new LibraryFileError(
      e instanceof BackupFormatError && e.detail === 'contenuto troppo grande'
        ? 'TOO_BIG'
        : 'NOT_ZIP',
    );
  }
  const m = parseEntry(files[LIB_MANIFEST], 'MISSING_MANIFEST');
  if (typeof m !== 'object' || m === null) throw new LibraryFileError('MISSING_MANIFEST');
  const manifest = m as Record<string, unknown>;
  if (manifest['format'] !== BAAPLIB_FORMAT) throw new LibraryFileError('WRONG_FORMAT');
  const version = manifest['formatVersion'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new LibraryFileError('MISSING_MANIFEST');
  }
  if (version > BAAPLIB_VERSION) throw new LibraryFileError('NEWER_FORMAT');
  try {
    return parseLibrary(parseEntry(files[LIB_CONTENT], 'INVALID'));
  } catch (e) {
    if (e instanceof BaapFormatError || e instanceof LibraryFileError) {
      throw new LibraryFileError('INVALID');
    }
    throw e;
  }
}
