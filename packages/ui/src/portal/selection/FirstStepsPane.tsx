import { useTranslation } from 'react-i18next';
import { useAppStore, useServices } from '../../state/AppContext';

export function FirstStepsPane() {
  const { t } = useTranslation();
  const { store } = useServices();
  const hasDoc = useAppStore((s) => s.doc !== null);
  if (!hasDoc) {
    return (
      <>
        <h2>{t('portal.action.firstSteps')}</h2>
        <p>{t('portal.noProject')}</p>
      </>
    );
  }
  const tiles = [
    { key: 'device', run: () => store.getState().setPortal('devices') },
    { key: 'program', run: () => store.getState().setPortal('plc') },
    { key: 'projectView', run: () => store.getState().setView('project') },
  ] as const;
  return (
    <>
      <h2>{t('portal.action.firstSteps')}</h2>
      <div className="baa-tiles">
        {tiles.map(({ key, run }) => (
          <button key={key} type="button" className="baa-tile" onClick={run}>
            <strong>{t(`portal.firstSteps.${key}.title`)}</strong>
            <span>{t(`portal.firstSteps.${key}.description`)}</span>
          </button>
        ))}
      </div>
    </>
  );
}
