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

export interface BaaBridge {
  platform: 'win32' | 'darwin' | 'linux';
  appVersion(): Promise<string>;
  defaultProjectDir(): Promise<string>; // <Documenti>/BaaPortal
  showOpenProjectDialog(): Promise<string | null>; // filtro *.baap
  showSaveProjectDialog(suggestedName: string): Promise<string | null>;
  showSelectFolderDialog(): Promise<string | null>;
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
  rendererReady(): void; // sblocca le richieste di apertura in coda
  clipboardWriteText(text: string): void;
  clipboardReadText(): Promise<string>;
  askQuestion(texts: QuestionTexts): Promise<boolean>; // finestra nativa, true = sì
  recoveryWrite(key: string, data: Uint8Array, info: RecoveryInfo): Promise<void>;
  recoveryList(): Promise<RecoveryEntry[]>;
  recoveryRead(key: string): Promise<Uint8Array>;
  recoveryDelete(key: string): Promise<void>;
  testOverrides(): Promise<{ recoveryIntervalMs?: number }>; // sempre {} nelle build pacchettizzate
}
