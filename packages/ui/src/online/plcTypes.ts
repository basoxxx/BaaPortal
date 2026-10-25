import type { PlcAccess, PlcIdentity, PlcMode, WatchTarget } from '@baaportal/project';
import type { CycleTime, Led, MemoryArea, ProtectionInfo, S7DateTime } from '@baaportal/s7comm';

export type { PlcAccess, PlcIdentity, PlcMode };

/** Eventi dal processo principale sul collegamento online della finestra. */
/** Perché il collegamento è andato perso: la finestra lo traduce nel messaggio. */
export type PlcLostReason = 'timeout' | 'closed' | 'errors';
export type PlcEvent = { kind: 'mode'; mode: PlcMode } | { kind: 'lost'; reason: PlcLostReason };

/** Esito di `plcConnect`: l'errore è già un testo leggibile, mai un'eccezione grezza. */
export type PlcConnectResult =
  | { ok: true; identity: PlcIdentity; mode: PlcMode; protection?: string }
  | { ok: false; error: string };

export interface PlcStatus {
  connected: boolean;
  access?: PlcAccess;
}

/** Interfaccia di rete IPv4 del PC da cui cercare i dispositivi accessibili. */
export interface NetInterface {
  name: string;
  address: string;
  netmask: string;
}

/** Esito della ricerca su un indirizzo: una CPU riconosciuta, o un host che apre la 102 e basta. */
export type FoundDevice =
  | { host: string; status: 'cpu'; identity: PlcIdentity; mode: PlcMode }
  | { host: string; status: 'unknown'; reason: string };

/**
 * Eventi della ricerca, ognuno con il numero della ricerca (`scanId`) che li ha prodotti, così il
 * renderer scarta quelli di una ricerca già sostituita. `done` chiude sempre la ricerca; con
 * `cancelled` è stata interrotta.
 */
export type PlcScanEvent = { scanId: number } & (
  | { kind: 'found'; device: FoundDevice }
  | { kind: 'progress'; done: number; total: number }
  | { kind: 'done'; found: number; cancelled: boolean }
  | { kind: 'error'; error: string }
);

export type PlcScanStartResult =
  { ok: true; scanId: number; total: number } | { ok: false; error: string };

/** Blocco che si può cancellare dalla CPU (solo questi quattro tipi, proto §10.5). */
export interface PlcBlockRef {
  type: 'OB' | 'FB' | 'FC' | 'DB';
  number: number;
}

/** Avanzamento di un caricamento: `current` è il blocco appena finito. */
export interface PlcWriteProgress {
  done: number;
  total: number;
  current: string;
}

/**
 * Esito di `plcDownload`. `loaded` e `deleted` elencano i blocchi già caricati e già cancellati anche se l'operazione si
 * è fermata; `failedAt` è il blocco che ha fallito. `cancelled`: l'utente ha detto «Annulla» nella
 * finestra nativa e non è partito nulla.
 */
export type PlcDownloadResult =
  | { ok: true; loaded: string[]; deleted: string[] }
  | { ok: false; loaded: string[]; deleted: string[]; failedAt?: string; error: string }
  | { ok: false; cancelled: true };

export type PlcControlOp = 'RUN' | 'STOP' | 'COPY_RAM_TO_ROM' | 'COMPRESS';

/** Esito di `plcControl`; `result` è l'esito della CPU (p.es. «ok»). */
export type PlcControlResult =
  { ok: true; result: string } | { ok: false; error: string } | { ok: false; cancelled: true };

/** Blocco della CPU come lo elenca il confronto online/offline (sola lettura). */
export interface OnlineBlock {
  type: 'OB' | 'FB' | 'FC' | 'DB' | 'SFC' | 'SFB' | 'SDB';
  number: number;
  loadLength: number;
  mc7Length: number;
  checksum: number;
  /** Data e ora di compilazione del codice, `AAAA-MM-GG hh:mm:ss`, se la CPU la dà. */
  codeTime?: string;
  /** La CPU l'elenca ma le sue informazioni non si sono potute leggere (lunghezze e checksum a 0). */
  unreadable?: boolean;
}

/** Esito di `plcBlocks`: l'elenco dei blocchi OB, FB, FC e DB della CPU collegata. */
export type PlcBlocksResult = { ok: true; blocks: OnlineBlock[] } | { ok: false; error: string };

/** Un blocco caricato dalla CPU: i byte del file `.blk` come li dà la CPU. */
export interface PlcUploadedFile {
  type: 'OB' | 'FB' | 'FC' | 'DB';
  number: number;
  bytes: Uint8Array;
}

/** Esito di `plcUploadBlock`: i byte del file `.blk` di un solo blocco della CPU collegata. */
export type PlcUploadBlockResult = { ok: true; bytes: Uint8Array } | { ok: false; error: string };

/** Avanzamento di «Carica dal dispositivo»: `current` è il blocco appena finito. */
export interface PlcUploadProgress {
  done: number;
  total: number;
  current: string;
}

/**
 * Esito di `plcUploadAll`. `failed` elenca i blocchi che la CPU non ha dato (gli altri sono nei
 * file); `cancelled`: interrotto dall'utente, nessun file.
 */
export type PlcUploadAllResult =
  | {
      ok: true;
      files: PlcUploadedFile[];
      identity: PlcIdentity;
      failed: { type: PlcUploadedFile['type']; number: number; error: string }[];
    }
  | { ok: false; error: string }
  | { ok: false; cancelled: true };

/** Le parti della diagnostica online che si possono chiedere (ognuna una o due SZL, proto §7.5.1). */
export type DiagPart =
  | 'identity'
  | 'mode'
  | 'leds'
  | 'protection'
  | 'lastModeChange'
  | 'cycle'
  | 'memory'
  | 'buffer'
  | 'clock';

/** Il valore di una parte: letto, non disponibile nella CPU, o fallito per un errore della CPU. */
export type DiagValue<T> =
  { ok: true; value: T } | { ok: false; unavailable: true } | { ok: false; error: string };

/** Una voce del buffer diagnostico come viaggia verso il renderer (niente `Uint8Array`). */
export interface DiagEventView {
  eventId: number;
  priority: number;
  obNumber: number;
  datId: number;
  info1: number;
  info2: number;
  time?: S7DateTime;
  /** Ora non valida: gli 8 byte grezzi in esadecimale. */
  rawTime?: string;
}

export interface PlcDiagData {
  identity: DiagValue<PlcIdentity>;
  mode: DiagValue<PlcMode>;
  leds: DiagValue<Led[]>;
  protection: DiagValue<ProtectionInfo>;
  lastModeChange: DiagValue<DiagEventView | null>;
  cycle: DiagValue<{ time: CycleTime; config: { minMs: number; maxMs: number } }>;
  memory: DiagValue<MemoryArea[]>;
  /** Dalla voce più recente. */
  buffer: DiagValue<DiagEventView[]>;
  clock: DiagValue<S7DateTime>;
}

/** Esito di `plcDiagnostics`: errore solo se manca il collegamento o si perde durante la lettura. */
export type PlcDiagResult = { ok: true; data: Partial<PlcDiagData> } | { ok: false; error: string };

/** Ora della CPU: quella del PC al momento della conferma, o una data scelta a mano. */
export type PlcClockRequest =
  | { source: 'pc' }
  | {
      source: 'manual';
      time: {
        year: number;
        month: number;
        day: number;
        hour: number;
        minute: number;
        second: number;
      };
    };

export type PlcClockResult =
  { ok: true; written: S7DateTime } | { ok: false; error: string } | { ok: false; cancelled: true };

/** Operando di una tabella di controllo come lo manda il renderer: il processo principale lo ricontrolla. */
export type PlcWatchTarget = WatchTarget;

/** Valore grezzo (big-endian, per `X` un byte 0/1) oppure il motivo per cui la riga non si legge. */
export type PlcWatchValue = { bytes: Uint8Array } | { error: string };

/** Esito di `plcReadWatch`: un valore per operando, nell'ordine; errore solo per il giro intero. */
export type PlcReadWatchResult =
  { ok: true; values: PlcWatchValue[] } | { ok: false; error: string };

/** Un valore da scrivere: l'operando e i byte grezzi (la dimensione dell'operando). */
export interface PlcWriteVarItem {
  target: PlcWatchTarget;
  data: Uint8Array;
}

/** Esito di `plcWriteVars`: un esito per operando, nell'ordine. */
export type PlcWriteVarsResult =
  | { ok: true; results: ({ ok: true } | { ok: false; error: string })[] }
  | { ok: false; error: string }
  | { ok: false; cancelled: true };
