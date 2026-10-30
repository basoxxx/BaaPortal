import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PlcHmiStuckEntry } from '../../online/plcTypes';
import { useServices } from '../../state/AppContext';
import './hmi.css';

/**
 * Avviso in evidenza degli impulsi HMI il cui 0 automatico non è riuscito, anche in una sessione
 * precedente (l'elenco sta nel processo principale). Resta finché l'utente non lo dà per visto.
 */
export function HmiStuckNotice() {
  const { t, i18n } = useTranslation();
  const { bridge } = useServices();
  const [list, setList] = useState<PlcHmiStuckEntry[]>([]);
  useEffect(() => {
    let live = true;
    const off = bridge.onPlcHmiStuck((l) => setList(l));
    void bridge.plcHmiStuck().then(
      (l) => live && setList(l),
      () => undefined,
    );
    return () => {
      live = false;
      off();
    };
  }, [bridge]);
  if (list.length === 0) return null;
  const time = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(i18n.language);
  };
  return (
    <div className="baa-hmi-stuck-notice" role="alert" data-testid="hmi-stuck-notice">
      <p>{t('hmi.stuckNotice.title')}</p>
      <ul>
        {list.map((e) => (
          <li key={e.key}>
            {t('hmi.stuckNotice.item', { address: e.address, cpu: e.cpu, time: time(e.at) })}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => {
          const keys = list.map((e) => e.key);
          setList([]);
          void bridge.plcHmiStuckAck(keys).catch(() => undefined);
        }}
      >
        {t('hmi.stuckNotice.ack')}
      </button>
    </div>
  );
}
