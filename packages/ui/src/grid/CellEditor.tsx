import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

/** Come prosegue la griglia dopo la modifica: 'blur' = il focus è già andato altrove. */
export type EditNav = 'down' | 'right' | 'left' | 'stay' | 'blur';

const MAX_SUGGESTIONS = 50;

interface Props {
  /** Testo iniziale: quello della cella, o il carattere digitato per avviare la modifica. */
  initial: string;
  /** true = parte da un tasto (F2, Invio): il testo esistente è selezionato per essere sostituito. */
  selectAll: boolean;
  /** Elenco filtrato mentre si scrive (colonne 'type'); assente per il testo semplice. */
  suggestions?: string[];
  listId: string;
  label: string;
  onDone(value: string, nav: EditNav): void;
  onCancel(): void;
}

export function CellEditor({
  initial,
  selectAll,
  suggestions,
  listId,
  label,
  onDone,
  onCancel,
}: Props) {
  const { t } = useTranslation();
  const [text, setText] = useState(initial);
  const [listOpen, setListOpen] = useState(true);
  const [hi, setHi] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter, Tab ed Esc smontano il campo: il blur che ne segue non deve confermare una seconda volta.
  const done = useRef(false);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (selectAll) el.select();
    else el.setSelectionRange(el.value.length, el.value.length);
    // Solo al montaggio.
  }, []);

  const needle = text.toLowerCase();
  const matches = suggestions
    ? suggestions.filter((s) => s.toLowerCase().includes(needle)).slice(0, MAX_SUGGESTIONS)
    : [];
  const showList = listOpen && matches.length > 0;

  const finish = (value: string, nav: EditNav) => {
    if (done.current) return;
    done.current = true;
    onDone(value, nav);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        finish(showList && hi >= 0 ? matches[hi]! : text, 'down');
        return;
      case 'Tab':
        e.preventDefault();
        finish(text, e.shiftKey ? 'left' : 'right');
        return;
      case 'Escape':
        e.preventDefault();
        if (showList) setListOpen(false);
        else if (!done.current) {
          done.current = true;
          onCancel();
        }
        return;
      case 'ArrowDown':
      case 'ArrowUp':
        if (!showList) return;
        e.preventDefault();
        setHi((h) =>
          e.key === 'ArrowDown' ? Math.min(h + 1, matches.length - 1) : Math.max(h - 1, 0),
        );
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        className="baa-grid-input"
        value={text}
        aria-label={label}
        role={suggestions ? 'combobox' : undefined}
        aria-expanded={suggestions ? showList : undefined}
        aria-autocomplete={suggestions ? 'list' : undefined}
        aria-controls={showList ? listId : undefined}
        aria-activedescendant={showList && hi >= 0 ? `${listId}-${hi}` : undefined}
        onChange={(e) => {
          setText(e.target.value);
          setHi(-1);
          setListOpen(true);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => finish(text, 'blur')}
      />
      {showList ? (
        <ul id={listId} role="listbox" aria-label={t('grid.suggestions')} className="baa-grid-list">
          {matches.map((s, i) => (
            <li
              key={s}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === hi}
              className={i === hi ? 'is-active' : undefined}
              // Il clic non deve togliere il focus al campo prima di scegliere.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => finish(s, 'stay')}
            >
              {s}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
