import { useTranslation } from 'react-i18next';
import { useAppStore, useServices } from '../../state/AppContext';
import type { InfoMessage } from '../../state/store';

const SYMBOL: Record<InfoMessage['severity'], string> = { info: 'ℹ', warning: '⚠', error: '✖' };

export function InfoMessages() {
  const { t, i18n } = useTranslation();
  const messages = useAppStore((s) => s.messages);
  const { store } = useServices();
  const locale = i18n.language.startsWith('it') ? 'it-IT' : 'en-GB';
  const fmtDate = (iso: string) => {
    const [y, mo, d] = iso.split('-').map(Number) as [number, number, number];
    return new Intl.DateTimeFormat(locale, { dateStyle: 'short' }).format(new Date(y, mo - 1, d));
  };
  return (
    <table className="baa-table">
      <thead>
        <tr>
          <th scope="col" className="baa-col-icon">
            <span className="baa-sr-only">{t('inspector.severity')}</span>
          </th>
          <th scope="col">{t('inspector.message')}</th>
          <th scope="col">{t('inspector.date')}</th>
          <th scope="col">{t('inspector.time')}</th>
        </tr>
      </thead>
      <tbody>
        {[...messages].reverse().map((m) => (
          <tr key={m.id} data-testid="info-row">
            <td
              className={`baa-sev baa-sev-${m.severity}`}
              data-testid={`severity-${m.severity}`}
              title={t(`inspector.sev.${m.severity}`)}
            >
              <span aria-hidden="true">{SYMBOL[m.severity]}</span>
              <span className="baa-sr-only">{t(`inspector.sev.${m.severity}`)}</span>
            </td>
            <td>
              {m.target ? (
                <button
                  type="button"
                  className="baa-info-link"
                  title={t('inspector.goToSource')}
                  onClick={() => {
                    const { deviceId, sourceId, line, col } = m.target!;
                    store.getState().openSourceAt({ deviceId, sourceId, line, col });
                  }}
                >
                  {t(m.textKey, m.params)}
                </button>
              ) : (
                t(m.textKey, m.params)
              )}
            </td>
            <td>{fmtDate(m.date)}</td>
            <td>{m.time}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
