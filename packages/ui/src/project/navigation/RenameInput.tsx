import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
  initial: string;
  /** Errore del nome proposto, o null se va bene. */
  check(name: string): 'INVALID' | 'DUPLICATE' | null;
  onCommit(name: string): void;
  /** Chiamato a fine modifica, con o senza conferma. */
  onDone(): void;
}

/** Campo di rinomina in linea: Invio conferma, Esc annulla, l'uscita dal campo conferma. */
export function RenameInput({ initial, check, onCommit, onDone }: Props) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<'INVALID' | 'DUPLICATE' | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const finished = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = (commit: boolean) => {
    finished.current = true;
    if (commit && value !== initial) onCommit(value);
    onDone();
  };
  // Con Invio un nome errato lascia il campo aperto; uscendo dal campo si torna al nome di prima.
  const submit = (fromBlur: boolean) => {
    if (finished.current) return;
    const problem = value === initial ? null : check(value);
    if (problem) {
      if (fromBlur) finish(false);
      else setError(problem);
      return;
    }
    finish(true);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // I tasti del campo non devono muovere la selezione dell'albero.
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      submit(false);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  };

  return (
    <>
      <input
        ref={ref}
        className="baa-rename-input"
        aria-label={t('objects.renameLabel')}
        aria-invalid={error ? true : undefined}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => submit(true)}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      />
      {error ? (
        <span role="alert" className="baa-rename-error">
          {t(error === 'INVALID' ? 'objects.errInvalid' : 'objects.errDuplicate')}
        </span>
      ) : null}
    </>
  );
}
