export const FORMAT_VERSION = 3;

export interface ProjectMeta {
  name: string;
  author: string;
  comment: string;
  /** Data ISO 8601 UTC. */
  createdAt: string;
  /** Data ISO 8601 UTC. */
  modifiedAt: string;
}

export type Language = 'AWL' | 'KOP' | 'FUP' | 'SCL';

export interface CpuProperties {
  comment: string;
  pn?: { ipAddress: string; subnetMask: string; useRouter: boolean; routerAddress: string };
  mpiAddress: number;
  dpAddress?: number;
  cycle: { maxCycleMs: number; minCycleMs: number; commLoadPercent: number };
  clockMemory: { enabled: boolean; byte: number };
  retentivity: { mBytes: number; timers: number; counters: number };
  cyclicInterrupts: { ob35Ms: number };
}

export interface Tag {
  id: string;
  name: string;
  type: string;
  address: string;
  hmi: boolean;
  comment: string;
}

export interface UserConstant {
  id: string;
  name: string;
  type: string;
  value: string;
  comment: string;
}

export interface TagTable {
  id: string;
  name: string;
  group: string;
  tags: Tag[];
  constants: UserConstant[];
}

export interface Member {
  id: string;
  name: string;
  type: string;
  initial?: string;
  comment: string;
  members?: Member[];
  overrides?: Record<string, string>;
  readOnly?: boolean;
}

export interface Udt {
  id: string;
  name: string;
  number: number;
  group: string;
  title: string;
  comment: string;
  author: string;
  family: string;
  headerName: string;
  version: string;
  members: Member[];
}

export interface BlockHeader {
  title: string;
  comment: string;
  author: string;
  family: string;
  headerName: string;
  version: string;
}

export interface Network {
  id: string;
  title: string;
  comment: string;
  source: string;
}

export interface BlockInterface {
  input: Member[];
  output: Member[];
  inOut: Member[];
  static: Member[];
  temp: Member[];
  returnType: string;
}

export interface DbAttributes {
  unlinked: boolean;
  readOnly: boolean;
  nonRetain: boolean;
}

interface BlockBase {
  id: string;
  number: number;
  name: string;
  group: string;
  header: BlockHeader;
  knowHowProtected: boolean;
}

export interface CodeBlock extends BlockBase {
  kind: 'OB' | 'FB' | 'FC';
  language: Language;
  interface: BlockInterface;
  networks: Network[];
}

export interface GlobalDb extends BlockBase {
  kind: 'DB';
  members: Member[];
  attributes: DbAttributes;
}

export interface InstanceDb extends BlockBase {
  kind: 'IDB';
  instanceOf: string;
  overrides: Record<string, string>;
  attributes: DbAttributes;
}

export type Block = CodeBlock | GlobalDb | InstanceDb;

/** Sorgente AWL esterna (file di testo del dispositivo); `name` e un nome di file, es. 'Motori.awl'. */
export interface ExternalSource {
  id: string;
  name: string;
  /** Testo esatto del file (a capo e accenti compresi). */
  text: string;
  /** Chiavi sconosciute della voce in device.json (di versioni piu recenti): si riscrivono com'erano. */
  listExtras?: Record<string, unknown>;
}

export interface PlcDevice {
  id: string;
  name: string;
  cpu: { typeId: string; orderNumber: string; firmware: string };
  properties: CpuProperties;
  tagTables: TagTable[];
  udts: Udt[];
  blocks: Block[];
  sources: ExternalSource[];
  /** Percorsi di gruppo, es. 'A' e 'A/B'. */
  groups: { blocks: string[]; tags: string[]; types: string[] };
  /** Chiavi sconosciute della voce del dispositivo in project.json: si riscrivono com'erano. */
  listExtras?: Record<string, unknown>;
}

export interface Project {
  formatVersion: 3;
  meta: ProjectMeta;
  devices: PlcDevice[];
}

export type ObjectRef =
  | { kind: 'device'; deviceId: string }
  | { kind: 'block' | 'udt' | 'tagTable' | 'source'; deviceId: string; id: string }
  | { kind: 'tag' | 'constant'; deviceId: string; tableId: string; id: string }
  | {
      kind: 'member';
      deviceId: string;
      ownerKind: 'block' | 'udt';
      ownerId: string;
      memberId: string;
    };

export function createProject(
  input: { name: string; author: string; comment: string },
  now: Date,
): Project {
  const iso = now.toISOString();
  return {
    formatVersion: FORMAT_VERSION,
    meta: {
      name: input.name,
      author: input.author,
      comment: input.comment,
      createdAt: iso,
      modifiedAt: iso,
    },
    devices: [],
  };
}
