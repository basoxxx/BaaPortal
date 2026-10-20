import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import './dialog.css';

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]';

interface DialogProps {
  title: string;
  onClose(): void;
  onOk(): void;
  okDisabled?: boolean;
  children: ReactNode;
  testId?: string;
  /** Pulsanti al posto di OK e Annulla. */
  footer?: ReactNode;
}

/** Finestra modale dentro l'app: focus intrappolato, Esc annulla, Invio conferma. */
export function Dialog({
  title,
  onClose,
  onOk,
  okDisabled,
  children,
  testId,
  footer,
}: DialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // Il focus iniziale va al primo campo; alla chiusura torna a ciò che lo aveva prima.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (bodyRef.current?.querySelector<HTMLElement>(FOCUSABLE) ?? boxRef.current)?.focus();
    return () => before?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    // Un campo che ha già gestito il tasto (Esc che ripristina, Invio che conferma) non chiude né conferma.
    if (e.defaultPrevented) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter') {
      const el = e.target as HTMLElement;
      if (el.tagName === 'BUTTON' || el.tagName === 'TEXTAREA') return;
      e.preventDefault();
      if (!okDisabled) onOk();
    } else if (e.key === 'Tab') {
      const items = [...(boxRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div className="baa-dialog-backdrop">
      <div
        ref={boxRef}
        className="baa-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className="baa-dialog-title">
          {title}
        </h2>
        <div ref={bodyRef} className="baa-dialog-body">
          {children}
        </div>
        <div className="baa-dialog-footer">
          {footer ?? (
            <>
              <button type="button" data-testid="dialog-ok" disabled={okDisabled} onClick={onOk}>
                {t('dialog.ok')}
              </button>
              <button type="button" data-testid="dialog-cancel" onClick={onClose}>
                {t('dialog.cancel')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
