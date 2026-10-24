import { useTranslation } from 'react-i18next';
import type { DiagCode, DiagEntry } from '@baaportal/sim';
import { useAppStore, useServices } from '../../state/AppContext';
import { simControllerFor } from '../../sim/simController';

/** Codici di diagnostica che non sono errori: informazioni, richieste e avvisi «non simulata». */
const NOT_ERRORS: ReadonlySet<DiagCode> = new Set<DiagCode>([
  'STOP_RICHIESTO',
  'AVVIO',
  'CANCELLAZIONE_TOTALE',
  'OB_RICHIAMATO',
  'SFC_NON_SIMULATA',
  'SFB_NON_SIMULATA',
]);

/** La voce di diagnostica è un errore della CPU (DiagEntry non porta una gravità: la si ricava dal codice). */
export const isDiagError = (d: DiagEntry): boolean => !NOT_ERRORS.has(d.code);

const hex = (n: number, w: number) => `16#${n.toString(16).toUpperCase().padStart(w, '0')}`;

export function CpuPanel() {
  const { t } = useTranslation();
  const { store, bridge } = useServices();
  const sim = useAppStore((s) => s.sim);
  if (sim.phase !== 'on') return <p className="baa-placeholder">{t('cpuPanel.needSim')}</p>;

  const ctrl = simControllerFor(store);
  const stopped = sim.mode === 'STOP';
  const last = sim.diagnostics[sim.diagnostics.length - 1];
  const sf = !!last && isDiagError(last);
  const ms = (v: number | undefined) => t('cpuPanel.ms', { value: v ?? 0 });

  return (
    <div className="baa-cpu-panel">
      <div className="baa-cpu-leds">
        <span data-testid="led-run" data-on={sim.mode === 'RUN'} className="baa-led baa-led-run">
          {t('cpuPanel.run')}
        </span>
        <span data-testid="led-stop" data-on={stopped} className="baa-led baa-led-stop">
          {t('cpuPanel.stop')}
        </span>
        <span data-testid="led-sf" data-on={sf} className="baa-led baa-led-sf">
          {t('cpuPanel.sf')}
        </span>
      </div>
      <div className="baa-cpu-buttons">
        <button
          type="button"
          disabled={!stopped}
          onClick={() => void ctrl.setMode('RUN')}
          data-testid="cpu-run"
        >
          {t('cpuPanel.runBtn')}
        </button>
        <button
          type="button"
          disabled={stopped}
          onClick={() => void ctrl.setMode('STOP')}
          data-testid="cpu-stop"
        >
          {t('cpuPanel.stopBtn')}
        </button>
        <button
          type="button"
          disabled={!stopped}
          onClick={() => void ctrl.memoryReset({ store, bridge })}
          data-testid="cpu-mres"
        >
          {t('cpuPanel.mres')}
        </button>
      </div>
      <dl className="baa-cpu-cycle" data-testid="cpu-cycle">
        <dt>{t('cpuPanel.last')}</dt>
        <dd>{ms(sim.stats?.last)}</dd>
        <dt>{t('cpuPanel.min')}</dt>
        <dd>{ms(sim.stats?.min)}</dd>
        <dt>{t('cpuPanel.max')}</dt>
        <dd>{ms(sim.stats?.max)}</dd>
      </dl>
      <h4>{t('cpuPanel.warnings')}</h4>
      {sim.warnings.length === 0 ? (
        <p className="baa-placeholder">{t('cpuPanel.noWarnings')}</p>
      ) : (
        <ul data-testid="cpu-warnings">
          {sim.warnings.map((w, i) => (
            <li key={i}>
              {t(`cpuPanel.code.${w.code}`)}: {w.block}
            </li>
          ))}
        </ul>
      )}
      <h4>{t('cpuPanel.diagnostics')}</h4>
      {sim.diagnostics.length === 0 ? (
        <p className="baa-placeholder">{t('cpuPanel.diagEmpty')}</p>
      ) : (
        <ol className="baa-cpu-diag" data-testid="cpu-diag" reversed>
          {[...sim.diagnostics].reverse().map((d, i) => (
            <li key={i} data-error={isDiagError(d)}>
              <span>{(d.time / 1000).toFixed(3)} s</span> <span>{hex(d.eventId, 4)}</span>{' '}
              <span>{t(`cpuPanel.code.${d.code}`)}</span>
              {d.block ? <span> {t('cpuPanel.inBlock', { block: d.block })}</span> : null}
              {d.network !== undefined ? (
                <span>, {t('cpuPanel.network', { network: d.network })}</span>
              ) : null}
              {d.offset !== undefined ? (
                <span>, {t('cpuPanel.offset', { offset: d.offset })}</span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
