import { useTranslation } from 'react-i18next';
import { isDiagError } from '@baaportal/sim';
import { useAppStore, useServices } from '../../state/AppContext';
import { commands } from '../../commands/commands';
import { simControllerFor } from '../../sim/simController';

// La classificazione degli errori sta in @baaportal/sim: il pannello e la SZL dei LED (SF) la condividono.
export { isDiagError };

const hex = (n: number, w: number) => `16#${n.toString(16).toUpperCase().padStart(w, '0')}`;

export function CpuPanel() {
  const { t } = useTranslation();
  const { store, bridge } = useServices();
  const sim = useAppStore((s) => s.sim);
  const online = useAppStore((s) => s.online);
  if (online.status === 'on') return <OnlineCpuPanel />;
  if (sim.phase !== 'on') return <p className="baa-placeholder">{t('cpuPanel.needSim')}</p>;

  const ctrl = simControllerFor(store);
  const stopped = sim.mode === 'STOP';
  const last = sim.diagnostics[sim.diagnostics.length - 1];
  const sf = !!last && isDiagError(last);
  const ledLabel = (k: 'run' | 'stop' | 'sf', on: boolean) =>
    `${t(`cpuPanel.${k}`)}: ${t(on ? 'cpuPanel.ledOn' : 'cpuPanel.ledOff')}`;
  const ms = (v: number | undefined) => t('cpuPanel.ms', { value: v ?? 0 });

  return (
    <div className="baa-cpu-panel">
      <div className="baa-cpu-leds" role="status">
        <span
          data-testid="led-run"
          data-on={sim.mode === 'RUN'}
          aria-label={ledLabel('run', sim.mode === 'RUN')}
          className="baa-led baa-led-run"
        >
          {t('cpuPanel.run')}
        </span>
        <span
          data-testid="led-stop"
          data-on={stopped}
          aria-label={ledLabel('stop', stopped)}
          className="baa-led baa-led-stop"
        >
          {t('cpuPanel.stop')}
        </span>
        <span
          data-testid="led-sf"
          data-on={sf}
          aria-label={ledLabel('sf', sf)}
          className="baa-led baa-led-sf"
        >
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

const CPU_BUTTONS = [
  ['cpu-run', 'online.startCpu', 'cpuPanel.runBtn'],
  ['cpu-stop', 'online.stopCpu', 'cpuPanel.stopBtn'],
  ['cpu-copy-ram-rom', 'online.copyRamToRom', 'cpuPanel.copyRamToRomBtn'],
  ['cpu-compress', 'online.compress', 'cpuPanel.compressBtn'],
] as const;

/** Pannello della CPU vera: LED, identità e comandi (RUN, STOP, copia RAM in ROM, comprimi). */
function OnlineCpuPanel() {
  const { t } = useTranslation();
  const { store, bridge, service } = useServices();
  const online = useAppStore((s) => s.online);
  // Solo l'abilitazione dei comandi (una stringa), non tutto lo stato: il pannello non si ridisegna a ogni modifica.
  const enabled = useAppStore((s) =>
    CPU_BUTTONS.map(([, cmd]) => (commands[cmd].isEnabled(s) ? '1' : '0')).join(''),
  );
  const mode = online.mode ?? 'UNKNOWN';
  const id = online.identity;
  const ledLabel = (k: 'run' | 'stop', on: boolean) =>
    `${t(`cpuPanel.${k}`)}: ${t(on ? 'cpuPanel.ledOn' : 'cpuPanel.ledOff')}`;
  return (
    <div className="baa-cpu-panel" data-testid="cpu-panel-online">
      <div className="baa-cpu-leds" role="status">
        <span
          data-testid="led-run"
          data-on={mode === 'RUN'}
          aria-label={ledLabel('run', mode === 'RUN')}
          className="baa-led baa-led-run"
        >
          {t('cpuPanel.run')}
        </span>
        <span
          data-testid="led-stop"
          data-on={mode === 'STOP'}
          aria-label={ledLabel('stop', mode === 'STOP')}
          className="baa-led baa-led-stop"
        >
          {t('cpuPanel.stop')}
        </span>
      </div>
      <div className="baa-cpu-buttons">
        {CPU_BUTTONS.map(([testId, cmd, label], i) => (
          <button
            key={testId}
            type="button"
            disabled={enabled[i] !== '1'}
            onClick={() => void commands[cmd].run({ store, service, bridge })}
            data-testid={testId}
          >
            {t(label)}
          </button>
        ))}
        <button type="button" disabled data-testid="cpu-mres" title={t('cpuPanel.mresHint')}>
          {t('cpuPanel.mres')}
        </button>
      </div>
      <dl data-testid="cpu-identity">
        <dt>{t('cpuPanel.mode')}</dt>
        <dd>{mode}</dd>
        <dt>{t('cpuPanel.module')}</dt>
        <dd>{id?.moduleName ?? ''}</dd>
        <dt>{t('cpuPanel.orderNumber')}</dt>
        <dd>{id?.orderNumber ?? ''}</dd>
        {id?.firmware ? (
          <>
            <dt>{t('cpuPanel.firmware')}</dt>
            <dd>{id.firmware}</dd>
          </>
        ) : null}
      </dl>
      <h4>{t('cpuPanel.cycle')}</h4>
      <p className="baa-placeholder">{t('cpuPanel.unavailableReadOnly')}</p>
      <h4>{t('cpuPanel.diagnostics')}</h4>
      <p className="baa-placeholder">{t('cpuPanel.unavailableReadOnly')}</p>
    </div>
  );
}
