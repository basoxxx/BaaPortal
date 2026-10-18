import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from '../icons';
import '../icons/portal';
import { useAppStore } from '../state/AppContext';
import type { PortalId } from '../state/store';

export const PORTALS: { id: PortalId; icon: IconName }[] = [
  { id: 'start', icon: 'portalStart' },
  { id: 'devices', icon: 'portalDevices' },
  { id: 'plc', icon: 'portalPlc' },
  { id: 'online', icon: 'portalOnline' },
];

export function PortalList({ current, onSelect }: { current: PortalId; onSelect(p: PortalId): void }) {
  const { t } = useTranslation();
  const hasDoc = useAppStore((s) => s.doc !== null);
  return (
    <nav className="baa-portal-list" data-testid="portal-list">
      {PORTALS.map(({ id, icon }) => (
        <button
          key={id}
          type="button"
          className="baa-portal-item"
          data-testid={`portal-${id}`}
          aria-current={id === current}
          disabled={id !== 'start' && !hasDoc}
          onClick={() => onSelect(id)}
        >
          <Icon name={icon} size={32} />
          {t(`portal.${id}`)}
        </button>
      ))}
    </nav>
  );
}
