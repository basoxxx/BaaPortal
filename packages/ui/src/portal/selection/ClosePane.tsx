import { useTranslation } from 'react-i18next';
import { useAppStore, useServices } from '../../state/AppContext';

export function ClosePane() {
  const { t } = useTranslation();
  const { service, store } = useServices();
  const doc = useAppStore((s) => s.doc);
  const close = async () => {
    if (await service.close()) store.getState().setStartAction('open');
  };
  return (
    <>
      <h2>{t('portal.action.close')}</h2>
      <p>{doc ? t('portal.close.description', { name: doc.project.meta.name }) : t('portal.noProject')}</p>
      <button type="button" className="baa-btn" disabled={!doc} onClick={() => void close()}>
        {t('portal.close.confirm')}
      </button>
    </>
  );
}
