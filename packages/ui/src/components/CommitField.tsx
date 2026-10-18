import { useState } from 'react';

interface CommonProps {
  id?: string;
  value: string;
  onCommit(v: string): void;
  'aria-label'?: string;
  readOnly?: boolean;
}

/** Bozza locale: segue `value` finché il campo non ha il focus. */
function useDraft(value: string) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  return {
    draft: focused ? draft : value,
    setDraft,
    focused,
    focus: () => {
      setDraft(value);
      setFocused(true);
    },
    leave: () => setFocused(false),
  };
}

export function CommitInput(
  p: CommonProps & { validate?(v: string): string | null },
): React.JSX.Element {
  const d = useDraft(p.value);
  const error = d.focused && p.validate ? p.validate(d.draft) : null;
  const commit = () => {
    if (d.draft !== p.value && !error) p.onCommit(d.draft);
  };
  const errorId = p.id ? `${p.id}-error` : undefined;
  return (
    <>
      <input
        id={p.id}
        aria-label={p['aria-label']}
        readOnly={p.readOnly}
        value={d.draft}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onFocus={d.focus}
        onChange={(e) => d.setDraft(e.target.value)}
        onBlur={() => {
          commit();
          d.leave();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            // Se c'era qualcosa da annullare, l'Esc è del campo: non deve chiudere un dialogo attorno.
            if (d.draft !== p.value) {
              e.preventDefault();
              e.stopPropagation();
            }
            d.setDraft(p.value);
          }
        }}
      />
      {error ? (
        <span id={errorId} role="alert" className="baa-field-error">
          {error}
        </span>
      ) : null}
    </>
  );
}

export function CommitTextarea(p: CommonProps & { rows?: number }): React.JSX.Element {
  const d = useDraft(p.value);
  return (
    <textarea
      id={p.id}
      aria-label={p['aria-label']}
      readOnly={p.readOnly}
      rows={p.rows}
      value={d.draft}
      onFocus={d.focus}
      onChange={(e) => d.setDraft(e.target.value)}
      onBlur={() => {
        if (d.draft !== p.value) p.onCommit(d.draft);
        d.leave();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          if (d.draft !== p.value) {
            e.preventDefault();
            e.stopPropagation();
          }
          d.setDraft(p.value);
        }
      }}
    />
  );
}
