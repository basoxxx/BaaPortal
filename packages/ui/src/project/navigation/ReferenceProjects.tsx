import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { closeReference, useReferences, useRevealedReference } from '../reference/referenceStore';
import { ReferenceTree } from '../reference/ReferenceTree';

/** Pannello "Progetti di riferimento": un albero in sola lettura per ogni riferimento aperto. */
export function ReferenceProjects() {
  const { t } = useTranslation();
  const refs = useReferences();
  const revealed = useRevealedReference();
  const boxes = useRef(new Map<string, HTMLElement>());
  useEffect(() => {
    if (revealed) boxes.current.get(revealed.key)?.scrollIntoView?.({ block: 'nearest' });
  }, [revealed]);
  if (refs.length === 0) return <p className="baa-placeholder">{t('navigation.referenceEmpty')}</p>;
  return (
    <div className="baa-reference-list">
      {refs.map((r) => (
        <section
          key={r.key}
          className="baa-reference"
          data-testid={`reference-${r.key}`}
          ref={(el) => {
            if (el) boxes.current.set(r.key, el);
            else boxes.current.delete(r.key);
          }}
        >
          <header className="baa-reference-head">
            <strong>{r.doc.meta.name}</strong>
            <span className="baa-reference-path" title={r.path}>
              {r.path}
            </span>
            <button
              type="button"
              aria-label={t('reference.close', { name: r.doc.meta.name })}
              title={t('reference.close', { name: r.doc.meta.name })}
              onClick={() => closeReference(r.key)}
            >
              ×
            </button>
          </header>
          <ReferenceTree reference={r} />
        </section>
      ))}
    </div>
  );
}
