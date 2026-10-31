import type { StoreApi } from 'zustand/vanilla';
import type { BaaBridge } from '../bridge';
import { t } from '../i18n';
import { beginProgress } from '../project/progress';
import type { AppState } from '../state/store';
import { plcControllerFor } from './plcController';
import type {
  PlcRestorePlanResult,
  PlcRestoreResult,
  RestoreOutcomeRow,
  RestoreRow,
} from './plcTypes';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface RestoreCtx {
  store: StoreApi<AppState>;
  bridge: BaaBridge;
}

export type RestorePlan = Extract<PlcRestorePlanResult, { ok: true }>;

export type ChooseResult =
  { kind: 'plan'; plan: RestorePlan } | { kind: 'cancelled' } | { kind: 'error'; error: string };

/** Motivi che il main scrive in italiano e che hanno un testo tradotto. */
const WHY: Record<string, string> = {
  'creato dalla CPU': 'restore.why.cpuCreated',
  'fuori dagli intervalli documentati: lasciato sulla CPU': 'restore.why.outOfRange',
};

/** «Scegli file…»: la finestra di apertura e il piano stanno nel processo principale. */
export async function chooseRestore(bridge: BaaBridge): Promise<ChooseResult> {
  let res: PlcRestorePlanResult;
  try {
    res = await bridge.plcRestorePlan();
  } catch (e) {
    res = { ok: false, error: errorText(e) };
  }
  if (res.ok) return { kind: 'plan', plan: res };
  if ('cancelled' in res) return { kind: 'cancelled' };
  return { kind: 'error', error: res.error };
}

export function actionText(r: RestoreRow): string {
  switch (r.action) {
    case 'load':
      return t('restore.action.load');
    case 'delete':
      return t('restore.action.delete');
    case 'keep':
      return t('restore.action.keep');
    case 'skip': {
      const key = r.why ? WHY[r.why] : undefined;
      const why = r.why ? (key ? t(key) : r.why) : '';
      return why ? t('restore.action.skipWhy', { why }) : t('restore.action.skip');
    }
  }
}

export function outcomeText(r: RestoreOutcomeRow): string {
  switch (r.outcome) {
    case 'loaded':
      return t('restore.outcome.loaded');
    case 'deleted':
      return t('restore.outcome.deleted');
    case 'skipped':
      return t('restore.outcome.skipped');
    case 'kept':
      return t('restore.outcome.kept');
    case 'unknown':
      // il motivo specifico (per esempio «il blocco non risulta nella CPU») vale più del testo generico
      return r.error && r.error !== 'Esito sconosciuto' ? r.error : t('restore.outcome.unknown');
    case 'notDone':
      return t('restore.outcome.notDone');
    case 'rejected': {
      // un rifiuto del nostro filtro il main lo scrive già per intero
      if ((r.error ?? '').startsWith('Rifiutato da BaaPortal'))
        return t('restore.outcome.filtered');
      // il main scrive «Rifiutato dalla CPU: …»; qui si tiene solo il dettaglio
      const detail = (r.error ?? '').replace(/^Rifiutato dalla CPU:\s*/, '');
      return t('restore.outcome.rejected', { detail });
    }
  }
}

/** La CPU è stata toccata (o lo si ignora): i blocchi online vanno riletti. */
export const touchedCpu = (res: PlcRestoreResult): boolean =>
  res.cpuStopped ||
  res.stopUnconfirmed === true ||
  res.rows.some(
    (r) => r.outcome === 'loaded' || r.outcome === 'deleted' || r.outcome === 'unknown',
  );

/**
 * «Ripristina»: le conferme sono native, nel main. Durante il ripristino l'avanzamento sta nella
 * barra di stato con Interrompi (si ferma prima del passo successivo). Alla fine, se la CPU è
 * stata toccata, si rilancia il confronto online del 3B.
 */
export async function executeRestore(
  ctx: RestoreCtx,
  token: string,
  restart: boolean,
): Promise<PlcRestoreResult> {
  const { store, bridge } = ctx;
  const identity = store.getState().online.identity;
  store.getState().patchOnline({ restoring: true });
  const bar = beginProgress('status.restore', () => void bridge.plcRestoreInterrupt());
  const off = bridge.onPlcWriteProgress((p) => bar.update(p.done, p.total));
  let res: PlcRestoreResult;
  try {
    res = await bridge.plcRestore({ token, restart });
  } catch (e) {
    res = { ok: false, error: errorText(e), rows: [], cpuStopped: false };
  } finally {
    off();
    bar.end();
  }
  const s = store.getState();
  const same = s.online.status === 'on' && s.online.identity === identity;
  if (same) s.patchOnline({ restoring: false });
  if (same && touchedCpu(res)) await plcControllerFor(store, bridge).compare(false);
  return res;
}
