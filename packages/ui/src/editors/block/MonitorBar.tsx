import { useTranslation } from 'react-i18next';
import { plcControllerFor } from '../../online/plcController';
import { plcMonitorFor } from '../../online/plcMonitor';
import { useAppStore, useServices } from '../../state/AppContext';

const NO_REGS = { accu2: false, ar1: false };

/**
 * Barra dell'osservazione del programma, sopra i segmenti del blocco osservato: dice se i valori
 * sono attivi o perché non sono disponibili, e permette di scegliere esadecimale o decimale.
 */
export function MonitorBar({ deviceId, blockId }: { deviceId: string; blockId: string }) {
  const { t } = useTranslation();
  const { store, bridge } = useServices();
  const plc = useAppStore((s) =>
    s.online.monitor?.blockId === blockId && s.online.monitor.deviceId === deviceId
      ? s.online.monitor
      : null,
  );
  const regs = useAppStore((s) => s.online.monitorRegs ?? NO_REGS);
  const mon = useAppStore((s) =>
    s.sim.monitor?.blockId === blockId && s.sim.monitor.deviceId === deviceId
      ? s.sim.monitor
      : null,
  );
  const hex = useAppStore((s) => s.sim.monitorHex);
  if (plc) {
    const ok = plc.reason === 'ok';
    const text = ok
      ? plc.limit !== undefined
        ? t('plcMonitor.firstN', { n: plc.limit })
        : t('plcMonitor.on')
      : (plc.message ?? t(`plcMonitor.reason.${plc.reason}`));
    return (
      <div
        className={`baa-monitor-bar${ok ? '' : ' is-unavailable'}`}
        role={ok ? 'status' : 'alert'}
        aria-label={t('plcMonitor.title')}
        data-testid="monitor-bar"
      >
        <span className="baa-monitor-msg">{text}</span>
        {plc.reason === 'different' ? (
          <button
            type="button"
            className="baa-panel-btn"
            onClick={() => void plcControllerFor(store, bridge).compare()}
          >
            {t('plcMonitor.compare')}
          </button>
        ) : null}
        {(['accu2', 'ar1'] as const).map((k) => (
          <label key={k}>
            <input
              type="checkbox"
              checked={regs[k]}
              onChange={(e) =>
                plcMonitorFor(store, bridge).setRegs({ ...regs, [k]: e.target.checked })
              }
            />
            {t(`plcMonitor.${k}`)}
          </label>
        ))}
        <button
          type="button"
          className="baa-panel-btn"
          aria-pressed={hex}
          aria-label={t('sim.monitor.format')}
          title={t('sim.monitor.format')}
          onClick={() => store.getState().setSim({ monitorHex: !hex })}
        >
          {t(hex ? 'sim.monitor.hex' : 'sim.monitor.dec')}
        </button>
      </div>
    );
  }
  if (!mon) return null;
  const reason = mon.edited ? 'edited' : mon.reason;
  const ok = reason === 'ok';
  return (
    <div
      className={`baa-monitor-bar${ok ? '' : ' is-unavailable'}`}
      role={ok ? 'status' : 'alert'}
      aria-label={t('sim.monitor.title')}
      data-testid="monitor-bar"
    >
      <span className="baa-monitor-msg">
        {t(ok ? 'sim.monitor.on' : `sim.monitor.reason.${reason}`)}
      </span>
      <button
        type="button"
        className="baa-panel-btn"
        aria-pressed={hex}
        aria-label={t('sim.monitor.format')}
        title={t('sim.monitor.format')}
        onClick={() => store.getState().setSim({ monitorHex: !hex })}
      >
        {t(hex ? 'sim.monitor.hex' : 'sim.monitor.dec')}
      </button>
    </div>
  );
}
