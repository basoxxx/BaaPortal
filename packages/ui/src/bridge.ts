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

export interface BaaBridge {
  platform: 'win32' | 'darwin' | 'linux';
  appVersion(): Promise<string>;
  defaultProjectDir(): Promise<string>; // <Documenti>/BaaPortal
  showOpenProjectDialog(): Promise<string | null>; // filtro *.baap
  showSaveProjectDialog(suggestedName: string): Promise<string | null>;
  showSelectFolderDialog(): Promise<string | null>;
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
}
