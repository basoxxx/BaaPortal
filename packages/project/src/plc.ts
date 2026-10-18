import { formatType, incrementName, parseType, sameName } from '@baaportal/s7-types';
import { findOb, type CpuType } from '@baaportal/catalog';
import type {
  Block,
  BlockHeader,
  CodeBlock,
  CpuProperties,
  DbAttributes,
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

export function createUdt(a: { name: string; number: number; newId?: NewId }): Udt {
  const newId = a.newId ?? defaultNewId;
  return {
    id: newId(),
    name: a.name,
    number: a.number,
    group: '',
    comment: '',
    author: '',
    family: '',
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

export function uniqueName(base: string, taken: Iterable<string>): string {
  const list = [...taken];
  let name = base;
  while (list.some((t) => sameName(t, name))) name = incrementName(name);
  return name;
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
export const findTagTable = (d: PlcDevice, id: string): TagTable | undefined =>
  d.tagTables.find((t) => t.id === id);

function blockMemberLists(b: Block): Member[][] {
  if (b.kind === 'DB') return [b.members];
  if (b.kind === 'IDB') return [];
  const i = b.interface;
  return [i.input, i.output, i.inOut, i.static, i.temp];
}

function allMemberLists(device: PlcDevice): Member[][] {
  return [...device.blocks.flatMap(blockMemberLists), ...device.udts.map((u) => u.members)];
}

function findMemberIn(list: Member[], id: string): Member | undefined {
  for (const m of list) {
    if (m.id === id) return m;
    const inner = m.members ? findMemberIn(m.members, id) : undefined;
    if (inner) return inner;
  }
  return undefined;
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
    case 'tag':
    case 'constant': {
      const t = findTagTable(device, ref.tableId);
      const item = (ref.kind === 'tag' ? t?.tags : t?.constants)?.find((x) => x.id === ref.id);
      if (item) item.name = newName;
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
      if (b.kind !== 'FB') return;
      for (const list of allMemberLists(device)) retypeMembers(list, old, newName);
      for (const x of device.blocks) {
        if (x.kind === 'IDB' && sameName(x.instanceOf, old)) x.instanceOf = newName;
      }
      return;
    }
    case 'member': {
      const owner =
        ref.ownerKind === 'udt' ? findUdt(device, ref.ownerId) : findBlock(device, ref.ownerId);
      if (!owner) return;
      const lists =
        ref.ownerKind === 'udt' ? [(owner as Udt).members] : blockMemberLists(owner as Block);
      for (const l of lists) {
        const m = findMemberIn(l, ref.memberId);
        if (m) {
          m.name = newName;
          return;
        }
      }
    }
  }
}
