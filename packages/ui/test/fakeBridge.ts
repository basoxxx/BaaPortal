import type {
  BaaBridge,
  ConfirmTexts,
  QuestionTexts,
  RecentEntry,
  RecoveryInfo,
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
  clipboard = '';
  // Risposte a askQuestion, consumate una per chiamata; a coda vuota la risposta è sì (true).
  questionAnswers: boolean[] = [];
  questions: QuestionTexts[] = [];
  recovery = new Map<string, { data: Uint8Array; info: RecoveryInfo }>();
  testOverridesValue: { recoveryIntervalMs?: number } = {};
  title = '';
  closeConfirmed = false;
  readyCalls = 0;
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
    return this.openCbs.size + this.closeCbs.size;
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
    return null;
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
  async testOverrides() {
    return this.testOverridesValue;
  }
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}
