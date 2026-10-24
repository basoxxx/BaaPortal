import { useTranslation } from 'react-i18next';
import { useAppStore, useServices } from '../../state/AppContext';

/**
 * Barra dell'osservazione del programma, sopra i segmenti del blocco osservato: dice se i valori
 * sono attivi o perché non sono disponibili, e permette di scegliere esadecimale o decimale.
 */
export function MonitorBar({ deviceId, blockId }: { deviceId: string; blockId: string }) {
  const { t } = useTranslation();
  const { store } = useServices();
  const mon = useAppStore((s) =>
    s.sim.monitor?.blockId === blockId && s.sim.monitor.deviceId === deviceId
      ? s.sim.monitor
      : null,
  );
  const hex = useAppStore((s) => s.sim.monitorHex);
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
