import { Fragment, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { findDevice, type Project } from '@baaportal/project';
import { useAppStore, useServices } from '../../state/AppContext';
import { useMnemonic } from '../../editors/awl/mnemonicPreference';
import { activeObjectRef, openHit, replaceHits, runFind } from '../../search/findActions';
import type { FindUi } from '../../search/findState';
import type { Hit } from '../../search/types';

/** Dove sta il risultato: il nome dell'oggetto, per raggrupparli. */
function groupOf(p: Project, h: Hit): string {
  const l = h.loc;
  const dev = findDevice(p, l.deviceId);
  if (!dev) return '';
  if (l.kind === 'source') return dev.sources.find((s) => s.id === l.sourceId)?.name ?? '';
  if (l.kind === 'tag') return dev.tagTables.find((x) => x.id === l.tableId)?.name ?? '';
  return dev.blocks.find((b) => b.id === l.blockId)?.name ?? '';
}

export function FindReplace() {
  const { t } = useTranslation();
  const { store } = useServices();
  const find = useAppStore((s) => s.find);
  const request = useAppStore((s) => s.findRequest);
  const project = useAppStore((s) => s.doc?.project ?? null);
  const hasActive = useAppStore((s) => activeObjectRef(s) !== null);
  const findRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const patch = (p: Partial<FindUi>) => store.getState().patchFind(p);

  useEffect(() => {
    if (!request) return;
    const el = request.field === 'find' ? findRef.current : replaceRef.current;
    el?.focus();
    el?.select();
    store.getState().setFindRequest(null);
  }, [request, store]);

  const out = find.outcome;
  const hits = out?.kind === 'hits' ? out.hits : [];
  const [mnemonic] = useMnemonic();
  const stale =
    out?.kind === 'hits' &&
    (out.project !== project || out.options.mnemonic !== (mnemonic === 'german' ? 'de' : 'int'));
  const current = find.selected !== null ? hits[find.selected] : undefined;
  const scope = find.scope === 'active' && !hasActive ? 'project' : find.scope;

  const search = () => {
    if (scope !== find.scope) patch({ scope });
    runFind(store);
  };
  const select = (i: number) => {
    patch({ selected: i });
    const h = hits[i];
    if (h) openHit(store, h);
  };

  const groups: { name: string; items: { h: Hit; i: number }[] }[] = [];
  if (project && out?.kind === 'hits') {
    hits.forEach((h, i) => {
      const name = groupOf(out.project, h);
      let g = groups.find((x) => x.name === name);
      if (!g) groups.push((g = { name, items: [] }));
      g.items.push({ h, i });
    });
  }

  const reasonText = (h: Hit) => (h.reason ? t(`find.reason.${h.reason}`) : undefined);
  const check = (key: 'matchCase' | 'wholeWord' | 'regex') => (
    <label className="baa-find-check">
      <input
        type="checkbox"
        checked={find[key]}
        onChange={(e) => patch({ [key]: e.target.checked })}
      />
      {t(`find.${key}`)}
    </label>
  );

  return (
    <div className="baa-find" data-testid="find-replace">
      <label>
        <span>{t('find.find')}</span>
        <input
          ref={findRef}
          type="text"
          value={find.query}
          aria-label={t('find.find')}
          aria-invalid={out?.kind === 'error'}
          onChange={(e) => patch({ query: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') search();
          }}
        />
      </label>
      {out?.kind === 'error' ? (
        <p role="alert" className="baa-find-error">
          {t('find.invalidRegex', { detail: out.detail })}
        </p>
      ) : null}
      <label>
        <span>{t('find.replaceWith')}</span>
        <input
          ref={replaceRef}
          type="text"
          value={find.replacement}
          aria-label={t('find.replaceWith')}
          onChange={(e) => patch({ replacement: e.target.value })}
        />
      </label>
      <div className="baa-find-options">
        {check('matchCase')}
        {check('wholeWord')}
        {check('regex')}
      </div>
      <label>
        <span>{t('find.scope')}</span>
        <select
          value={scope}
          aria-label={t('find.scope')}
          onChange={(e) => patch({ scope: e.target.value as 'project' | 'active' })}
        >
          <option value="project">{t('find.scopeProject')}</option>
          <option value="active" disabled={!hasActive}>
            {t('find.scopeActive')}
          </option>
        </select>
      </label>
      <div className="baa-find-buttons">
        <button type="button" onClick={search} disabled={!project || find.query === ''}>
          {t('find.search')}
        </button>
        <button
          type="button"
          onClick={() => current && replaceHits(store, [current])}
          disabled={stale || !current}
        >
          {t('find.replace')}
        </button>
        <button
          type="button"
          onClick={() => replaceHits(store)}
          disabled={stale || hits.length === 0}
        >
          {t('find.replaceAll')}
        </button>
      </div>
      {stale ? (
        <p role="status" className="baa-find-stale">
          {t('find.stale')}
        </p>
      ) : null}
      {out?.kind === 'hits' ? (
        <p role="status" className="baa-find-count">
          {t('find.count', { count: hits.length })}
        </p>
      ) : null}
      <ul className="baa-find-results" aria-label={t('find.results')}>
        {groups.map((g) => (
          <Fragment key={g.name}>
            <li className="baa-find-group" role="presentation">
              {g.name}
            </li>
            {g.items.map(({ h, i }) => (
              <li key={i} role="presentation">
                <button
                  type="button"
                  className={`baa-find-hit${h.editable ? '' : ' is-readonly'}${
                    i === find.selected ? ' is-selected' : ''
                  }`}
                  aria-current={i === find.selected}
                  title={reasonText(h)}
                  onClick={() => select(i)}
                >
                  {h.preview}
                </button>
              </li>
            ))}
          </Fragment>
        ))}
      </ul>
    </div>
  );
}
