import { Fragment, useEffect, useRef, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

export interface ContextMenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  /** Linea di separazione sopra la voce. */
  separator?: boolean;
  run(): void;
}

interface Props {
  x: number;
  y: number;
  label: string;
  items: ContextMenuItem[];
  onClose(): void;
}

/** Menu contestuale: frecce per muoversi (le voci disattivate si saltano), Invio esegue, Esc chiude. */
export function ContextMenu({ x, y, label, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const enabled = items.flatMap((it, i) => (it.disabled ? [] : [i]));

  const focusItem = (index: number | undefined) => {
    if (index !== undefined)
      ref.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus();
  };

  useEffect(() => {
    focusItem(enabled[0]);
    // Un clic fuori dal menu lo chiude.
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
    // Solo alla comparsa del menu.
  }, []);

  const activate = (item: ContextMenuItem) => {
    if (item.disabled) return;
    onClose();
    item.run();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const current = Number((document.activeElement as HTMLElement | null)?.dataset['index'] ?? -1);
    const pos = enabled.indexOf(current);
    switch (e.key) {
      case 'ArrowDown':
        focusItem(enabled[(pos + 1) % enabled.length]);
        break;
      case 'ArrowUp':
        focusItem(enabled[(pos - 1 + enabled.length) % enabled.length]);
        break;
      case 'Home':
        focusItem(enabled[0]);
        break;
      case 'End':
        focusItem(enabled[enabled.length - 1]);
        break;
      case 'Enter':
      case ' ': {
        const item = items[current];
        if (item) activate(item);
        break;
      }
      case 'Escape':
      case 'Tab':
        onClose();
        break;
      default:
        // Aperto, il menu è l'unico a ricevere i tasti (Elimina non deve arrivare all'albero).
        e.stopPropagation();
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className="baa-menu baa-context-menu"
      style={{ position: 'fixed', top: y, left: x }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <Fragment key={item.id}>
          {item.separator ? <div role="separator" className="baa-menu-sep" /> : null}
          <div
            role="menuitem"
            data-index={i}
            data-testid={`context-${item.id}`}
            tabIndex={-1}
            aria-disabled={item.disabled ? true : undefined}
            className="baa-menu-item"
            onClick={() => activate(item)}
          >
            <span>{item.label}</span>
          </div>
        </Fragment>
      ))}
    </div>,
    document.body,
  );
}
