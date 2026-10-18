import { Icon, type IconName } from '../icons';
import '../icons/portal';

export interface ActionItem {
  id: string;
  label: string;
  icon?: IconName;
  disabled?: boolean;
}

export function ActionList({
  items,
  current,
  onSelect,
}: {
  items: ActionItem[];
  current: string | null;
  onSelect(id: string): void;
}) {
  return (
    <div className="baa-action-list" data-testid="action-list">
      {items.map((a) => (
        <button
          key={a.id}
          type="button"
          className="baa-action-item"
          data-testid={`action-${a.id}`}
          aria-current={a.id === current}
          disabled={a.disabled}
          onClick={() => onSelect(a.id)}
        >
          {a.icon ? <Icon name={a.icon} size={32} /> : null}
          {a.label}
        </button>
      ))}
    </div>
  );
}
