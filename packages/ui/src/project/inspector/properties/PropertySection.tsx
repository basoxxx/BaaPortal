import { useId, useState, type ReactNode } from 'react';

/** Sezione comprimibile delle proprietà; all'inizio è aperta. */
export function PropertySection(p: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  return (
    <section className="baa-prop-section">
      <h3 className="baa-prop-head">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((o) => !o)}
        >
          <span aria-hidden="true">{open ? '▾' : '▸'}</span> {p.title}
        </button>
      </h3>
      {open ? (
        <div id={bodyId} className="baa-props">
          {p.children}
        </div>
      ) : null}
    </section>
  );
}
