import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../components/Dialog';
import { commands } from '../commands/commands';
import { eventDetails, formatEventTime } from '../online/diagFormat';
import {
  actionText,
  chooseRestore,
  executeRestore,
  outcomeText,
  type RestorePlan,
} from '../online/plcRestore';
import type { PlcRestoreResult, PlcWriteProgress } from '../online/plcTypes';
import { useAppStore, useServices } from '../state/AppContext';
import './restore.css';

/**
 * «Ripristina backup nel dispositivo (sperimentale)»: sceglie il file, mostra il piano che ha
 * preparato il processo principale (le conferme sono native, là), esegue e mostra l'esito per blocco.
 */
export function RestoreDialog({ onClose }: { onClose(): void }) {
  const { t, i18n } = useTranslation();
  const { bridge, store, service } = useServices();
  const lang = i18n.language.startsWith('en') ? 'en' : 'it';
  const online = useAppStore((s) => s.online.status === 'on');
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restart, setRestart] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<PlcWriteProgress | null>(null);
  const [result, setResult] = useState<PlcRestoreResult | null>(null);
  const busyRef = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // Il collegamento è caduto: la finestra non serve più (non durante il ripristino).
  useEffect(() => {
    if (!online && !busy) onClose();
  }, [online, busy]);

  const choose = async (): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const r = await chooseRestore(bridge);
    busyRef.current = false;
    if (!alive.current) return;
    setBusy(false);
    if (r.kind === 'plan') {
      setPlan(r.plan);
      setRestart(false);
    } else if (r.kind === 'error') setError(r.error);
  };

  const start = async (): Promise<void> => {
    if (busyRef.current || !plan) return;
    busyRef.current = true;
    setBusy(true);
    setProgress(null);
    setError(null);
    const off = bridge.onPlcWriteProgress((p) => alive.current && setProgress(p));
    let res: PlcRestoreResult;
    try {
      res = await executeRestore({ store, bridge }, plan.token, restart);
    } finally {
      off();
    }
    busyRef.current = false;
    if (!alive.current) return;
    setBusy(false);
    if (res.cancelled) {
      // «Annulla» in una conferma nativa: nessun messaggio; il piano è monouso, si sceglie di nuovo
      setPlan(null);
      return;
    }
    setResult(res);
  };

  const touched = result
    ? result.cpuStopped ||
      result.rows.some((r) => ['loaded', 'deleted', 'unknown'].includes(r.outcome))
    : false;
  const warnings = plan
    ? [
        t('restore.warnExperimental'),
        t('restore.warnStop'),
        ...(plan.cpuMismatch ? [t('restore.warnMismatch', plan.cpuMismatch)] : []),
        t('restore.warnData'),
        ...plan.warnings,
      ]
    : [];
  const finished = result !== null;

  return (
    <Dialog
      title={t('restore.title')}
      testId="restore-dialog"
      onClose={() => {
        if (!busy) onClose();
      }}
      onOk={() => void (plan && !finished ? start() : undefined)}
      okDisabled={busy || !plan || finished}
      footer={
        <>
          {!plan && !finished ? (
            <button
              type="button"
              data-testid="restore-choose"
              disabled={busy}
              onClick={() => void choose()}
            >
              {t('restore.chooseFile')}
            </button>
          ) : null}
          {plan && !finished ? (
            <button
              type="button"
              data-testid="restore-run"
              disabled={busy}
              onClick={() => void start()}
            >
              {t('restore.run')}
            </button>
          ) : null}
          <button type="button" data-testid="restore-close" disabled={busy} onClick={onClose}>
            {finished ? t('restore.close') : t('restore.cancel')}
          </button>
        </>
      }
    >
      <div className="baa-restore">
        {!plan && !finished ? <p>{t('restore.noFile')}</p> : null}
        {error ? (
          <div role="alert" data-testid="restore-error">
            <p>{error}</p>
            <p>{t('restore.noChange')}</p>
          </div>
        ) : null}
        {plan && !finished ? (
          <>
            <ul className="baa-restore-warnings" role="alert" data-testid="restore-warnings">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
            <label>
              <input
                type="checkbox"
                data-testid="restore-restart"
                checked={restart}
                disabled={busy}
                onChange={(e) => setRestart(e.target.checked)}
              />{' '}
              {t('restore.restart')}
            </label>
          </>
        ) : null}
        {plan || finished ? (
          <table className="baa-restore-table" data-testid="restore-table">
            <thead>
              <tr>
                <th>{t('restore.colBlock')}</th>
                <th>{finished ? t('restore.colOutcome') : t('restore.colAction')}</th>
              </tr>
            </thead>
            <tbody>
              {finished
                ? result.rows.map((r) => (
                    <tr key={r.name} data-outcome={r.outcome}>
                      <td>{r.name}</td>
                      <td>{outcomeText(r)}</td>
                    </tr>
                  ))
                : plan!.rows.map((r) => (
                    <tr key={r.name} data-action={r.action}>
                      <td>{r.name}</td>
                      <td>{actionText(r)}</td>
                    </tr>
                  ))}
            </tbody>
          </table>
        ) : null}
        {busy && plan ? (
          <div role="status" data-testid="restore-progress">
            <progress value={progress?.done ?? 0} max={progress?.total || 1} />{' '}
            {progress
              ? t('restore.progress', {
                  done: progress.done,
                  total: progress.total,
                  current: progress.current,
                })
              : t('restore.waiting')}
          </div>
        ) : null}
        {result ? (
          <div role={result.ok ? 'status' : 'alert'} data-testid="restore-result">
            <p>{result.ok ? t('restore.done') : t('restore.failed')}</p>
            {result.error ? <p>{result.error}</p> : null}
            {!touched ? <p>{t('restore.noChange')}</p> : null}
            {result.restarted ? <p>{t('restore.restarted')}</p> : null}
            {result.cpuStopped ? (
              <p>
                {t('restore.cpuStopped')}{' '}
                <button
                  type="button"
                  data-testid="restore-start-cpu"
                  onClick={() => void commands['online.startCpu'].run({ store, service, bridge })}
                >
                  {t('restore.startCpu')}
                </button>
              </p>
            ) : null}
            {result.diag?.length ? (
              <div data-testid="restore-diag">
                <p>{t('restore.diagTitle')}</p>
                <ul>
                  {result.diag.map((ev, i) => (
                    <li key={i}>
                      {formatEventTime(ev)} {eventDetails(ev, lang).text}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
