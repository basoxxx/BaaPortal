import type {
  BaaBridge,
  FileFilter,
  ConfirmTexts,
  QuestionTexts,
  RecentEntry,
  RecoveryInfo,
  KitProgress,
  KitStartOptions,
  KitStartResult,
  KitSummary,
} from '../src/bridge';
import type {
  NetInterface,
  PlcAccess,
  PlcConnectResult,
  PlcEvent,
  PlcScanEvent,
  PlcScanStartResult,
  PlcStatus,
  PlcBlocksResult,
  PlcBlockRef,
  PlcControlOp,
  PlcControlResult,
  PlcDownloadResult,
  PlcWriteProgress,
  PlcUploadAllResult,
  PlcBackupResult,
  PlcUploadProgress,
  DiagPart,
  PlcClockRequest,
  PlcClockResult,
  PlcDiagResult,
  PlcReadWatchResult,
  PlcWatchTarget,
  PlcWriteVarItem,
  PlcWriteVarsResult,
} from '../src/online/plcTypes';

import type {
  UpdateCanInstall,
  UpdateEvent,
  UpdateInfoView,
  UpdatePrefs,
} from '../src/update/updateTypes';

type Answer = 'save' | 'discard' | 'cancel';

export class FakeBridge implements BaaBridge {
  platform: BaaBridge['platform'] = 'win32';
  files = new Map<string, Uint8Array>();
  recent: RecentEntry[] = [];
  errors: { title: string; message: string }[] = [];
  confirmAnswers: Answer[] = [];
  confirmTexts: ConfirmTexts[] = [];
  openDialogResults: (string | null)[] = [];
  saveDialogResults: (string | null)[] = [];
  // Come i dialoghi di progetto: una risposta per chiamata; a coda vuota [] / null. Le chiamate si registrano.
  folderResults: (string | null)[] = [];
  openFileResults: string[][] = [];
  saveFileResults: (string | null)[] = [];
  openFileCalls: { filters: FileFilter[]; multi?: boolean }[] = [];
  saveFileCalls: { defaultName: string; filters: FileFilter[] }[] = [];
  clipboard = '';
  // Risposte a askQuestion, consumate una per chiamata; a coda vuota la risposta è sì (true).
  questionAnswers: boolean[] = [];
  questions: QuestionTexts[] = [];
  recovery = new Map<string, { data: Uint8Array; info: RecoveryInfo }>();
  testOverridesValue: { recoveryIntervalMs?: number } = {};
  title = '';
  closeConfirmed = false;
  readyCalls = 0;
  // Kit di raccolta: una risposta per chiamata a startKit (a coda vuota un errore); le chiamate si registrano.
  kitResults: KitStartResult[] = [];
  kitStartCalls: KitStartOptions[] = [];
  kitCancelCalls = 0;
  kitSaveResults: (string | null)[] = [];
  kitSaveCalls = 0;
  /** Raccolta finita e non ancora salvata, come la tiene il processo principale. */
  kitUnsaved: KitSummary | null = null;
  private kitHold: Promise<void> | null = null;
  private kitCbs = new Set<(p: KitProgress) => void>();
  private nextWriteError: string | null = null;
  private openCbs = new Set<(p: string) => void>();
  private closeCbs = new Set<() => void>();

  failNextWrite(code: string): void {
    this.nextWriteError = code;
  }
  async emitCloseRequest(): Promise<void> {
    for (const cb of [...this.closeCbs]) cb();
    await flush();
  }
  async emitOpenFile(path: string): Promise<void> {
    for (const cb of [...this.openCbs]) cb(path);
    await flush();
  }
  get listenerCount(): number {
    return this.openCbs.size + this.closeCbs.size + this.kitCbs.size;
  }
  /** Fa restare in corso la prossima startKit finché non si chiama la funzione restituita. */
  holdKit(): () => void {
    let release!: () => void;
    this.kitHold = new Promise<void>((r) => {
      release = r;
    });
    return release;
  }
  async emitKitProgress(p: KitProgress): Promise<void> {
    for (const cb of [...this.kitCbs]) cb(p);
    await flush();
  }

  async appVersion() {
    return '0.1.0';
  }
  async defaultProjectDir() {
    return '/doc/BaaPortal';
  }
  async showOpenProjectDialog() {
    return this.openDialogResults.shift() ?? null;
  }
  async showSaveProjectDialog() {
    return this.saveDialogResults.shift() ?? null;
  }
  async showSelectFolderDialog() {
    return this.folderResults.shift() ?? null;
  }
  async showOpenFileDialog(opts: { filters: FileFilter[]; multi?: boolean }) {
    this.openFileCalls.push(opts);
    return this.openFileResults.shift() ?? [];
  }
  async showSaveFileDialog(opts: { defaultName: string; filters: FileFilter[] }) {
    this.saveFileCalls.push(opts);
    return this.saveFileResults.shift() ?? null;
  }
  async readFile(path: string) {
    const f = this.files.get(path);
    if (!f) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return f;
  }
  async writeFileAtomic(path: string, data: Uint8Array) {
    if (this.nextWriteError) {
      const code = this.nextWriteError;
      this.nextWriteError = null;
      throw Object.assign(new Error(code), { code });
    }
    this.files.set(path, data);
  }
  async fileExists(path: string) {
    return this.files.has(path);
  }
  async recentList() {
    return this.recent;
  }
  async recentAdd(path: string, name: string) {
    this.recent = [
      { path, name, lastOpened: '', exists: true },
      ...this.recent.filter((r) => r.path !== path),
    ];
    return this.recent;
  }
  async recentRemove(path: string) {
    this.recent = this.recent.filter((r) => r.path !== path);
    return this.recent;
  }
  setWindowTitle(title: string) {
    this.title = title;
  }
  async confirmUnsaved(texts: ConfirmTexts): Promise<Answer> {
    this.confirmTexts.push(texts);
    return this.confirmAnswers.shift() ?? 'cancel';
  }
  async showError(title: string, message: string) {
    this.errors.push({ title, message });
  }
  onOpenFileRequest(cb: (p: string) => void) {
    this.openCbs.add(cb);
    return () => {
      this.openCbs.delete(cb);
    };
  }
  onCloseRequest(cb: () => void) {
    this.closeCbs.add(cb);
    return () => {
      this.closeCbs.delete(cb);
    };
  }
  closeWindowConfirmed() {
    this.closeConfirmed = true;
  }
  rendererReady() {
    this.readyCalls++;
  }
  clipboardWriteText(text: string) {
    this.clipboard = text;
  }
  async clipboardReadText() {
    return this.clipboard;
  }
  async askQuestion(texts: QuestionTexts) {
    this.questions.push(texts);
    return this.questionAnswers.shift() ?? true;
  }
  async recoveryWrite(key: string, data: Uint8Array, info: RecoveryInfo) {
    this.recovery.set(key, { data, info });
  }
  async recoveryList() {
    return [...this.recovery].map(([key, v]) => ({ key, info: v.info }));
  }
  async recoveryRead(key: string) {
    const r = this.recovery.get(key);
    if (!r) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return r.data;
  }
  async recoveryDelete(key: string) {
    this.recovery.delete(key);
  }
  async startKit(opts: KitStartOptions): Promise<KitStartResult> {
    this.kitStartCalls.push(opts);
    const hold = this.kitHold;
    this.kitHold = null;
    if (hold) await hold;
    return this.kitResults.shift() ?? { ok: false, error: 'nessun risultato previsto' };
  }
  cancelKit() {
    this.kitCancelCalls++;
  }
  async saveKitResult() {
    this.kitSaveCalls++;
    return this.kitSaveResults.shift() ?? null;
  }
  async kitUnsavedSummary() {
    return this.kitUnsaved;
  }
  onKitProgress(cb: (p: KitProgress) => void) {
    this.kitCbs.add(cb);
    return () => {
      this.kitCbs.delete(cb);
    };
  }
  // Collegamento online: una risposta per chiamata a plcConnect; le chiamate si registrano.
  plcResults: PlcConnectResult[] = [];
  plcConnectCalls: PlcAccess[] = [];
  plcDisconnectCalls = 0;
  plcState: PlcStatus = { connected: false };
  private plcCbs = new Set<(e: PlcEvent) => void>();
  async plcConnect(access: PlcAccess): Promise<PlcConnectResult> {
    this.plcConnectCalls.push(access);
    const r = this.plcResults.shift() ?? { ok: false, error: 'nessun risultato previsto' };
    this.plcState = r.ok ? { connected: true, access } : { connected: false };
    return r;
  }
  async plcDisconnect() {
    this.plcDisconnectCalls++;
    this.plcState = { connected: false };
  }
  async plcStatus() {
    return this.plcState;
  }
  onPlcEvent(cb: (e: PlcEvent) => void) {
    this.plcCbs.add(cb);
    return () => {
      this.plcCbs.delete(cb);
    };
  }
  emitPlcEvent(e: PlcEvent): void {
    for (const cb of [...this.plcCbs]) cb(e);
  }
  // Elenco blocchi della CPU: una risposta per chiamata (l'ultima resta).
  /** Diagnostica: `plcDiagnosticsImpl` risponde (altrimenti nessuna parte); le chiamate si registrano. */
  plcDiagnosticsCalls: DiagPart[][] = [];
  plcDiagnosticsImpl: (parts: DiagPart[]) => Promise<PlcDiagResult> | PlcDiagResult = () => ({
    ok: true,
    data: {},
  });
  async plcDiagnostics(parts: DiagPart[]): Promise<PlcDiagResult> {
    this.plcDiagnosticsCalls.push(parts);
    return this.plcDiagnosticsImpl(parts);
  }
  plcClockCalls: PlcClockRequest[] = [];
  plcClockResults: PlcClockResult[] = [];
  async plcSetClock(req: PlcClockRequest): Promise<PlcClockResult> {
    this.plcClockCalls.push(req);
    return (
      this.plcClockResults.shift() ?? {
        ok: true,
        written: { year: 2026, month: 1, day: 1, hour: 0, minute: 0, second: 0, ms: 0 },
      }
    );
  }
  /** Tabelle di controllo online: `plcReadWatchImpl` risponde; le chiamate si registrano. */
  plcReadWatchCalls: PlcWatchTarget[][] = [];
  plcReadWatchImpl: (items: PlcWatchTarget[]) => Promise<PlcReadWatchResult> | PlcReadWatchResult =
    (items) => ({ ok: true, values: items.map(() => ({ bytes: new Uint8Array(2) })) });
  async plcReadWatch(items: PlcWatchTarget[]): Promise<PlcReadWatchResult> {
    this.plcReadWatchCalls.push(items);
    return this.plcReadWatchImpl(items);
  }
  plcWriteVarsCalls: PlcWriteVarItem[][] = [];
  plcWriteVarsResults: PlcWriteVarsResult[] = [];
  async plcWriteVars(items: PlcWriteVarItem[]): Promise<PlcWriteVarsResult> {
    this.plcWriteVarsCalls.push(items);
    return (
      this.plcWriteVarsResults.shift() ?? { ok: true, results: items.map(() => ({ ok: true })) }
    );
  }
  plcBlocksResults: PlcBlocksResult[] = [{ ok: true, blocks: [] }];
  plcBlocksCalls = 0;
  async plcBlocks(): Promise<PlcBlocksResult> {
    this.plcBlocksCalls++;
    const r =
      this.plcBlocksResults.length > 1 ? this.plcBlocksResults.shift() : this.plcBlocksResults[0];
    return r ?? { ok: false, error: 'nessun risultato previsto' };
  }
  // Scritture nella CPU: una risposta per chiamata (a coda vuota, riuscite); le chiamate si registrano.
  plcDownloadResults: PlcDownloadResult[] = [];
  plcDownloadCalls: { files: Uint8Array[]; deleteBlocks: PlcBlockRef[] }[] = [];
  plcControlResults: PlcControlResult[] = [];
  plcControlCalls: PlcControlOp[] = [];
  /** Registro ordinato di tutte le scritture (per verificare la sequenza). */
  plcWriteLog: string[] = [];
  private plcWriteCbs = new Set<(p: PlcWriteProgress) => void>();
  async plcDownload(
    files: Uint8Array[],
    opts?: { deleteBlocks?: PlcBlockRef[] },
  ): Promise<PlcDownloadResult> {
    this.plcDownloadCalls.push({ files, deleteBlocks: opts?.deleteBlocks ?? [] });
    this.plcWriteLog.push('download');
    return this.plcDownloadResults.shift() ?? { ok: true, loaded: [], deleted: [] };
  }
  async plcControl(op: PlcControlOp): Promise<PlcControlResult> {
    this.plcControlCalls.push(op);
    this.plcWriteLog.push(op);
    return this.plcControlResults.shift() ?? { ok: true, result: 'ok' };
  }
  onPlcWriteProgress(cb: (p: PlcWriteProgress) => void) {
    this.plcWriteCbs.add(cb);
    return () => {
      this.plcWriteCbs.delete(cb);
    };
  }
  emitPlcWriteProgress(p: PlcWriteProgress): void {
    for (const cb of [...this.plcWriteCbs]) cb(p);
  }
  plcUploadBlockResults = new Map<string, PlcUploadBlockResult>();
  plcUploadBlockCalls: string[] = [];
  async plcUploadBlock(type: string, number: number): Promise<PlcUploadBlockResult> {
    this.plcUploadBlockCalls.push(`${type}${number}`);
    return (
      this.plcUploadBlockResults.get(`${type}${number}`) ?? { ok: false, error: 'nessun blocco' }
    );
  }
  // Ricerca dei dispositivi accessibili.
  plcBackupResults: PlcBackupResult[] = [];
  plcBackupCalls = 0;
  plcBackupCancelCalls = 0;
  /** Se c'è, plcBackup attende questa promessa prima di rispondere. */
  plcBackupGate: Promise<void> | null = null;
  async plcBackup(): Promise<PlcBackupResult> {
    this.plcBackupCalls++;
    if (this.plcBackupGate) await this.plcBackupGate;
    return this.plcBackupResults.shift() ?? { ok: false, error: 'nessun risultato previsto' };
  }
  async plcBackupCancel() {
    this.plcBackupCancelCalls++;
  }
  plcUploadResults: PlcUploadAllResult[] = [];
  plcUploadCalls: PlcAccess[] = [];
  plcUploadCancelCalls = 0;
  /** Se c'è, plcUploadAll attende questa promessa prima di rispondere. */
  plcUploadGate: Promise<void> | null = null;
  private plcUploadCbs = new Set<(p: PlcUploadProgress) => void>();
  async plcUploadAll(access: PlcAccess): Promise<PlcUploadAllResult> {
    this.plcUploadCalls.push(access);
    if (this.plcUploadGate) await this.plcUploadGate;
    return this.plcUploadResults.shift() ?? { ok: false, error: 'nessun risultato previsto' };
  }
  async plcUploadCancel() {
    this.plcUploadCancelCalls++;
  }
  onPlcUploadProgress(cb: (p: PlcUploadProgress) => void) {
    this.plcUploadCbs.add(cb);
    return () => {
      this.plcUploadCbs.delete(cb);
    };
  }
  emitPlcUploadProgress(p: PlcUploadProgress): void {
    for (const cb of [...this.plcUploadCbs]) cb(p);
  }

  plcInterfacesValue: NetInterface[] = [];
  plcScanResults: PlcScanStartResult[] = [];
  plcScanStartCalls: string[] = [];
  plcScanCancelCalls = 0;
  private plcScanCbs = new Set<(e: PlcScanEvent) => void>();
  async plcInterfaces() {
    return this.plcInterfacesValue;
  }
  async plcScanStart(address: string): Promise<PlcScanStartResult> {
    this.plcScanStartCalls.push(address);
    return this.plcScanResults.shift() ?? { ok: false, error: 'nessun risultato previsto' };
  }
  async plcScanCancel() {
    this.plcScanCancelCalls++;
  }
  onPlcScanEvent(cb: (e: PlcScanEvent) => void) {
    this.plcScanCbs.add(cb);
    return () => {
      this.plcScanCbs.delete(cb);
    };
  }
  emitPlcScanEvent(e: PlcScanEvent): void {
    for (const cb of [...this.plcScanCbs]) cb(e);
  }
  updateInfoValue: UpdateInfoView = {
    enabled: false,
    prereleaseBuild: false,
    current: '0.0.0',
    platform: 'win32',
    mode: 'none',
  };
  updateStateValue: UpdateEvent | null = null;
  updatePrefsCalls: UpdatePrefs[] = [];
  updateCalls: string[] = [];
  updateCanInstallValue: UpdateCanInstall = { ok: true };
  private updateCbs = new Set<(e: UpdateEvent) => void>();
  async updateInfo() {
    return this.updateInfoValue;
  }
  async updateState() {
    return this.updateStateValue;
  }
  async updateSetPrefs(p: UpdatePrefs) {
    this.updatePrefsCalls.push(p);
  }
  async updateCheck() {
    this.updateCalls.push('check');
  }
  async updateDownload() {
    this.updateCalls.push('download');
  }
  async updateCancelDownload() {
    this.updateCalls.push('cancel');
  }
  async updateCanInstall() {
    return this.updateCanInstallValue;
  }
  async updateInstall(): Promise<{ ok: false; reason: 'busy' | 'notReady' } | undefined> {
    this.updateCalls.push('install');
    return { ok: false, reason: 'notReady' };
  }
  async updateLater(version: string) {
    this.updateCalls.push(`later:${version}`);
  }
  async updateOpenNotes(version: string) {
    this.updateCalls.push(`notes:${version}`);
  }
  onUpdateEvent(cb: (e: UpdateEvent) => void) {
    this.updateCbs.add(cb);
    return () => {
      this.updateCbs.delete(cb);
    };
  }
  emitUpdateEvent(e: UpdateEvent): void {
    for (const cb of [...this.updateCbs]) cb(e);
  }
  async testOverrides() {
    return this.testOverridesValue;
  }
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}
