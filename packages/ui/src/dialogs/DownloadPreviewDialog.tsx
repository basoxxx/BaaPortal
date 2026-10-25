import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../components/Dialog';
import {
  defaultLoad,
  executePlcDownload,
  isCpuOnly,
  releaseDownload,
  runWarning,
  type DownloadOutcome,
  type DownloadPlan,
  type DownloadRow,
} from '../online/plcDownload';
import type { PlcWriteProgress } from '../online/plcTypes';
import { useAppStore, useServices } from '../state/AppContext';
import './settingsDialog.css';

/**
 * «Carica nel dispositivo» con la CPU vera: una riga per blocco con lo stato del confronto e
 * l'azione (Carica / Nessuna azione / Cancella). «Carica» esegue; l'avanzamento e l'esito
 * (caricati, cancellati, fallito) restano in questa finestra.
 */
export function DownloadPreviewDialog({ plan, onClose }: { plan: DownloadPlan; onClose(): void }) {
  const { t } = useTranslation();
  const { bridge, store } = useServices();
  const mode = useAppStore((s) => s.online.mode);
  const docLoadId = useAppStore((s) => s.docLoadId);
  const online = useAppStore(
    (s) => s.online.status === 'on' && s.online.identity === plan.identity,
  );
  // Chiavi delle righe con l'azione attiva (Carica, o Cancella per le righe solo della CPU).
  const [active, setActive] = useState<ReadonlySet<string>>(
    () => new Set(plan.rows.filter(defaultLoad).map((r) => r.key)),
  );
  const [stop, setStop] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<PlcWriteProgress | null>(null);
  const [outcome, setOutcome] = useState<DownloadOutcome | null>(null);
  const runningRef = useRef(false);
  runningRef.current = running;

  // Il progetto o il collegamento sono cambiati: l'anteprima non vale più (non durante la scrittura).
  const gone = docLoadId !== plan.docLoadId || !online;
  useEffect(() => {
    if (gone && !running && !outcome) onClose();
  }, [gone, running, outcome]);
  useEffect(() => () => releaseDownload(store, plan), []);

  const loads = new Set(
    plan.rows.filter((r) => !isCpuOnly(r) && active.has(r.key)).map((r) => r.key),
  );
  const nothing = active.size === 0;
  const warn = runWarning(plan.rows, active, mode);
  const toggle = (key: string) =>
    setActive((a) => {
      const next = new Set(a);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const start = async (): Promise<void> => {
    if (runningRef.current || outcome || nothing) return;
    runningRef.current = true;
    setRunning(true);
    setProgress(null);
    const off = bridge.onPlcWriteProgress((p) => setProgress(p));
    let result: DownloadOutcome;
    try {
      result = await executePlcDownload({ store, bridge }, plan, {
        load: loads,
        remove: new Set(
          plan.rows.filter((r) => isCpuOnly(r) && active.has(r.key)).map((r) => r.key),
        ),
        stop: warn && stop,
      });
    } finally {
      off();
    }
    runningRef.current = false;
    setRunning(false);
    setOutcome(result);
  };

  const stateText = (r: DownloadRow): string => {
    const s = isCpuOnly(r) && r.state === 'unreadable' ? 'onlineOnly' : r.state;
    return t(`compare.${s}`);
  };
  const actionText = (r: DownloadRow): string =>
    active.has(r.key) ? t(isCpuOnly(r) ? 'download.delete' : 'download.load') : t('download.none');

  const finished = outcome !== null;
  return (
    <Dialog
      title={t('download.title')}
      testId="download-preview"
      onClose={() => {
        if (!running) onClose();
      }}
      onOk={() => void start()}
      okDisabled={running || finished || nothing}
      footer={
        <>
          {finished ? null : (
            <button
              type="button"
              data-testid="download-ok"
              disabled={running || nothing}
              onClick={() => void start()}
            >
              {t('download.run')}
            </button>
          )}
          <button type="button" data-testid="download-cancel" disabled={running} onClick={onClose}>
            {finished ? t('download.close') : t('dialog.cancel')}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
        {plan.rows.length === 0 ? <p>{t('download.empty')}</p> : null}
        {plan.rows.length > 0 ? (
          <table className="baa-access-table">
            <thead>
              <tr>
                <th>{t('download.colBlock')}</th>
                <th>{t('download.colState')}</th>
                <th>{t('download.colAction')}</th>
              </tr>
            </thead>
            <tbody>
              {plan.rows.map((r) => (
                <tr key={r.key} data-state={r.state}>
                  <td>{r.key}</td>
                  <td>
                    {stateText(r)}
                    {r.state === 'unreadable' && !isCpuOnly(r)
                      ? ` - ${t('download.unreadableNote')}`
                      : ''}
                  </td>
                  <td>
                    <label>
                      <input
                        type="checkbox"
                        aria-label={r.key}
                        checked={active.has(r.key)}
                        disabled={running || finished || r.state === 'notCompiled'}
                        onChange={() => toggle(r.key)}
                      />{' '}
                      {actionText(r)}
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {warn && !finished ? (
          <div role="alert" data-testid="download-run-warning">
            <p>{t('download.runWarning')}</p>
            <label>
              <input
                type="checkbox"
                checked={stop}
                disabled={running}
                onChange={(e) => setStop(e.target.checked)}
              />{' '}
              {t('download.stopCpu')}
            </label>
          </div>
        ) : null}
        {running ? (
          <div role="status" data-testid="download-progress">
            <progress value={progress?.done ?? 0} max={progress?.total || 1} />{' '}
            {progress
              ? t('download.progress', {
                  done: progress.done,
                  total: progress.total,
                  current: progress.current,
                })
              : t('download.waiting')}
          </div>
        ) : null}
        {outcome ? (
          <div role={outcome.status === 'done' ? 'status' : 'alert'} data-testid="download-result">
            <p>{t(`download.result.${outcome.status}`)}</p>
            {outcome.error ? <p>{outcome.error}</p> : null}
            {outcome.loaded.length > 0 ? (
              <p>{t('download.loaded', { list: outcome.loaded.join(', ') })}</p>
            ) : null}
            {outcome.deleted.length > 0 ? (
              <p>{t('download.deleted', { list: outcome.deleted.join(', ') })}</p>
            ) : null}
            {outcome.cpuStopped ? <p>{t('download.cpuStopped')}</p> : null}
            {outcome.failedAt ? <p>{t('download.failedAt', { block: outcome.failedAt })}</p> : null}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
