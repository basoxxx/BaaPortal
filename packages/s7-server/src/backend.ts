import type {
  BlockListEntry,
  BlockType,
  CpuMode,
  ParsedBlock,
  ReadItem,
  S7DateTime,
  WriteItem,
} from '@baaportal/s7comm';
import type { FaultPlan } from './faults';

/** Configurazione che la sessione e il catalogo SZL leggono dalla CPU. */
export interface CpuConfig {
  orderNumber: string;
  firmware: string;
  firmwareParts: [number, number, number];
  asName: string;
  moduleName: string;
  serialNumber: string;
  copyright: string;
  pduLength: number;
  maxConnections: number;
  rack: number;
  slot: number;
  protectionLevel: 1 | 2 | 3;
  sizes: {
    inputBytes: number;
    outputBytes: number;
    mBytes: number;
    timers: number;
    counters: number;
  };
  faults: FaultPlan;
  /** I tre TSAP remoti accettati (tipo 1, 2, 3 con rack e slot configurati). */
  tsaps: number[];
}

/**
 * Tempi di ciclo in ms (proto §7.5.2): quelli di OB1 dall'ultimo avviamento e quelli configurati
 * (OB80: minimo e tempo di sorveglianza).
 */
export interface CycleStats {
  lastMs: number;
  minMs: number;
  maxMs: number;
  configMinMs: number;
  configMaxMs: number;
}

/** Memoria in byte (proto §7.5.3): lavoro totale e usato, memoria di caricamento usata. */
export interface MemoryUsage {
  workBytes: number;
  /** Somma delle lunghezze MC7 dei blocchi caricati (SDB esclusi). */
  workUsedBytes: number;
  /** Somma delle lunghezze di caricamento dei blocchi, SDB compresi. */
  loadUsedBytes: number;
}

/**
 * Un blocco memorizzato. Gli SDB (`type === 'SDB'`) sono blob opachi: la CPU li elenca, ne dà il
 * block info e l'upload, ma non li scrive (nessun download né `_DELE`). Le opzioni `systemBlocks` di
 * `FakeCpu` e di `simBackend` li seminano come file di blocco.
 */
export interface StoredBlock {
  type: BlockType;
  number: number;
  file: Uint8Array;
  parsed: ParsedBlock;
}

export type ItemRead = { data: Uint8Array } | { rc: number };

/**
 * Tutto ciò che il server S7 (`serve`, il catalogo SZL) chiede a una CPU: lo realizzano il finto
 * PLC (`FakeCpu`) e la CPU simulata (`simBackend` in `@baaportal/sim`).
 */
export interface CpuBackend {
  readonly config: CpuConfig;
  readonly mode: CpuMode;
  /** Istante dell'ultimo cambio di modo. */
  readonly modeSince: S7DateTime;
  /** Record da 20 byte del buffer diagnostico, il più recente per primo. */
  readonly diagnosticRecords: readonly Uint8Array[];
  /** Riferimento COTP della prossima sessione. */
  nextRef(): number;
  /** Registra una sessione; `false` se la CPU ha già `maxConnections` sessioni. */
  attach(session: object): boolean;
  detach(session: object): void;
  now(): S7DateTime;
  /** Imposta l'ora della CPU (userdata 7/2). Assente: il server risponde "non implementato". */
  setClock?(t: S7DateTime): void;
  /** Tempi di ciclo per la SZL 0x0222. Assente: tutti a zero, configurati 0 e 150 ms. */
  cycleStats?(): CycleStats;
  /** Memoria per la SZL 0x0013. Assente: lavoro 256 KB, nulla di usato. */
  memory?(): MemoryUsage;
  /** LED SF acceso (errore cumulativo). Assente: spento. */
  readonly faultLed?: boolean;
  readItem(it: ReadItem): ItemRead;
  /** Un return code per item (0xFF ok). */
  applyWrite(items: WriteItem[]): number[];
  /** 0x00 ok, 0x07 se già in STOP. */
  applyStop(): number;
  /** 0x00 ok, 0x03 se già in RUN. */
  applyWarmRestart(): number;
  applyDownloadedBlock(type: BlockType, number: number, file: Uint8Array): void;
  /** Cancella un blocco; `false` se non c'era. Assente: il server risponde "non implementato". */
  deleteBlock?(type: BlockType, number: number): boolean;
  /** `_MODU`: copia la RAM in ROM. Assente: il server risponde "non implementato". */
  copyRamToRom?(): void;
  /** `_GARB`: comprime la memoria. Assente: il server risponde "non implementato". */
  compressMemory?(): void;
  block(type: BlockType, number: number): StoredBlock | undefined;
  blockCounts(): Record<BlockType, number>;
  blockList(type: BlockType): BlockListEntry[];
  /** Payload (78 byte) della risposta di block info. */
  blockInfo(b: StoredBlock): Uint8Array;
}
