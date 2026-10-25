import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import projectPackage from '../../../../project/package.json';
import uiPackage from '../../../package.json';
import { checkNow, useUpdateState } from '../../update/updateController';
import { useServices } from '../../state/AppContext';

export function InstalledSoftwarePane() {
  const { t } = useTranslation();
  const { bridge } = useServices();
  const { info } = useUpdateState();
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void bridge.appVersion().then((v) => {
      if (!cancelled) setAppVersion(v);
    });
    return () => {
      cancelled = true;
    };
  }, [bridge]);
  const rows = [
    ...(appVersion ? [`BaaPortal ${appVersion}`] : []),
    `${uiPackage.name} ${uiPackage.version}`,
    `${projectPackage.name} ${projectPackage.version}`,
  ];
  return (
    <>
      <h2>{t('portal.action.installed')}</h2>
      <ul>
        {rows.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      {info ? (
        <p data-testid="update-channel">
          {info.prereleaseBuild ? t('update.channel') : t('update.channelStable')}
        </p>
      ) : null}
      <button type="button" disabled={info?.enabled !== true} onClick={checkNow}>
        {t('update.check')}
      </button>
    </>
  );
}
