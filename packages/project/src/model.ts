import type { BlockMeta } from '@baaportal/mc7';
import type { LadNetwork } from '@baaportal/ladfbd';
import type { PlcAccess } from './plcAccess';

export const FORMAT_VERSION = 4;

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
  /** Come raggiungere la CPU reale (facoltativo: assente finché non si sceglie un dispositivo). */
  access?: PlcAccess;
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
  /** Sorgente AWL; in un segmento KOP con `lad` è quella generata (non si legge: vedi `kopSources`). */
  source: string;
  /** Segmento KOP grafico (solo blocchi KOP); la sorgente da compilare ne deriva. */
  lad?: LadNetwork;
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

/**
 * Metadati di andata e ritorno di un blocco importato da MC7 (piano 1E). Solo JSON: i byte sono
 * stringhe esadecimali. Un blocco non modificato (stessa proiezione e stesse impronte dei
 * chiamati, `fidelity`) si esporta con i byte originali.
 */
export interface Mc7Meta extends BlockMeta {
  /** false: il blocco non si ricodifica da testo (sola lettura). Le istruzioni grezze non lo causano: valgono rete per rete. */
  exact: boolean;
  /** Impronta esatta (nomi compresi) di reti, interfaccia e intestazione all'importazione; non decide la fedeltà. */
  sourceHash: string;
  /** Impronta esatta (nomi compresi) di interfaccia e intestazione all'importazione; non decide la fedeltà. */
  interfaceHash: string;
  /**
   * Regola F: impronte del contesto dei byte all'importazione. Assente (metadati della versione
   * di sviluppo di 1E) vuol dire sconosciuto: il blocco conta come modificato.
   */
  fidelity?: Mc7Fidelity;
  /**
   * Il lotto d'importazione da cui viene il blocco (stesso valore per i blocchi importati insieme):
   * la regola S si fida delle dipendenze del lotto, non degli altri blocchi del progetto.
   */
  batch?: string;
  /**
   * DB dimostrato istanza dell'SFB `sfb`: col numero `ssbNumber` nei byte 1–2 del suo SSB, usato
   * come istanza in `CALL SFB sfb, DB m` da un blocco del lotto `batch`. La prova resta col DB
   * (che è in sola lettura) e ne fa un esempio reale della struttura dell'SFB.
   */
  sfbInstance?: { sfb: number; ssbNumber: number; batch: string };
  /**
   * true: blocco protetto know-how importato. Il codice non si decodifica né si conserva (spec:
   * "la protezione si rispetta"): resta l'interfaccia; il blocco è bloccato e si esporta con i byte
   * originali.
   */
  knowHowLocked?: boolean;
}

/**
 * Impronte della regola F ("la fedeltà per rete richiede un contesto dei byte invariato"). Sono
 * proiezioni di ciò che arriva ai byte: nomi e commenti non ne fanno parte.
 */
export interface Mc7Fidelity {
  /** Proiezione del blocco: layout, intestazione (autore, famiglia, nome, versione), linguaggio e reti. */
  block: string;
  /**
   * Layout dell'interfaccia o dei dati: sezioni, ordine, tipi (limiti degli ARRAY, STRUCT, UDT e
   * multi-istanze risolti), dimensioni e valori iniziali; più tipo, numero e know-how.
   */
  layout: string;
  /** Proiezione di ogni rete: testo senza commenti, nomi dell'interfaccia per posizione, grezzi compresi. */
  networks: string[];
  /**
   * Chiamati (CALL, UC/CC anche grezzi, multi-istanze), DB di istanza delle CALL e, per un DB di
   * istanza, il suo FB: chiave `<tipo><numero>` (`FC20`, `DB11`), valore l'impronta del layout
   * all'importazione, null se assente, `estraneo` (blocco del progetto che non viene
   * dall'importazione) o `incoerente` (non torna con lo stesso lotto): questi due non coincidono mai.
   */
  deps: Record<string, string | null>;
}

interface BlockBase {
  id: string;
  number: number;
  name: string;
  group: string;
  header: BlockHeader;
  knowHowProtected: boolean;
  /** Presente nei blocchi importati da file MC7. */
  mc7?: Mc7Meta;
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

/** Formato di visualizzazione e di comando di una riga di tabella di controllo. */
export type WatchFormat =
  'BOOL' | 'DEC' | 'HEX' | 'BIN' | 'CHAR' | 'FLOAT' | 'S5TIME' | 'TIME' | 'BCD';

export interface WatchRow {
  id: string;
  /** Simbolo o indirizzo, come scritto dall'utente. */
  operand: string;
  format: WatchFormat;
  /** Valore di comando, come scritto (vuoto o assente: la riga non si comanda). */
  modify?: string;
  comment?: string;
}

/** Tabella di controllo: righe osservabili e comandabili sul simulatore. */
export interface WatchTable {
  id: string;
  name: string;
  rows: WatchRow[];
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
  /** Tabelle di controllo (formato 4). */
  watchTables: WatchTable[];
  /** Percorsi di gruppo, es. 'A' e 'A/B'. */
  groups: { blocks: string[]; tags: string[]; types: string[] };
  /** Chiavi sconosciute della voce del dispositivo in project.json: si riscrivono com'erano. */
  listExtras?: Record<string, unknown>;
}

export interface Project {
  formatVersion: 4;
  meta: ProjectMeta;
  devices: PlcDevice[];
}

export type ObjectRef =
  | { kind: 'device'; deviceId: string }
  | { kind: 'block' | 'udt' | 'tagTable' | 'source' | 'watchTable'; deviceId: string; id: string }
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
