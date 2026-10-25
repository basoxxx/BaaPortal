import type { StoreApi } from 'zustand/vanilla';
import { findDevice } from '@baaportal/project';
import type { BaaBridge } from '../bridge';
import { t } from '../i18n';
import { contextHashOf, hashOf } from '../project/compile/compileActions';
import { prepareCompiledBlocks } from '../project/compile/downloadFiles';
import { getProgress } from '../project/progress';
import { downloadOrder } from '../sim/downloadOrder';
import type { AppState } from '../state/store';
import { compareBlocks, type CompareProjectBlock, type CompareState } from './compare';
import { plcControllerFor } from './plcController';
import type { PlcBlockRef, PlcIdentity } from './plcTypes';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface DownloadCtx {
  store: StoreApi<AppState>;
  bridge: BaaBridge;
}

/** Una riga dell'anteprima: un blocco del progetto o della CPU con lo stato del confronto. */
export interface DownloadRow {
  key: string;
  type: PlcBlockRef['type'];
  number: number;
  /** Id del blocco nel progetto; assente per i blocchi presenti solo nella CPU. */
  blockId?: string;
  state: CompareState;
  /** Compilato aggiornato (blocchi del progetto). */
  file?: Uint8Array;
}

/** Ciò che l'anteprima mostra, fissato al momento del confronto. */
export interface DownloadPlan {
  deviceId: string;
  /** Sessione del documento e del collegamento a cui il piano appartiene. */
  docLoadId: number;
  identity: PlcIdentity | undefined;
  rows: DownloadRow[];
  /** Impronta di ogni blocco del progetto al momento del confronto (per accorgersi di modifiche). */
  hashes: Record<string, string>;
}

export interface DownloadChoice {
  /** Chiavi delle righe da caricare. */
  load: ReadonlySet<string>;
  /** Chiavi delle righe solo-CPU da cancellare. */
  remove: ReadonlySet<string>;
  /** Arrestare la CPU prima del caricamento. */
  stop: boolean;
}

export interface DownloadOutcome {
  status: 'done' | 'failed' | 'cancelled' | 'stopFailed' | 'stale' | 'ended';
  loaded: string[];
  deleted: string[];
  failedAt?: string;
  error?: string;
}

const keyOf = (type: string, number: number) => `${type}${number}`;

/** Azione di partenza di una riga: caricare ciò che è diverso o nuovo, mai cancellare. */
export function defaultLoad(r: DownloadRow): boolean {
  if (r.blockId === undefined) return false;
  return r.state === 'different' || r.state === 'offlineOnly' || r.state === 'unreadable';
}

/** Il blocco esiste solo nella CPU (si può solo cancellare). */
export const isCpuOnly = (r: DownloadRow) => r.blockId === undefined;

/**
 * L'avviso «CPU in RUN»: il caricamento contiene un OB, o un FB/DB diverso da quello della CPU.
 * L'impronta d'interfaccia della CPU non è nota: «diverso» è un'approssimazione per eccesso del
 * «cambia l'interfaccia».
 */
export function runWarning(
  rows: readonly DownloadRow[],
  load: ReadonlySet<string>,
  mode: string | undefined,
): boolean {
  if (mode !== 'RUN') return false;
  return rows.some(
    (r) =>
      load.has(r.key) &&
      (r.type === 'OB' || ((r.type === 'FB' || r.type === 'DB') && r.state === 'different')),
  );
}

/** Le righe nell'ordine di caricamento (DB e istanze, FC, FB, OB), poi quelle solo della CPU. */
export function orderedRows(rows: readonly DownloadRow[]): DownloadRow[] {
  return downloadOrder(rows.map((r) => ({ ...r, kind: r.type })));
}

function push(
  store: StoreApi<AppState>,
  severity: 'info' | 'warning' | 'error',
  key: string,
  params?: Record<string, string>,
): void {
  store.getState().pushMessage({
    severity,
    textKey: `messages.${key}`,
    ...(params ? { params } : {}),
  });
}

/** Il documento e il collegamento sono ancora quelli del piano. */
function sameSession(store: StoreApi<AppState>, plan: DownloadPlan): boolean {
  const s = store.getState();
  return (
    s.docLoadId === plan.docLoadId &&
    s.online.status === 'on' &&
    s.online.deviceId === plan.deviceId &&
    s.online.identity === plan.identity
  );
}

/** Libera il blocco «caricamento in corso» (alla chiusura dell'anteprima). */
export function releaseDownload(store: StoreApi<AppState>, plan: DownloadPlan): void {
  if (sameSession(store, plan)) store.getState().patchOnline({ downloading: false });
}

/**
 * «Carica nel dispositivo» sul PLC vero, prima parte: compila, controlla che i compilati siano
 * attuali (un blocco non attuale ferma tutto), confronta con la CPU e apre l'anteprima. Con
 * `blockIds` (blocchi scelti nell'albero) l'anteprima ha solo quelle righe.
 */
export async function preparePlcDownload(ctx: DownloadCtx, blockIds?: string[]): Promise<void> {
  const { store, bridge } = ctx;
  const st = store.getState();
  const { status, deviceId, comparing, downloading, identity } = st.online;
  if (status !== 'on' || !deviceId || comparing || downloading || getProgress()) return;
  const load = st.docLoadId;
  const live = () => {
    const s = store.getState();
    return (
      s.docLoadId === load &&
      s.online.status === 'on' &&
      s.online.deviceId === deviceId &&
      s.online.identity === identity
    );
  };
  st.patchOnline({ downloading: true });
  let opened = false;
  try {
    const prep = await prepareCompiledBlocks(ctx, deviceId, live, blockIds);
    if (!live() || prep.status === 'aborted') return;
    if (prep.status === 'errors') {
      push(store, 'error', 'simDownloadBlocked', { errors: String(prep.errors) });
      return;
    }
    if (prep.status === 'stale') {
      push(store, 'error', 'simDownloadStale', { count: String(prep.count) });
      return;
    }
    let res: Awaited<ReturnType<BaaBridge['plcBlocks']>>;
    try {
      res = await bridge.plcBlocks();
    } catch (e) {
      res = { ok: false, error: errorText(e) };
    }
    if (!live()) return;
    if (!res.ok) {
      push(store, 'error', 'plcCompareFailed', { message: res.error });
      return;
    }
    const project: CompareProjectBlock[] = prep.blocks.map((b) => ({
      id: b.id,
      type: b.kind === 'IDB' ? 'DB' : b.kind,
      number: b.number,
      file: b.file,
    }));
    const files = new Map(prep.blocks.map((b) => [b.id, b.file]));
    const hashes: Record<string, string> = {};
    for (const b of prep.dev.blocks) hashes[b.id] = hashOf(b, prep.context);
    const rows: DownloadRow[] = compareBlocks(project, res.blocks)
      // Con una scelta di blocchi, quelli solo nella CPU non c'entrano.
      .filter((r) => !blockIds || (r.blockId !== undefined && blockIds.includes(r.blockId)))
      .map((r) => ({
        key: keyOf(r.type, r.number),
        type: r.type as PlcBlockRef['type'],
        number: r.number,
        state: r.state,
        ...(r.blockId !== undefined ? { blockId: r.blockId, file: files.get(r.blockId)! } : {}),
      }));
    const plan: DownloadPlan = {
      deviceId,
      docLoadId: load,
      identity,
      rows: orderedRows(rows),
      hashes,
    };
    store.getState().openDialog({ kind: 'download', plan });
    opened = true;
  } finally {
    // Aperta l'anteprima, il blocco lo toglie lei alla chiusura.
    if (!opened && live()) store.getState().patchOnline({ downloading: false });
  }
}

/**
 * Seconda parte, dopo «Carica» nell'anteprima: eventuale STOP, scrittura (ognuna con la sua conferma
 * nativa nel processo principale), domanda «Avviare la CPU?» e nuovo confronto. Se nel frattempo il
 * progetto o il collegamento sono cambiati, lo stato non si tocca più.
 */
export async function executePlcDownload(
  ctx: DownloadCtx,
  plan: DownloadPlan,
  choice: DownloadChoice,
): Promise<DownloadOutcome> {
  const { store, bridge } = ctx;
  const none = { loaded: [], deleted: [] };
  // Dopo l'anteprima il progetto può essere cambiato: ciò che si carica deve essere ciò che si è visto.
  const doc = store.getState().doc;
  const dev = doc && findDevice(doc.project, plan.deviceId);
  const rows = plan.rows.filter((r) =>
    isCpuOnly(r) ? choice.remove.has(r.key) : choice.load.has(r.key),
  );
  const context = dev && contextHashOf(dev);
  const changed =
    !dev ||
    !sameSession(store, plan) ||
    rows.some((r) => {
      if (isCpuOnly(r)) return false;
      const b = dev.blocks.find((x) => x.id === r.blockId);
      return !b || hashOf(b, context!) !== plan.hashes[r.blockId!];
    });
  if (changed) {
    if (sameSession(store, plan)) push(store, 'error', 'plcDownloadChanged');
    return { status: 'stale', ...none };
  }
  const loadRows = rows.filter((r) => !isCpuOnly(r));
  const deleteBlocks: PlcBlockRef[] = rows
    .filter(isCpuOnly)
    .map((r) => ({ type: r.type, number: r.number }));
  const files = loadRows.map((r) => r.file!);
  const wasMode = store.getState().online.mode;
  let stopped = false;
  if (choice.stop) {
    let stop: Awaited<ReturnType<BaaBridge['plcControl']>>;
    try {
      stop = await bridge.plcControl('STOP');
    } catch (e) {
      stop = { ok: false, error: errorText(e) };
    }
    if (!stop.ok) {
      if ('cancelled' in stop) {
        if (sameSession(store, plan)) push(store, 'warning', 'plcDownloadCancelled');
        return { status: 'cancelled', ...none };
      }
      if (sameSession(store, plan)) push(store, 'error', 'plcStopFailed', { message: stop.error });
      return { status: 'stopFailed', ...none, error: stop.error };
    }
    stopped = true;
  }
  let res: Awaited<ReturnType<BaaBridge['plcDownload']>>;
  try {
    res = await bridge.plcDownload(files, { deleteBlocks });
  } catch (e) {
    res = { ok: false, loaded: [], deleted: [], error: errorText(e) };
  }
  const live = sameSession(store, plan);
  if (!res.ok && 'cancelled' in res) {
    if (live) push(store, 'warning', 'plcDownloadCancelled');
    return { status: 'cancelled', ...none };
  }
  const outcome: DownloadOutcome = res.ok
    ? { status: 'done', loaded: res.loaded, deleted: res.deleted }
    : {
        status: 'failed',
        loaded: res.loaded,
        deleted: res.deleted,
        error: res.error,
        ...(res.failedAt ? { failedAt: res.failedAt } : {}),
      };
  if (!live) return { ...outcome, status: outcome.status === 'done' ? 'ended' : outcome.status };
  if (res.ok) {
    push(store, 'info', 'plcDownloaded', {
      loaded: String(res.loaded.length),
      deleted: String(res.deleted.length),
    });
  } else {
    push(store, 'error', 'plcDownloadFailed', {
      message: res.error,
      loaded: res.loaded.join(', ') || '-',
      failedAt: res.failedAt ?? '-',
    });
  }
  const something = res.loaded.length > 0 || res.deleted.length > 0;
  // Se la CPU gira ancora (nessun arresto), non c'è nulla da avviare.
  if (res.ok && res.loaded.length > 0 && (stopped || wasMode !== 'RUN')) {
    let yes = false;
    try {
      yes = await bridge.askQuestion({
        title: t('sim.startCpuTitle'),
        message: t('sim.startCpuMessage'),
        yes: t('sim.yes'),
        no: t('sim.no'),
      });
    } catch {
      yes = false;
    }
    if (yes && sameSession(store, plan)) {
      let run: Awaited<ReturnType<BaaBridge['plcControl']>>;
      try {
        run = await bridge.plcControl('RUN');
      } catch (e) {
        run = { ok: false, error: errorText(e) };
      }
      if (!run.ok && !('cancelled' in run) && sameSession(store, plan)) {
        push(store, 'error', 'plcRunFailed', { message: run.error });
      }
    }
  }
  if (something && sameSession(store, plan)) {
    await plcControllerFor(store, bridge).compare(true);
  }
  return outcome;
}
