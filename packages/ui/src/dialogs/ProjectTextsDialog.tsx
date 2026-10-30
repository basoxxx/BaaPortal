import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  listTextEntries,
  markReviewed,
  staleTranslations,
  setLanguages,
  MAX_TRANSLATION_LENGTH,
  setTranslation,
  type ProjectLanguages,
} from '@baaportal/project';
import { CommitInput } from '../components/CommitField';
import { Dialog } from '../components/Dialog';
import { useAppStore, useServices } from '../state/AppContext';
import { exportProjectTexts, importProjectTexts } from './projectTextsIo';
import './projectTexts.css';

/** Altezza di una riga e righe in più sopra e sotto la finestra visibile: l'elenco è virtuale. */
const ROW_HEIGHT = 34;
const OVERSCAN = 10;
const FALLBACK_VIEWPORT = 400;
const DEFAULT_EDITING = 'it-IT';

/** «Testi di progetto»: lingue, tabella delle traduzioni, esportazione e importazione. */
export function ProjectTextsDialog({ onClose }: { onClose(): void }) {
  const { t } = useTranslation();
  const { store, bridge } = useServices();
  const languages = useAppStore((s) => s.doc?.project.languages);
  const texts = useAppStore((s) => s.doc?.project.texts);
  const devices = useAppStore((s) => s.doc?.project.devices);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState(false);
  const [scroll, setScroll] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const project = useAppStore((s) => s.doc?.project);
  const stale = useMemo(
    () => (project ? staleTranslations(project) : new Set<string>()),
    [project],
  );
  const base: ProjectLanguages = languages ?? { editing: DEFAULT_EDITING, others: [] };
  const all = [base.editing, ...base.others];
  const entries = useMemo(() => (devices ? listTextEntries({ devices }) : []), [devices]);
  const q = filter.trim().toLowerCase();
  const shown = entries.filter(
    (e) =>
      !q ||
      e.object.toLowerCase().includes(q) ||
      e.source.toLowerCase().includes(q) ||
      Object.values(texts?.[e.key] ?? {}).some((v) => v.toLowerCase().includes(q)),
  );

  // Solo le righe nella finestra visibile (più qualcuna sopra e sotto) sono nel DOM.
  const viewport = box.current?.clientHeight || FALLBACK_VIEWPORT;
  const first = Math.max(0, Math.floor(scroll / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(shown.length, Math.ceil((scroll + viewport) / ROW_HEIGHT) + OVERSCAN);
  const topPad = first * ROW_HEIGHT;
  const bottomPad = (shown.length - last) * ROW_HEIGHT;

  const apply = (next: ProjectLanguages) => {
    let ok = true;
    store.getState().edit('history.projectLanguages', (p) => {
      ok = setLanguages(p, next);
    });
    setError(!ok);
  };
  const ctx = { store, bridge };

  return (
    <Dialog
      title={t('texts.title')}
      onClose={onClose}
      onOk={() => undefined}
      testId="project-texts"
      footer={
        <button type="button" data-testid="dialog-cancel" onClick={onClose}>
          {t('texts.close')}
        </button>
      }
    >
      <div className="baa-texts">
        <div className="baa-texts-langs">
          <label>
            <span>{t('texts.editing')}</span>
            <CommitInput
              value={base.editing}
              aria-label={t('texts.editing')}
              onCommit={(v) => apply({ ...base, editing: v.trim() })}
            />
          </label>
          <label>
            <span>{t('texts.others')}</span>
            <CommitInput
              value={base.others.join(', ')}
              aria-label={t('texts.others')}
              onCommit={(v) =>
                apply({ ...base, others: v.split(/[\s,;]+/).filter((x) => x !== '') })
              }
            />
          </label>
          <label>
            <span>{t('texts.display')}</span>
            <select
              aria-label={t('texts.display')}
              value={base.display ?? base.editing}
              onChange={(e) => apply({ ...base, display: e.target.value })}
            >
              {all.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error ? (
          <p role="alert" className="baa-texts-error">
            {t('texts.langInvalid')}
          </p>
        ) : null}
        <p className="baa-texts-hint">{t('texts.hint')}</p>
        <div className="baa-texts-tools">
          <input
            type="search"
            value={filter}
            placeholder={t('texts.filter')}
            aria-label={t('texts.filter')}
            onChange={(e) => {
              setFilter(e.target.value);
              setScroll(0);
              if (box.current) box.current.scrollTop = 0;
            }}
          />
          <button type="button" onClick={() => void exportProjectTexts('xlsx', ctx)}>
            {t('texts.exportXlsx')}
          </button>
          <button type="button" onClick={() => void exportProjectTexts('csv', ctx)}>
            {t('texts.exportCsv')}
          </button>
          <button
            type="button"
            disabled={base.others.length === 0}
            onClick={() => void importProjectTexts(ctx)}
          >
            {t('texts.import')}
          </button>
        </div>
        <div
          className="baa-texts-scroll"
          ref={box}
          onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
        >
          <table className="baa-texts-table">
            <thead>
              <tr>
                <th>{t('texts.col.object')}</th>
                <th>{t('texts.col.field')}</th>
                <th>{base.editing}</th>
                {base.others.map((l) => (
                  <th key={l}>{l}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {topPad > 0 ? (
                <tr aria-hidden="true" style={{ height: topPad }}>
                  <td colSpan={3 + base.others.length} />
                </tr>
              ) : null}
              {shown.slice(first, last).map((e) => (
                <tr
                  key={e.key}
                  style={{ height: ROW_HEIGHT }}
                  className={stale.has(e.key) ? 'baa-texts-stale' : undefined}
                >
                  <td>{e.object}</td>
                  <td>{t(`texts.field.${e.field}`)}</td>
                  <td>
                    {e.source}
                    {stale.has(e.key) ? (
                      <>
                        {' '}
                        <button
                          type="button"
                          title={t('texts.markReviewed')}
                          aria-label={`${t('texts.markReviewed')}: ${e.object}`}
                          onClick={() =>
                            store
                              .getState()
                              .edit('history.editTranslation', (p) =>
                                markReviewed(p, e.key, e.source),
                              )
                          }
                        >
                          {t('texts.stale')}
                        </button>
                      </>
                    ) : null}
                  </td>
                  {base.others.map((l) => (
                    <td key={l}>
                      <CommitInput
                        value={texts?.[e.key]?.[l] ?? ''}
                        aria-label={`${e.object} ${t(`texts.field.${e.field}`)} ${l}`}
                        validate={(v) =>
                          v.length > MAX_TRANSLATION_LENGTH
                            ? t('texts.tooLong', { max: MAX_TRANSLATION_LENGTH })
                            : null
                        }
                        onCommit={(v) =>
                          store
                            .getState()
                            .edit(
                              'history.editTranslation',
                              (p) => void setTranslation(p, e.key, l, v, e.source),
                            )
                        }
                      />
                    </td>
                  ))}
                </tr>
              ))}
              {bottomPad > 0 ? (
                <tr aria-hidden="true" style={{ height: bottomPad }}>
                  <td colSpan={3 + base.others.length} />
                </tr>
              ) : null}
            </tbody>
          </table>
          {entries.length === 0 ? <p className="baa-texts-hint">{t('texts.empty')}</p> : null}
        </div>
      </div>
    </Dialog>
  );
}
