import { formatType, incrementName, parseType, sameName } from '@baaportal/s7-types';
import { findOb, type CpuType } from '@baaportal/catalog';
import { renameSymbolInCode } from './codeRename';
import { renameMemberWithOverrides } from './memberRename';
import type {
  Block,
  BlockHeader,
  CodeBlock,
  CpuProperties,
  DbAttributes,
  ExternalSource,
  GlobalDb,
  InstanceDb,
  Language,
  Member,
  ObjectRef,
  PlcDevice,
  Project,
  TagTable,
  Udt,
} from './model';

export type NewId = () => string;

const defaultNewId: NewId = () => globalThis.crypto.randomUUID();

const emptyHeader = (): BlockHeader => ({
  title: '',
  comment: '',
  author: '',
  family: '',
  headerName: '',
  version: '0.1',
});

const noAttributes = (): DbAttributes => ({ unlinked: false, readOnly: false, nonRetain: false });

export function createTagTable(name: string, newId: NewId = defaultNewId): TagTable {
  return { id: newId(), name, group: '', tags: [], constants: [] };
}

export function createSource(
  name: string,
  text: string,
  newId: NewId = defaultNewId,
): ExternalSource {
  return { id: newId(), name, text };
}

export function createUdt(a: { name: string; number: number; newId?: NewId }): Udt {
  const newId = a.newId ?? defaultNewId;
  return {
    id: newId(),
    name: a.name,
    number: a.number,
    group: '',
    title: '',
    comment: '',
    author: '',
    family: '',
    headerName: '',
    version: '0.1',
    members: [],
  };
}

export function createCodeBlock(a: {
  kind: 'OB' | 'FB' | 'FC';
  number: number;
  name: string;
  language: Language;
  newId?: NewId;
}): CodeBlock {
  const newId = a.newId ?? defaultNewId;
  const id = newId();
  // Le informazioni di avvio degli OB vanno nella sezione Temp, in sola lettura.
  const temp: Member[] =
    a.kind === 'OB'
      ? (findOb(a.number)?.startInfo ?? []).map((m) => ({
          id: newId(),
          name: m.name,
          type: formatType(m.type),
          comment: '',
          readOnly: true,
        }))
      : [];
  return {
    id,
    kind: a.kind,
    number: a.number,
    name: a.name,
    group: '',
    header: emptyHeader(),
    knowHowProtected: false,
    language: a.language,
    interface: {
      input: [],
      output: [],
      inOut: [],
      static: [],
      temp,
      returnType: a.kind === 'FC' ? 'Void' : '',
    },
    networks: [{ id: newId(), title: '', comment: '', source: '' }],
  };
}

export function createGlobalDb(a: { number: number; name: string; newId?: NewId }): GlobalDb {
  const newId = a.newId ?? defaultNewId;
  return {
    id: newId(),
    kind: 'DB',
    number: a.number,
    name: a.name,
    group: '',
    header: emptyHeader(),
    knowHowProtected: false,
    members: [],
    attributes: noAttributes(),
  };
}

export function createInstanceDb(a: {
  number: number;
  name: string;
  instanceOf: string;
  newId?: NewId;
}): InstanceDb {
  const newId = a.newId ?? defaultNewId;
  return {
    id: newId(),
    kind: 'IDB',
    number: a.number,
    name: a.name,
    group: '',
    header: emptyHeader(),
    knowHowProtected: false,
    instanceOf: a.instanceOf,
    overrides: {},
    attributes: noAttributes(),
  };
}

export function createPlcDevice(a: {
  cpu: CpuType;
  orderNumber: string;
  firmware: string;
  name: string;
  texts: { defaultTagTable: string };
  newId?: NewId;
}): PlcDevice {
  const newId = a.newId ?? defaultNewId;
  const properties: CpuProperties = {
    comment: '',
    mpiAddress: 2,
    cycle: { maxCycleMs: 150, minCycleMs: 0, commLoadPercent: 20 },
    clockMemory: { enabled: false, byte: 0 },
    retentivity: { mBytes: 16, timers: 0, counters: 8 },
    cyclicInterrupts: { ob35Ms: 100 },
  };
  if (a.cpu.interfaces.pn) {
    properties.pn = {
      ipAddress: '192.168.0.1',
      subnetMask: '255.255.255.0',
      useRouter: false,
      routerAddress: '',
    };
  }
  if (a.cpu.interfaces.dp) properties.dpAddress = 2;
  const id = newId();
  return {
    id,
    name: a.name,
    cpu: { typeId: a.cpu.id, orderNumber: a.orderNumber, firmware: a.firmware },
    properties,
    tagTables: [createTagTable(a.texts.defaultTagTable, newId)],
    udts: [],
    blocks: [createCodeBlock({ kind: 'OB', number: 1, name: 'Main', language: 'AWL', newId })],
    sources: [],
    groups: { blocks: [], tags: [], types: [] },
  };
}

/** Nomi simbolici in uso: tag, costanti, blocchi e UDT. */
export function symbolNames(device: PlcDevice): string[] {
  return [
    ...device.tagTables.flatMap((t) => [
      ...t.tags.map((x) => x.name),
      ...t.constants.map((c) => c.name),
    ]),
    ...device.blocks.map((b) => b.name),
    ...device.udts.map((u) => u.name),
  ];
}

// Stessa chiave di sameName.
const nameKey = (name: string): string => name.normalize('NFC').toLowerCase();
const SUFFIX = /^(.*)_(\d+)$/;

/**
 * Rende unici i nomi di un'operazione: ogni nome restituito si aggiunge a quelli presi. Il nome è il
 * primo libero della sequenza Nome, Nome_1, Nome_2… (come uniqueName), trovato in tempo quasi costante
 * anche quando molti nomi della sequenza sono già presi.
 */
export function createNamer(taken: Iterable<string>): (base: string) => string {
  const used = new Set<string>();
  for (const t of taken) used.add(nameKey(t));
  // Per un nome preso: le cifre da cui riprendere la sequenza (i nomi in mezzo sono tutti presi).
  const resume = new Map<string, string>();
  return (base) => {
    let name = base;
    let key = nameKey(name);
    const seen: string[] = [];
    while (used.has(key)) {
      seen.push(key);
      const digits = resume.get(key);
      if (digits === undefined) name = incrementName(name);
      else name = `${SUFFIX.exec(name)?.[1] ?? name}_${digits}`;
      key = nameKey(name);
    }
    used.add(key);
    const digits = SUFFIX.exec(name)?.[2];
    if (digits !== undefined) for (const k of seen) resume.set(k, digits);
    return name;
  };
}

export function uniqueName(base: string, taken: Iterable<string>): string {
  return createNamer(taken)(base);
}

export function nextFreeNumber(
  device: PlcDevice,
  kind: 'OB' | 'FB' | 'FC' | 'DB' | 'UDT',
  max: number,
): number | null {
  const used = new Set<number>();
  if (kind === 'UDT') for (const u of device.udts) used.add(u.number);
  else {
    const kinds: string[] = kind === 'DB' ? ['DB', 'IDB'] : [kind];
    for (const b of device.blocks) if (kinds.includes(b.kind)) used.add(b.number);
  }
  for (let n = 1; n <= max; n++) if (!used.has(n)) return n;
  return null;
}

export const findDevice = (p: Project, id: string): PlcDevice | undefined =>
  p.devices.find((d) => d.id === id);
export const findBlock = (d: PlcDevice, id: string): Block | undefined =>
  d.blocks.find((b) => b.id === id);
export const findUdt = (d: PlcDevice, id: string): Udt | undefined =>
  d.udts.find((u) => u.id === id);
export const findSource = (d: PlcDevice, id: string): ExternalSource | undefined =>
  d.sources.find((s) => s.id === id);
export const findTagTable = (d: PlcDevice, id: string): TagTable | undefined =>
  d.tagTables.find((t) => t.id === id);

/** Aggiunge una sorgente con un nome di file libero (Nome.awl, Nome_1.awl...) e la restituisce. */
export function addSource(
  device: PlcDevice,
  name: string,
  text: string,
  newId: NewId = defaultNewId,
): ExternalSource {
  const free = uniqueFileName(
    name,
    device.sources.map((s) => s.name),
  );
  const source = createSource(free, text, newId);
  device.sources.push(source);
  return source;
}

/** Come uniqueName, ma l'estensione resta in fondo: Motori.awl -> Motori_1.awl. */
export function uniqueFileName(name: string, taken: Iterable<string>): string {
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  const stems = [...taken].map((t) =>
    ext !== '' && t.toLowerCase().endsWith(ext.toLowerCase())
      ? t.slice(0, t.length - ext.length)
      : t,
  );
  return `${uniqueName(stem, stems)}${ext}`;
}

export function deleteSource(device: PlcDevice, id: string): void {
  const at = device.sources.findIndex((s) => s.id === id);
  if (at >= 0) device.sources.splice(at, 1);
}

function blockMemberLists(b: Block): Member[][] {
  if (b.kind === 'DB') return [b.members];
  if (b.kind === 'IDB') return [];
  const i = b.interface;
  return [i.input, i.output, i.inOut, i.static, i.temp];
}

function allMemberLists(device: PlcDevice): Member[][] {
  return [...device.blocks.flatMap(blockMemberLists), ...device.udts.map((u) => u.members)];
}

// Sostituisce il nome del tipo con nome (anche come elemento di un Array); null se non c'è.
function retype(type: string, oldName: string, newName: string): string | null {
  const parsed = parseType(type);
  if (!parsed.ok) return null;
  const t = parsed.type;
  if (t.kind === 'named' && sameName(t.name, oldName)) return formatType({ ...t, name: newName });
  if (t.kind === 'array' && t.element.kind === 'named' && sameName(t.element.name, oldName)) {
    return formatType({ ...t, element: { kind: 'named', name: newName } });
  }
  return null;
}

function retypeMembers(list: Member[], oldName: string, newName: string): void {
  for (const m of list) {
    const next = retype(m.type, oldName, newName);
    if (next !== null) m.type = next;
    if (m.members) retypeMembers(m.members, oldName, newName);
  }
}

/** Rinomina sul posto aggiornando i riferimenti per tipo (UDT e FB). */
export function renameWithReferences(device: PlcDevice, ref: ObjectRef, newName: string): void {
  switch (ref.kind) {
    case 'device':
      device.name = newName;
      return;
    case 'tagTable': {
      const t = findTagTable(device, ref.id);
      if (t) t.name = newName;
      return;
    }
    case 'source': {
      // Il nome e un nome di file: il testo non cambia.
      const s = findSource(device, ref.id);
      if (s) s.name = newName;
      return;
    }
    case 'tag':
    case 'constant': {
      const t = findTagTable(device, ref.tableId);
      const item = (ref.kind === 'tag' ? t?.tags : t?.constants)?.find((x) => x.id === ref.id);
      if (!item) return;
      const old = item.name;
      item.name = newName;
      renameSymbolInCode(device, old, newName);
      return;
    }
    case 'udt': {
      const u = findUdt(device, ref.id);
      if (!u) return;
      const old = u.name;
      u.name = newName;
      for (const list of allMemberLists(device)) retypeMembers(list, old, newName);
      return;
    }
    case 'block': {
      const b = findBlock(device, ref.id);
      if (!b) return;
      const old = b.name;
      b.name = newName;
      renameSymbolInCode(device, old, newName);
      if (b.kind !== 'FB') return;
      for (const list of allMemberLists(device)) retypeMembers(list, old, newName);
      for (const x of device.blocks) {
        if (x.kind === 'IDB' && sameName(x.instanceOf, old)) x.instanceOf = newName;
      }
      return;
    }
    case 'member':
      renameMemberWithOverrides(
        device,
        { kind: ref.ownerKind, id: ref.ownerId },
        ref.memberId,
        newName,
      );
  }
}
