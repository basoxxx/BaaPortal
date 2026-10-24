import { useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import type { Mc7Diagnostic } from '@baaportal/project';
import { useAppStore, useServices } from '../../state/AppContext';
import type { CompileRow } from '../../state/store';

const SYMBOL: Record<CompileRow['status'], string> = { ok: '✓', warning: '⚠', error: '✗' };

/**
 * Testo di una diagnostica nella lingua corrente: `mc7.diag.<CODICE>`, oppure `awl.diag.<CODICE>`
 * per i codici del controllo AWL (che ha `name` fra i parametri), altrimenti il testo del
 * compilatore. I parametri della diagnostica servono all'interpolazione; `{{detail}}` è il testo
 * del compilatore (per i codici il cui dettaglio non è nei parametri).
 */
export function localizeDiagnostic(
  t: TFunction,
  exists: (key: string) => boolean,
  d: Mc7Diagnostic,
): string {
  const mc7 = `mc7.diag.${d.code}`;
  const awl = `awl.diag.${d.code}`;
  const keys = d.params?.name !== undefined ? [awl, mc7] : [mc7, awl];
  const key = keys.find(exists);
  return key ? t(key, { ...(d.params ?? {}), detail: d.message }) : d.message;
}

export function useDiagnosticText() {
  const { t, i18n } = useTranslation();
  return (d: Mc7Diagnostic): string => localizeDiagnostic(t, (k) => i18n.exists(k), d);
}

/** Scheda Informazioni → Compila: una riga per blocco, i messaggi sotto e il riepilogo in fondo. */
export function CompileMessages() {
  const { t } = useTranslation();
  const { store } = useServices();
  const compile = useAppStore((s) => s.compile);
  const text = useDiagnosticText();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  if (compile.rows.length === 0 && !compile.summary) {
    return <p className="baa-placeholder">{t('inspector.compileEmpty')}</p>;
  }
  return (
    <div className="baa-compile">
      <ul className="baa-compile-list" aria-label={t('compile.list')}>
        {compile.rows.map((r) => {
          // Un blocco con errori o avvisi si mostra aperto, finché non lo si chiude a mano.
          const expanded = r.diagnostics.length > 0 && !open.has(r.blockId);
          return (
            <li
              key={r.blockId}
              data-testid="compile-row"
              data-block={r.name}
              data-status={r.status}
              className={`baa-compile-row is-${r.status}`}
            >
              <div className="baa-compile-head">
                <span
                  className={`baa-sev baa-sev-${r.status === 'ok' ? 'info' : r.status}`}
                  title={t(`compile.row${r.status[0]!.toUpperCase()}${r.status.slice(1)}`)}
                >
                  <span aria-hidden="true">{SYMBOL[r.status]}</span>
                  <span className="baa-sr-only">
                    {t(`compile.row${r.status[0]!.toUpperCase()}${r.status.slice(1)}`)}
                  </span>
                </span>
                <strong>{r.name}</strong>
                <span className="baa-compile-tag">[{r.tag}]</span>
                <span className="baa-compile-counts">
                  {t('compile.counts', { errors: r.errors, warnings: r.warnings })}
                </span>
                {r.diagnostics.length > 0 ? (
                  <button
                    type="button"
                    className="baa-panel-btn"
                    aria-expanded={expanded}
                    aria-label={t(expanded ? 'compile.collapse' : 'compile.expand', {
                      name: r.name,
                    })}
                    onClick={() => toggle(r.blockId)}
                  >
                    <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                  </button>
                ) : null}
              </div>
              {expanded ? (
                <ul className="baa-compile-messages">
                  {r.diagnostics.map((d, i) => (
                    <li key={i}>
                      <button
                        type="button"
                        data-testid="compile-message"
                        className={`baa-info-link is-${d.severity}`}
                        title={t('compile.goTo')}
                        onClick={() =>
                          store.getState().openBlockAt({
                            deviceId: r.deviceId,
                            blockId: r.blockId,
                            network: d.network,
                            line: d.line,
                          })
                        }
                      >
                        <span aria-hidden="true">
                          {d.severity === 'error' ? '✗' : d.severity === 'info' ? 'ℹ' : '⚠'}
                        </span>{' '}
                        <span className="baa-sr-only">{t(`compile.sev.${d.severity}`)}</span>
                        {d.network > 0
                          ? `${t('compile.position', { network: d.network, line: d.line })}: `
                          : `${t('compile.blockLevel')}: `}
                        {text(d)}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
      {compile.interrupted ? (
        <p className="baa-compile-summary" data-testid="compile-interrupted">
          {t('compile.interrupted')}
        </p>
      ) : null}
      {compile.summary && !compile.interrupted ? (
        <p className="baa-compile-summary" data-testid="compile-summary">
          {t('compile.summary', { ...compile.summary })}
        </p>
      ) : null}
    </div>
  );
}
