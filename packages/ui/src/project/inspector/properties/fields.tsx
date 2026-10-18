import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CommitInput, CommitTextarea } from '../../../components/CommitField';

interface Common {
  label: string;
  /** Errore della diagnostica del modello, mostrato sotto il campo. */
  diag?: string | null;
}

const Diag = ({ id, text }: { id: string; text?: string | null }) =>
  text ? (
    <span id={id} className="baa-field-error">
      {text}
    </span>
  ) : null;

export function TextField(
  p: Common & {
    value: string;
    onCommit?(v: string): void;
    validate?(v: string): string | null;
    disabled?: boolean;
  },
) {
  const id = useId();
  return (
    <>
      <label htmlFor={id}>{p.label}</label>
      {p.disabled ? (
        <input id={id} value={p.value} disabled />
      ) : (
        <CommitInput
          id={id}
          value={p.value}
          readOnly={!p.onCommit}
          validate={p.validate}
          onCommit={(v) => p.onCommit?.(v)}
        />
      )}
      <Diag id={`${id}-diag`} text={p.diag} />
    </>
  );
}

export function TextAreaField(p: Common & { value: string; onCommit(v: string): void }) {
  const id = useId();
  return (
    <>
      <label htmlFor={id}>{p.label}</label>
      <CommitTextarea id={id} rows={3} value={p.value} onCommit={p.onCommit} />
    </>
  );
}

/** Campo numerico: accetta solo interi; i limiti del modello sono segnalati dalla diagnostica. */
export function NumberField(
  p: Common & { value: number; onCommit(n: number): void; validate?(n: number): string | null },
) {
  const { t } = useTranslation();
  return (
    <TextField
      label={p.label}
      diag={p.diag}
      value={String(p.value)}
      validate={(v) => {
        const s = v.trim();
        if (!/^-?\d+$/.test(s)) return t('props.integer');
        return p.validate?.(Number(s)) ?? null;
      }}
      onCommit={(v) => p.onCommit(Number(v.trim()))}
    />
  );
}

export function CheckField(p: {
  label: string;
  checked: boolean;
  onChange(v: boolean): void;
  hint?: ReactNode;
}) {
  const id = useId();
  return (
    <>
      <label htmlFor={id}>{p.label}</label>
      <input
        id={id}
        type="checkbox"
        checked={p.checked}
        aria-describedby={p.hint ? `${id}-hint` : undefined}
        onChange={(e) => p.onChange(e.target.checked)}
      />
      {p.hint ? (
        <span id={`${id}-hint`} className="baa-field-hint">
          {p.hint}
        </span>
      ) : null}
    </>
  );
}

/** Numero di oggetto con controllo dei limiti e pulsante "Automatico" (primo numero libero). */
export function AutoNumberField(
  p: Common & {
    value: number;
    validate(n: number): string | null;
    onCommit(n: number): void;
    free: number | null;
  },
) {
  const { t } = useTranslation();
  return (
    <>
      <NumberField label={p.label} value={p.value} validate={p.validate} onCommit={p.onCommit} />
      <span />
      <button
        type="button"
        className="baa-prop-auto"
        disabled={p.free === null}
        onClick={() => p.free !== null && p.onCommit(p.free)}
      >
        {t('addBlock.auto')}
      </button>
    </>
  );
}
