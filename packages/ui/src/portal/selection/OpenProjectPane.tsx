import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RecentEntry } from '../../bridge';
import { useServices } from '../../state/AppContext';

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

export function OpenProjectPane() {
  const { t } = useTranslation();
  const { bridge, service, store } = useServices();
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void bridge.recentList().then((r) => { if (!cancelled) setRecent(r); });
    return () => { cancelled = true; };
  }, [bridge]);

  const openEntry = async (entry: RecentEntry) => {
    if (entry.exists) {
      await service.open(entry.path);
      return;
    }
    store.getState().pushMessage({ severity: 'warning', textKey: 'messages.recentMissing', params: { name: entry.name } });
    setNotice(t('messages.recentMissing', { name: entry.name }));
    setRecent(await bridge.recentRemove(entry.path));
  };

  return (
    <>
      <h2>{t('portal.action.open')}</h2>
      {notice ? <p className="baa-notice" role="status">{notice}</p> : null}
      <table className="baa-recent">
        <thead>
          <tr>
            <th>{t('portal.open.project')}</th>
            <th>{t('portal.open.path')}</th>
            <th>{t('portal.open.lastAccess')}</th>
          </tr>
        </thead>
        <tbody>
          {recent.map((r) => (
            <tr key={r.path} data-missing={!r.exists} onDoubleClick={() => void openEntry(r)}>
              <td>
                <span>{r.name}</span>
                {r.exists ? null : <span> {t('portal.open.notFound')}</span>}
              </td>
              <td>{r.path}</td>
              <td>{formatDate(r.lastOpened)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="baa-btn" onClick={() => void service.openFromDialog()}>
        {t('portal.browse')}
      </button>
    </>
  );
}
