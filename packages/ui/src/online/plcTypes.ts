import type { PlcAccess, PlcIdentity, PlcMode } from '@baaportal/project';

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
 * Esito di `plcDownload`. `loaded` elenca i blocchi già nella CPU anche se il caricamento si è
 * fermato; `failedAt` è il blocco che ha fallito. `cancelled`: l'utente ha detto «Annulla» nella
 * finestra nativa e non è partito nulla.
 */
export type PlcDownloadResult =
  | { ok: true; loaded: string[] }
  | { ok: false; loaded: string[]; failedAt?: string; error: string }
  | { ok: false; cancelled: true };

export type PlcControlOp = 'RUN' | 'STOP' | 'COPY_RAM_TO_ROM' | 'COMPRESS';

/** Esito di `plcControl`; `result` è l'esito della CPU (p.es. «ok»). */
export type PlcControlResult =
  { ok: true; result: string } | { ok: false; error: string } | { ok: false; cancelled: true };
