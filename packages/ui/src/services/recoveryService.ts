import type { TFunction } from 'i18next';
import type { StoreApi } from 'zustand/vanilla';
import { BaapFormatError, readBaap, writeBaap } from '@baaportal/project';
import type { BaaBridge, RecoveryEntry } from '../bridge';
import { i18next } from '../i18n';
import type { AppState } from '../state/store';
import type { ProjectService } from './projectService';

export const RECOVERY_INTERVAL_MS = 60_000;

/** 'p-' + FNV-1a a 32 bit (esadecimale, 8 cifre) del percorso in minuscolo: rispetta ^[a-z0-9-]{1,64}$. */
export function recoveryKey(filePath: string): string {
  let h = 0x811c9dc5;
  const s = filePath.toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `p-${h.toString(16).padStart(8, '0')}`;
}

export interface RecoveryService {
  /** Una verifica con scrittura immediata della copia (se serve). */
  flush(): Promise<void>;
  /** All'avvio: propone il recupero delle copie rimaste da una chiusura anomala. */
  offerRecovery(): Promise<void>;
  /** Cancella la copia del documento con questo percorso (idempotente, errori ignorati). */
  clear(filePath: string): Promise<void>;
  dispose(): void;
}

export interface RecoveryDeps {
  store: StoreApi<AppState>;
  bridge: BaaBridge;
  t: TFunction;
  appVersion: string;
  service: ProjectService;
  intervalMs?: number;
  now?: () => Date;
}

function errorCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'UNKNOWN';
}

export function createRecoveryService(deps: RecoveryDeps): RecoveryService {
  const { store, bridge, t, appVersion, service } = deps;
  const now = deps.now ?? (() => new Date());
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastWrittenRevision: number | null = null;
  let lastLoadId = store.getState().docLoadId;
  let warnedLoadId: number | null = null;

  // Scritture e cancellazioni sono serializzate: una cancellazione non può essere scavalcata da una
  // scrittura iniziata prima (che lascerebbe una copia obsoleta).
  let chain: Promise<unknown> = Promise.resolve();
  function enqueue(op: () => Promise<void>): Promise<void> {
    const run = chain.then(op);
    chain = run.catch(() => undefined);
    return run.catch(() => undefined);
  }

  function remove(filePath: string): Promise<void> {
    return enqueue(() => bridge.recoveryDelete(recoveryKey(filePath)));
  }

  // true se non c'era nulla da scrivere o la scrittura è riuscita.
  async function flushChecked(): Promise<boolean> {
    let ok = true;
    await enqueue(async () => {
      const s = store.getState();
      const doc = s.doc;
      if (!doc || !doc.dirty) return;
      if (s.docLoadId === lastLoadId && doc.revision === lastWrittenRevision) return;
      const loadId = s.docLoadId;
      try {
        await bridge.recoveryWrite(
          recoveryKey(doc.filePath),
          writeBaap(doc.project, { appVersion }),
          {
            originalPath: doc.filePath,
            projectName: doc.project.meta.name,
            savedAt: now().toISOString(),
          },
        );
        if (store.getState().docLoadId === loadId) {
          lastLoadId = loadId;
          lastWrittenRevision = doc.revision;
        }
      } catch {
        ok = false;
        // Un solo avviso per documento: niente messaggi ogni minuto.
        if (warnedLoadId !== loadId) {
          warnedLoadId = loadId;
          store
            .getState()
            .pushMessage({ severity: 'warning', textKey: 'messages.recoveryWriteFailed' });
        }
      }
    });
    return ok;
  }
  const flush = async (): Promise<void> => {
    await flushChecked();
  };

  // Pulizia: salvataggio, chiusura/sostituzione del documento, "Salva con nome".
  const unsubscribe = store.subscribe((s, prev) => {
    if (s.docLoadId !== prev.docLoadId) lastWrittenRevision = null;
    if (!prev.doc) return;
    if (s.docLoadId !== prev.docLoadId || !s.doc) {
      lastWrittenRevision = null;
      void remove(prev.doc.filePath);
    } else if (s.doc.filePath !== prev.doc.filePath) {
      lastWrittenRevision = null;
      void remove(prev.doc.filePath);
    } else if (prev.doc.dirty && !s.doc.dirty) {
      lastWrittenRevision = null;
      void remove(s.doc.filePath);
    }
  });

  async function start() {
    let ms = deps.intervalMs;
    if (ms === undefined) {
      try {
        ms = (await bridge.testOverrides()).recoveryIntervalMs;
      } catch {
        /* nessuna sostituzione */
      }
    }
    if (disposed) return;
    timer = setInterval(() => void flush(), ms ?? RECOVERY_INTERVAL_MS);
  }
  void start();

  const formatDate = (iso: string) => {
    const locale = i18next.language.startsWith('it') ? 'it-IT' : 'en-GB';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'medium' }).format(d);
  };

  async function offerOne(entry: RecoveryEntry): Promise<void> {
    const { key, info } = entry;
    const yes = await bridge.askQuestion({
      title: t('recovery.title'),
      message: t('recovery.message', {
        name: info.projectName,
        date: formatDate(info.savedAt),
      }),
      yes: t('recovery.yes'),
      no: t('recovery.no'),
    });
    if (!yes) {
      await enqueue(() => bridge.recoveryDelete(key));
      return;
    }
    let project;
    try {
      project = readBaap(await bridge.recoveryRead(key));
    } catch (e) {
      const message =
        e instanceof BaapFormatError
          ? t(`errors.baap.${e.code}`)
          : t('errors.read', { path: info.originalPath, code: errorCode(e) });
      await bridge.showError(t('errors.title'), message);
      // Solo un contenuto non valido si elimina; un errore di I/O lascia la voce intatta.
      if (e instanceof BaapFormatError) await enqueue(() => bridge.recoveryDelete(key));
      return;
    }
    // La voce si cancella solo quando il contenuto è davvero aperto; se l'utente annulla resta.
    if (!(await service.openRecovered(project, info.originalPath))) return;
    store.getState().pushMessage({
      severity: 'info',
      textKey: 'messages.recovered',
      params: { name: project.meta.name },
    });
    // Il documento recuperato esiste solo in memoria: la voce resta (e viene sovrascritta con
    // lo stesso contenuto) finché la nuova copia non è scritta; se la scrittura fallisce resta intatta.
    await flushChecked();
  }

  async function offerRecovery(): Promise<void> {
    let entries: RecoveryEntry[];
    try {
      entries = await bridge.recoveryList();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (disposed) return;
      try {
        await offerOne(entry);
      } catch {
        /* una voce problematica non blocca le altre */
      }
    }
  }

  return {
    flush,
    offerRecovery,
    clear: remove,
    dispose() {
      disposed = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      unsubscribe();
    },
  };
}
