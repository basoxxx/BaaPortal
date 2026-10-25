import { useTranslation } from 'react-i18next';
import { useAppStore } from '../state/AppContext';
import { useProgress } from './progress';

/** Barra di stato: durante un'operazione lunga avanzamento e Interrompi, altrimenti l'ultimo messaggio. */
export function StatusBar() {
  const { t } = useTranslation();
  const status = useAppStore((s) => s.status);
  const progress = useProgress();
  const sim = useAppStore((s) => s.sim);
  const online = useAppStore((s) => s.online);
  return (
    <div data-testid="status-bar" className="baa-status-bar" role="status">
      {sim.phase !== 'off' ? (
        <span data-testid="sim-indicator" className="baa-status-sim" data-mode={sim.mode}>
          {sim.phase === 'starting'
            ? t('status.simulationStarting')
            : t('status.simulation', { mode: sim.mode })}
        </span>
      ) : null}
      {online.status !== 'off' ? (
        <span data-testid="plc-indicator" className="baa-status-sim" data-mode={online.mode}>
          {online.status === 'connecting'
            ? t('status.onlineConnecting')
            : t('status.online', {
                module: online.identity?.moduleName ?? online.identity?.orderNumber ?? '',
                host: online.access?.host ?? '',
                mode: online.mode ?? 'UNKNOWN',
              })}
        </span>
      ) : null}
      {progress ? (
        <span className="baa-status-progress">
          <span>{t(progress.labelKey)}</span>
          <progress
            data-testid="status-progress"
            aria-label={t('status.progress')}
            value={progress.done}
            max={Math.max(progress.total, 1)}
          />
          <span>
            {progress.done}/{progress.total}
          </span>
          {progress.cancel ? (
            <button type="button" className="baa-panel-btn" onClick={progress.cancel}>
              {t('status.cancel')}
            </button>
          ) : null}
        </span>
      ) : status ? (
        t(status.textKey, status.params)
      ) : (
        ''
      )}
    </div>
  );
}
