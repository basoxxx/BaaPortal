import type {
  UpdateCanInstall,
  UpdateEvent,
  UpdateInfoView,
  UpdatePrefs,
} from './update/updateTypes';
import type {
  DiagPart,
  NetInterface,
  SerialPortInfo,
  MpiLink,
  PlcMpiNodesResult,
  PlcClockRequest,
  PlcClockResult,
  PlcDiagResult,
  PlcReadWatchResult,
  PlcStatusRequest,
  PlcStatusStartResult,
  PlcStatusWindowResult,
  PlcStatusReadResult,
  PlcStacksResult,
  PlcWatchTarget,
  PlcWriteVarItem,
  PlcWriteVarsResult,
  PlcHmiArmResult,
  PlcHmiStuckEntry,
  PlcAccess,
  PlcBlockRef,
  PlcBlocksResult,
  PlcUploadBlockResult,
  PlcConnectResult,
  PlcControlOp,
  PlcControlResult,
  PlcDownloadResult,
  PlcEvent,
  PlcScanEvent,
  PlcScanStartResult,
  PlcStatus,
  PlcUploadAllResult,
  PlcBackupResult,
  PlcRestorePlanResult,
  PlcRestoreResult,
  PlcUploadProgress,
  PlcWriteProgress,
} from './online/plcTypes';

export interface RecentEntry {
  path: string;
  name: string;
  lastOpened: string;
  exists: boolean;
}

export interface ConfirmTexts {
  title: string;
  message: string;
  yes: string;
  no: string;
  cancel: string;
}

export interface QuestionTexts {
  title: string;
  message: string;
  yes: string;
  no: string;
  /** «No» è il pulsante predefinito (azioni che toccano l'impianto). */
  defaultNo?: boolean;
}

export interface RecoveryInfo {
  originalPath: string;
  projectName: string;
  savedAt: string;
}

export interface RecoveryEntry {
  key: string;
  info: RecoveryInfo;
}

export interface FileFilter {
  name: string; // già tradotto dal chiamante
  extensions: string[]; // senza punto
}

export type KitConnectionType = 'pg' | 'op' | 'basic';

export interface KitStartOptions {
  host: string;
  port: number;
  rack: number;
  slot: number;
  connectionType: KitConnectionType;
  includeBlocks: boolean;
}

export interface KitProgress {
  phase: 'connect' | 'identity' | 'szl' | 'blocks' | 'upload' | 'done';
  done: number;
  total: number;
  message: string;
}

/** Riepilogo della raccolta come lo mostra la finestra (sottoinsieme del riepilogo del kit). */
export interface KitSummary {
  /** Indirizzo usato, in forma canonica. */
  host?: string;
  identity?: { orderNumber: string; moduleName?: string };
  mode?: string;
  /** Livelli di protezione letti dalla CPU (SZL 0x0132/0x0232 indice 4). */
  protection?: { switchLevel?: number; paramLevel?: number; validLevel?: number };
  szlRead: number;
  blocksListed: number;
  blocksUploaded: number;
  refusedCount: number;
  errors: { step: string; code: string; message: string }[];
}

export type KitStartResult =
  | { ok: true; savedTo: string | null; summary: KitSummary; saveError?: string }
  | { ok: false; error: string };

export interface PrintRequest {
  /** Documento HTML completo (da `buildPrintDocument`). */
  html: string;
  /** `pdf`: finestra «Salva con nome» e file; `print`: finestra di stampa del sistema. */
  mode: 'pdf' | 'print';
  paper: 'A4' | 'Letter';
  landscape: boolean;
  /** Testo del piè di pagina (nome del progetto). */
  title: string;
  defaultName: string;
}

export type PrintResult =
  | { status: 'saved'; path: string }
  | { status: 'printed' }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

export interface BaaBridge {
  platform: 'win32' | 'darwin' | 'linux';
  appVersion(): Promise<string>;
  defaultProjectDir(): Promise<string>; // <Documenti>/BaaPortal
  showOpenProjectDialog(): Promise<string | null>; // filtro *.baap
  showSaveProjectDialog(suggestedName: string): Promise<string | null>;
  showSelectFolderDialog(): Promise<string | null>;
  /** Sceglie una cartella e ne elenca i file con le estensioni date (primo livello, al massimo 500); null se annullato. */
  showSelectFolderFiles(extensions: string[]): Promise<string[] | null>;
  showOpenFileDialog(opts: { filters: FileFilter[]; multi?: boolean }): Promise<string[]>; // [] se annullato
  showSaveFileDialog(opts: { defaultName: string; filters: FileFilter[] }): Promise<string | null>;
  readFile(path: string): Promise<Uint8Array>;
  writeFileAtomic(path: string, data: Uint8Array): Promise<void>; // crea le cartelle mancanti
  fileExists(path: string): Promise<boolean>;
  recentList(): Promise<RecentEntry[]>; // exists ricalcolato a ogni chiamata
  recentAdd(path: string, name: string): Promise<RecentEntry[]>;
  recentRemove(path: string): Promise<RecentEntry[]>;
  setWindowTitle(title: string): void;
  confirmUnsaved(texts: ConfirmTexts): Promise<'save' | 'discard' | 'cancel'>; // finestra nativa
  showError(title: string, message: string): Promise<void>; // finestra nativa
  onOpenFileRequest(cb: (path: string) => void): () => void; // associazione file / seconda istanza
  onCloseRequest(cb: () => void): () => void;
  closeWindowConfirmed(): void;
  /** La chiusura è stata annullata dall'utente (es. «Annulla» al salvataggio). */
  closeWindowCancelled(): void;
  rendererReady(): void; // sblocca le richieste di apertura in coda
  clipboardWriteText(text: string): void;
  /** Lingua dell'app per le finestre native del processo principale (assente: restano in italiano). */
  setLanguage?(lang: string): void;
  clipboardReadText(): Promise<string>;
  askQuestion(texts: QuestionTexts): Promise<boolean>; // finestra nativa, true = sì
  recoveryWrite(key: string, data: Uint8Array, info: RecoveryInfo): Promise<void>;
  recoveryList(): Promise<RecoveryEntry[]>;
  recoveryRead(key: string): Promise<Uint8Array>;
  recoveryDelete(key: string): Promise<void>;
  // Raccolta dati CPU in sola lettura: la rete la usa solo il processo principale.
  startKit(opts: KitStartOptions): Promise<KitStartResult>;
  cancelKit(): void;
  saveKitResult(): Promise<string | null>; // salva l'ultima raccolta; null se annullato
  /** Riepilogo dell'ultima raccolta finita e non ancora salvata (dal processo principale), o null. */
  kitUnsavedSummary(): Promise<KitSummary | null>;
  onKitProgress(cb: (p: KitProgress) => void): () => void;
  // Collegamento online a una CPU reale, sempre in sola lettura: la rete la usa solo il processo principale.
  plcConnect(access: PlcAccess): Promise<PlcConnectResult>;
  plcDisconnect(): Promise<void>;
  plcStatus(): Promise<PlcStatus>;
  onPlcEvent(cb: (e: PlcEvent) => void): () => void;
  // Ricerca dei dispositivi accessibili: solo su richiesta, una per finestra, interrompibile.
  plcInterfaces(): Promise<NetInterface[]>;
  /** Porte seriali del PC, per l'adattatore MPI. */
  plcSerialPorts(): Promise<SerialPortInfo[]>;
  /** Nodi del bus MPI dall'adattatore su `link.port`; `cpuAddress` non conta. */
  plcMpiNodes(link: MpiLink): Promise<PlcMpiNodesResult>;
  /** `address` è l'indirizzo di una delle interfacce restituite da `plcInterfaces`. */
  plcScanStart(address: string): Promise<PlcScanStartResult>;
  plcScanCancel(): Promise<void>;
  onPlcScanEvent(cb: (e: PlcScanEvent) => void): () => void;
  // Scritture nella CPU del collegamento online di questa finestra: l'indirizzo lo decide il processo
  // principale e ogni operazione passa da una conferma nativa. Mai eccezioni: l'esito dice tutto.
  plcDownload(
    files: Uint8Array[],
    opts?: { deleteBlocks?: PlcBlockRef[] },
  ): Promise<PlcDownloadResult>;
  plcControl(op: PlcControlOp): Promise<PlcControlResult>;
  /** Diagnostica in sola lettura sul collegamento della finestra; ogni parte ha il suo esito. */
  plcDiagnostics(parts: DiagPart[]): Promise<PlcDiagResult>;
  /** Imposta l'ora della CPU: conferma nativa nel processo principale. */
  plcSetClock(req: PlcClockRequest): Promise<PlcClockResult>;
  /** Legge gli operandi di una tabella di controllo (sola lettura, al massimo 200); mai eccezioni. */
  plcReadWatch(items: PlcWatchTarget[]): Promise<PlcReadWatchResult>;
  /** Scrive valori negli operandi (I, Q, M, DB): conferma nativa nel processo principale. */
  plcWriteVars(items: PlcWriteVarItem[]): Promise<PlcWriteVarsResult>;
  /**
   * Runtime HMI in scrittura: una conferma nativa sola, nel processo principale. Il token vale
   * finché non si chiama `plcHmiDisarm` con lo stesso token, la pagina si ricarica o il
   * collegamento online cambia; alla revoca il processo principale riporta a 0 gli impulsi premuti.
   */
  plcHmiArm(): Promise<PlcHmiArmResult>;
  plcHmiDisarm(token: string): Promise<void>;
  /**
   * Scrive dal runtime HMI (I, Q, M, DB) senza altre conferme: rifiutato senza un token valido.
   * `jog`: pressione di un pulsante a impulsi (il processo principale ricorda il bit fino allo 0).
   */
  plcHmiWrite(token: string, items: PlcWriteVarItem[], jog?: boolean): Promise<PlcWriteVarsResult>;
  /**
   * Pulsanti a impulsi il cui 0 automatico non è riuscito (anche in una sessione precedente):
   * restano finché `plcHmiStuckAck` non li dà per visti o uno 0 riuscito non li toglie.
   */
  plcHmiStuck(): Promise<PlcHmiStuckEntry[]>;
  plcHmiStuckAck(keys: string[]): Promise<void>;
  onPlcHmiStuck(cb: (list: PlcHmiStuckEntry[]) => void): () => void;
  /** Elenco dei blocchi della CPU collegata (sola lettura); mai eccezioni: l'esito dice tutto. */
  plcBlocks(): Promise<PlcBlocksResult>;
  /** Carica un solo blocco OB, FB, FC o DB dalla CPU collegata (sola lettura); mai eccezioni. */
  plcUploadBlock(type: PlcBlockRef['type'], number: number): Promise<PlcUploadBlockResult>;
  /** Osservazione di un blocco (stato del blocco v2): una sola per CPU; mai eccezioni. */
  plcStatusStart(req: PlcStatusRequest): Promise<PlcStatusStartResult>;
  plcStatusWindow(req: PlcStatusRequest): Promise<PlcStatusWindowResult>;
  plcStatusRead(): Promise<PlcStatusReadResult>;
  plcStatusStop(): Promise<void>;
  /** Stack di chiamata (sperimentale, solo in STOP/HOLD); `experimental` è l'impostazione, ricontrollata nel main. */
  plcReadStacks(experimental: boolean): Promise<PlcStacksResult>;
  onPlcWriteProgress(cb: (p: PlcWriteProgress) => void): () => void;
  /**
   * Carica OB, FB, FC e DB da una CPU in sola lettura, su un collegamento proprio (non serve essere
   * online). Uno per finestra; mai eccezioni: l'esito dice tutto.
   */
  plcUploadAll(access: PlcAccess): Promise<PlcUploadAllResult>;
  plcUploadCancel(): Promise<void>;
  onPlcUploadProgress(cb: (p: PlcUploadProgress) => void): () => void;
  /**
   * Backup online: chiede il file con la finestra nativa, carica OB, FB, FC, DB e SDB su un
   * collegamento proprio in sola lettura e scrive il `.baapbak`. L'avanzamento arriva da
   * `onPlcUploadProgress`; mai eccezioni.
   */
  plcBackup(): Promise<PlcBackupResult>;
  plcBackupCancel(): Promise<void>;
  /**
   * Ripristino di un `.baapbak` (SPERIMENTALE, mai provato su una CPU reale): `plcRestorePlan`
   * apre la finestra di scelta del file e prepara il piano nel processo principale; `plcRestore`
   * lo esegue con il `token`, dopo le conferme native. Mai eccezioni.
   */
  plcRestorePlan(): Promise<PlcRestorePlanResult>;
  plcRestore(req: { token: string; restart: boolean }): Promise<PlcRestoreResult>;
  plcRestoreInterrupt(): Promise<void>;
  /** Aggiornamenti dell'app (solo build pacchettizzate; altrove `enabled` è falso). */
  updateInfo(): Promise<UpdateInfoView>;
  /** L'ultimo evento significativo, per ricostruire l'avviso dopo una ricarica. */
  updateState(): Promise<UpdateEvent | null>;
  updateSetPrefs(p: UpdatePrefs): Promise<void>;
  updateCheck(): Promise<void>;
  updateDownload(): Promise<void>;
  updateCancelDownload(): Promise<void>;
  updateCanInstall(): Promise<UpdateCanInstall>;
  /** Con successo l'app esce; altrimenti dice perché non può. */
  updateInstall(): Promise<{ ok: false; reason: 'busy' | 'notReady' } | undefined>;
  /** macOS: mostra nel Finder il DMG scaricato (il percorso lo tiene il main). */
  updateShowInFolder(): Promise<void>;
  updateLater(version: string): Promise<void>;
  updateOpenNotes(version: string): Promise<void>;
  onUpdateEvent(cb: (e: UpdateEvent) => void): () => void;
  /** Stampa o salva in PDF un documento HTML in una finestra nascosta e isolata; mai eccezioni. */
  printDocument(req: PrintRequest): Promise<PrintResult>;
  testOverrides(): Promise<{ recoveryIntervalMs?: number }>; // sempre {} nelle build pacchettizzate
}
