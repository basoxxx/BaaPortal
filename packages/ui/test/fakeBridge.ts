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
  async testOverrides() {
    return this.testOverridesValue;
  }
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}
