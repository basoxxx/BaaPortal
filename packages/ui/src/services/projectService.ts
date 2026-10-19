import type { TFunction } from 'i18next';
import type { StoreApi } from 'zustand/vanilla';
import {
  BaapFormatError,
  createProject,
  readBaap,
  validateProjectName,
  writeBaap,
  type Project,
} from '@baaportal/project';
import type { BaaBridge } from '../bridge';
import type { AppState } from '../state/store';

export type CreateResult =
  | { ok: true }
  | { ok: false; error: 'EXISTS' | 'WRITE_FAILED' | 'CANCELED' | 'INVALID_PATH' | 'INVALID_NAME' };

export interface ProjectService {
  createNew(input: {
    name: string;
    dir: string;
    author: string;
    comment: string;
  }): Promise<CreateResult>;
  openFromDialog(): Promise<boolean>;
  open(path: string): Promise<boolean>;
  save(): Promise<boolean>;
  saveAs(): Promise<boolean>;
  close(): Promise<boolean>;
  /** Apre un progetto recuperato come documento modificato (revisione 1, mai salvata). */
  openRecovered(project: Project, filePath: string): Promise<boolean>;
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
  /** Conferma le bozze dei campi in modifica prima di salvare, chiudere o aprire. */
  flushPendingEdits?: () => void;
  /** Chiamata alla chiusura confermata della finestra, prima di chiuderla (es. cancella la copia di recupero). */
  beforeWindowClose?: () => Promise<void>;
}

const APP_TITLE = 'BaaPortal';

function errorCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'UNKNOWN';
}

/** Percorso assoluto POSIX (/…), Windows con unità (C:\…) o UNC (\\server\share…). */
export function isAbsolutePath(p: string): boolean {
  return /^\//.test(p) || /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p);
}

export function joinPath(dir: string, file: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith(sep) ? dir + file : dir + sep + file;
}

export function createProjectService(deps: ProjectServiceDeps): ProjectService {
  const { store, bridge, t, appVersion } = deps;
  const now = deps.now ?? (() => new Date());
  const flush = () => deps.flushPendingEdits?.();

  const showError = (message: string) => bridge.showError(t('errors.title'), message);

  const announce = (key: 'created' | 'opened' | 'saved', name: string) =>
    store
      .getState()
      .pushMessage({ severity: 'info', textKey: `messages.${key}`, params: { name } });

  async function writeProject(project: Project, path: string): Promise<boolean> {
    try {
      await bridge.writeFileAtomic(path, writeBaap(project, { appVersion }));
      return true;
    } catch (e) {
      await showError(t('errors.write', { path, code: errorCode(e) }));
      return false;
    }
  }

  /** I recenti sono un'comodità: un loro errore non deve mai far fallire l'operazione. */
  async function addRecentBestEffort(path: string, name: string): Promise<void> {
    try {
      await bridge.recentAdd(path, name);
    } catch {
      /* recenti non aggiornati */
    }
  }

  async function ensureCanDiscard(): Promise<boolean> {
    flush();
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

  async function createNew(input: {
    name: string;
    dir: string;
    author: string;
    comment: string;
  }): Promise<CreateResult> {
    const nameCheck = validateProjectName(input.name);
    if (!nameCheck.ok) {
      await showError(t(`errors.name.${nameCheck.reason}`));
      return { ok: false, error: 'INVALID_NAME' };
    }
    if (!isAbsolutePath(input.dir)) {
      await showError(t('errors.pathNotAbsolute'));
      return { ok: false, error: 'INVALID_PATH' };
    }
    if (!(await ensureCanDiscard())) return { ok: false, error: 'CANCELED' };
    const path = joinPath(input.dir, `${input.name}.baap`);
    if (await bridge.fileExists(path)) {
      await showError(t('errors.exists', { path }));
      return { ok: false, error: 'EXISTS' };
    }
    const project = createProject(
      { name: input.name, author: input.author, comment: input.comment },
      now(),
    );
    if (!(await writeProject(project, path))) return { ok: false, error: 'WRITE_FAILED' };
    store
      .getState()
      .setDoc({ project, filePath: path, dirty: false, revision: 0, savedRevision: 0 });
    await addRecentBestEffort(path, project.meta.name);
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
    store
      .getState()
      .setDoc({ project, filePath: path, dirty: false, revision: 0, savedRevision: 0 });
    await addRecentBestEffort(path, project.meta.name);
    announce('opened', project.meta.name);
    return true;
  }

  async function openFromDialog(): Promise<boolean> {
    const path = await bridge.showOpenProjectDialog();
    return path ? open(path) : false;
  }

  async function saveTo(path: string): Promise<boolean> {
    const before = store.getState();
    const doc = before.doc;
    if (!doc) return false;
    const loadId = before.docLoadId;
    const revision = doc.revision;
    const modifiedAt = now().toISOString();
    const project: Project = { ...doc.project, meta: { ...doc.project.meta, modifiedAt } };
    if (!(await writeProject(project, path))) return false;
    // Durante la scrittura l'utente può aver modificato (la revisione catturata resta quella scritta,
    // quindi il documento resta "modificato") o sostituito il documento.
    if (store.getState().docLoadId === loadId) {
      store.getState().markSaved({ filePath: path, revision, modifiedAt });
    }
    await addRecentBestEffort(path, project.meta.name);
    announce('saved', project.meta.name);
    return true;
  }

  // I salvataggi sono serializzati: uno che arriva mentre un altro è in corso attende e poi
  // scrive di nuovo solo se il documento è ancora modificato.
  let chain: Promise<unknown> = Promise.resolve();
  let queued = 0;
  function enqueueSave(fn: (waited: boolean) => Promise<boolean>): Promise<boolean> {
    const waited = queued > 0;
    queued++;
    const run = chain.then(() => fn(waited));
    chain = run
      .catch(() => undefined)
      .finally(() => {
        queued--;
      });
    return run;
  }

  function save(): Promise<boolean> {
    flush();
    return enqueueSave(async (waited) => {
      const doc = store.getState().doc;
      if (!doc) return false;
      if (waited && !doc.dirty) return true;
      return saveTo(doc.filePath);
    });
  }

  async function saveAs(): Promise<boolean> {
    flush();
    const doc = store.getState().doc;
    if (!doc) return false;
    const path = await bridge.showSaveProjectDialog(`${doc.project.meta.name}.baap`);
    return path ? enqueueSave(() => saveTo(path)) : false;
  }

  async function close(): Promise<boolean> {
    if (!store.getState().doc) return true;
    if (!(await ensureCanDiscard())) return false;
    store.getState().setDoc(null);
    return true;
  }

  async function openRecovered(project: Project, filePath: string): Promise<boolean> {
    if (!(await ensureCanDiscard())) return false;
    store.getState().setDoc({ project, filePath, dirty: true, revision: 1, savedRevision: 0 });
    await addRecentBestEffort(filePath, project.meta.name);
    return true;
  }

  async function handleCloseRequest(): Promise<void> {
    if (!(await ensureCanDiscard())) return;
    try {
      await deps.beforeWindowClose?.();
    } catch {
      /* la chiusura non deve dipendere dalla pulizia */
    }
    bridge.closeWindowConfirmed();
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
    openRecovered,
    handleCloseRequest,
    dispose() {
      unsubscribeStore();
      unsubscribeOpen();
      unsubscribeClose();
    },
  };
}
