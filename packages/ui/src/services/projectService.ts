import type { TFunction } from 'i18next';
import type { StoreApi } from 'zustand/vanilla';
import { BaapFormatError, createProject, readBaap, writeBaap, type Project } from '@baaportal/project';
import type { BaaBridge } from '../bridge';
import type { AppState } from '../state/store';

export type CreateResult = { ok: true } | { ok: false; error: 'EXISTS' | 'WRITE_FAILED' | 'CANCELED' };

export interface ProjectService {
  createNew(input: { name: string; dir: string; author: string; comment: string }): Promise<CreateResult>;
  openFromDialog(): Promise<boolean>;
  open(path: string): Promise<boolean>;
  save(): Promise<boolean>;
  saveAs(): Promise<boolean>;
  close(): Promise<boolean>;
  handleCloseRequest(): Promise<void>;
  /** Annulla le registrazioni sul bridge (StrictMode, smontaggio). */
  dispose(): void;
}

export interface ProjectServiceDeps {
  store: StoreApi<AppState>;
  bridge: BaaBridge;
  t: TFunction;
  appVersion: string;
  now?: () => Date;
}

const APP_TITLE = 'BaaPortal';

function errorCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'UNKNOWN';
}

export function joinPath(dir: string, file: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith(sep) ? dir + file : dir + sep + file;
}

export function createProjectService(deps: ProjectServiceDeps): ProjectService {
  const { store, bridge, t, appVersion } = deps;
  const now = deps.now ?? (() => new Date());

  const showError = (message: string) => bridge.showError(t('errors.title'), message);

  const announce = (key: 'created' | 'opened' | 'saved', name: string) =>
    store.getState().pushMessage({ severity: 'info', textKey: `messages.${key}`, params: { name } });

  async function writeProject(project: Project, path: string): Promise<boolean> {
    try {
      await bridge.writeFileAtomic(path, writeBaap(project, { appVersion }));
      return true;
    } catch (e) {
      await showError(t('errors.write', { path, code: errorCode(e) }));
      return false;
    }
  }

  async function ensureCanDiscard(): Promise<boolean> {
    const doc = store.getState().doc;
    if (!doc?.dirty) return true;
    const answer = await bridge.confirmUnsaved({
      title: t('confirm.unsaved.title'),
      message: t('confirm.unsaved.message', { name: doc.project.meta.name }),
      yes: t('confirm.unsaved.yes'),
      no: t('confirm.unsaved.no'),
      cancel: t('confirm.unsaved.cancel'),
    });
    if (answer === 'cancel') return false;
    if (answer === 'save') return save();
    return true;
  }

  async function createNew(input: { name: string; dir: string; author: string; comment: string }): Promise<CreateResult> {
    if (!(await ensureCanDiscard())) return { ok: false, error: 'CANCELED' };
    const path = joinPath(input.dir, `${input.name}.baap`);
    if (await bridge.fileExists(path)) {
      await showError(t('errors.exists', { path }));
      return { ok: false, error: 'EXISTS' };
    }
    const project = createProject({ name: input.name, author: input.author, comment: input.comment }, now());
    if (!(await writeProject(project, path))) return { ok: false, error: 'WRITE_FAILED' };
    store.getState().setDoc({ project, filePath: path, dirty: false });
    await bridge.recentAdd(path, project.meta.name);
    announce('created', project.meta.name);
    return { ok: true };
  }

  async function open(path: string): Promise<boolean> {
    if (!(await ensureCanDiscard())) return false;
    let project: Project;
    try {
      project = readBaap(await bridge.readFile(path));
    } catch (e) {
      const message =
        e instanceof BaapFormatError
          ? t(`errors.baap.${e.code}`)
          : t('errors.read', { path, code: errorCode(e) });
      await showError(message);
      return false;
    }
    store.getState().setDoc({ project, filePath: path, dirty: false });
    await bridge.recentAdd(path, project.meta.name);
    announce('opened', project.meta.name);
    return true;
  }

  async function openFromDialog(): Promise<boolean> {
    const path = await bridge.showOpenProjectDialog();
    return path ? open(path) : false;
  }

  async function saveTo(path: string): Promise<boolean> {
    const doc = store.getState().doc;
    if (!doc) return false;
    const project: Project = { ...doc.project, meta: { ...doc.project.meta, modifiedAt: now().toISOString() } };
    if (!(await writeProject(project, path))) return false;
    store.getState().setDoc({ project, filePath: path, dirty: false });
    await bridge.recentAdd(path, project.meta.name);
    announce('saved', project.meta.name);
    return true;
  }

  async function save(): Promise<boolean> {
    const doc = store.getState().doc;
    return doc ? saveTo(doc.filePath) : false;
  }

  async function saveAs(): Promise<boolean> {
    const doc = store.getState().doc;
    if (!doc) return false;
    const path = await bridge.showSaveProjectDialog(`${doc.project.meta.name}.baap`);
    return path ? saveTo(path) : false;
  }

  async function close(): Promise<boolean> {
    if (!store.getState().doc) return true;
    if (!(await ensureCanDiscard())) return false;
    store.getState().setDoc(null);
    return true;
  }

  async function handleCloseRequest(): Promise<void> {
    if (await ensureCanDiscard()) bridge.closeWindowConfirmed();
  }

  // Titolo della finestra sempre allineato al documento.
  const titleFor = (s: AppState) => (s.doc ? `${APP_TITLE} - ${s.doc.filePath}` : APP_TITLE);
  let lastTitle = titleFor(store.getState());
  bridge.setWindowTitle(lastTitle);
  const unsubscribeStore = store.subscribe((s) => {
    const title = titleFor(s);
    if (title !== lastTitle) {
      lastTitle = title;
      bridge.setWindowTitle(title);
    }
  });
  const unsubscribeOpen = bridge.onOpenFileRequest((path) => void open(path));
  const unsubscribeClose = bridge.onCloseRequest(() => void handleCloseRequest());
  bridge.rendererReady();

  return {
    createNew,
    openFromDialog,
    open,
    save,
    saveAs,
    close,
    handleCloseRequest,
    dispose() {
      unsubscribeStore();
      unsubscribeOpen();
      unsubscribeClose();
    },
  };
}
