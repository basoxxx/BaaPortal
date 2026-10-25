import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { commands } from '../commands/commands';
import { useServices } from '../state/AppContext';
import {
  cancelDownload,
  dismiss,
  download,
  installNow,
  later,
  openNotes,
  showInFolder,
  startUpdates,
  useUpdateState,
} from './updateController';
import './update.css';

/** Avviso non modale in basso a destra, sopra portale e vista progetto. */
export function UpdateNotice() {
  const { t } = useTranslation();
  const { bridge, service, store } = useServices();
  const { notice, message } = useUpdateState();
  useEffect(() => startUpdates(bridge), [bridge]);
  if (!notice) return null;

  const restart = () =>
    void installNow(() => service.prepareForUpdate(), {
      busy: t('update.busy'),
      notReady: t('update.notReady'),
    });
  const quit = () => void commands['project.exit'].run({ store, service, bridge });

  let body;
  switch (notice.kind) {
    case 'available':
      body = (
        <>
          <p>{t('update.available', { version: notice.version })}</p>
          <div className="baa-update-actions">
            <button type="button" onClick={download}>
              {t('update.download')}
            </button>
            <button type="button" onClick={later}>
              {t('update.later')}
            </button>
            <button
              type="button"
              className="baa-update-link"
              onClick={() => openNotes(notice.version)}
            >
              {t('update.notes')}
            </button>
          </div>
        </>
      );
      break;
    case 'downloading': {
      const percent = notice.total > 0 ? Math.floor((notice.transferred / notice.total) * 100) : 0;
      body = (
        <>
          <p>{t('update.downloading', { version: notice.version, percent })}</p>
          <progress value={percent} max={100} aria-label={t('status.progress')} />
          <div className="baa-update-actions">
            <button type="button" onClick={cancelDownload}>
              {t('update.cancel')}
            </button>
          </div>
        </>
      );
      break;
    }
    case 'downloaded':
      body = (
        <>
          <p>{t('update.ready', { version: notice.version })}</p>
          <div className="baa-update-actions">
            <button type="button" onClick={restart}>
              {t('update.restart')}
            </button>
            <button type="button" onClick={dismiss}>
              {t('update.nextStart')}
            </button>
          </div>
        </>
      );
      break;
    case 'macReady':
      body = (
        <>
          <p>{t('update.macReady')}</p>
          <div className="baa-update-actions">
            <button type="button" onClick={showInFolder}>
              {t('update.showInFinder')}
            </button>
            <button type="button" onClick={quit}>
              {t('update.quit')}
            </button>
            <button type="button" onClick={dismiss}>
              {t('update.ok')}
            </button>
          </div>
        </>
      );
      break;
    case 'none':
      body = <p>{t('update.upToDate', { version: notice.version })}</p>;
      break;
    case 'error':
      body = (
        <>
          <p>{notice.message}</p>
          <div className="baa-update-actions">
            <button type="button" onClick={dismiss}>
              {t('update.close')}
            </button>
          </div>
        </>
      );
  }
  return (
    <div className="baa-update-notice" role="status" data-testid="update-notice">
      {body}
      {message ? <p data-testid="update-message">{message}</p> : null}
    </div>
  );
}
