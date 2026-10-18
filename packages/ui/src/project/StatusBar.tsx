import { useTranslation } from 'react-i18next';
import { useAppStore } from '../state/AppContext';

export function StatusBar() {
  const { t } = useTranslation();
  const status = useAppStore((s) => s.status);
  return (
    <div data-testid="status-bar" className="baa-status-bar" role="status">
      {status ? t(status.textKey, status.params) : ''}
    </div>
  );
}
