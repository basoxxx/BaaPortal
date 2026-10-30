import { useDeferredValue, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { findCpu } from '@baaportal/catalog';
import {
  ASSIGN_AREAS,
  assignmentList,
  crossReferences,
  findDevice,
  type AssignArea,
  type AssignCell,
} from '@baaportal/project';
import { useAppStore, useServices } from '../../state/AppContext';
import type { EditorRef } from '../../state/workArea';
import { openCrossRef } from './xrefActions';
import './xref.css';

// Senza CPU nel catalogo non c'è un limite da mostrare: un valore oltre ogni area reale.
const NO_LIMITS = {
  mBytes: 65536,
  timers: 65536,
  counters: 65536,
  inputBytes: 65536,
  outputBytes: 65536,
};

/** Editor «Elenco di assegnazione»: i bit e i byte di I, Q, M, T e C usati, con tag e sovrapposizioni. */
export function AssignmentView({ editor }: { editor: EditorRef }) {
  const { t } = useTranslation();
  const { store } = useServices();
  const dev = useDeferredValue(
    useAppStore((s) => (s.doc ? findDevice(s.doc.project, editor.deviceId) : undefined)),
  );
  const lists = useMemo(
    () =>
      dev
        ? assignmentList(dev, crossReferences(dev), findCpu(dev.cpu.typeId)?.limits ?? NO_LIMITS)
        : [],
    [dev],
  );
  const [area, setArea] = useState<AssignArea>('I');
  if (!dev) return null;
  const list = lists.find((l) => l.area === area);
  const timed = area === 'T' || area === 'C';
  const addr = (byte: number, bit: number) =>
    timed ? `${area}${byte * 8 + bit}` : `${area}${byte}.${bit}`;
  const label = (c: AssignCell, a: string) =>
    [
      a,
      c.access ? t(`xref.accessKind.${c.access}`) : '',
      c.tags.length ? t('assign.tag', { names: c.tags.join(', ') }) : '',
      c.overlap ? t('assign.overlap') : '',
    ]
      .filter(Boolean)
      .join(', ');
  return (
    <div className="baa-xref" data-testid="assign-view">
      <div className="baa-xref-bar" role="radiogroup" aria-label={t('assign.area')}>
        {ASSIGN_AREAS.map((a) => (
          <label key={a}>
            <input
              type="radio"
              name={`assign-area-${editor.deviceId}`}
              checked={area === a}
              onChange={() => setArea(a)}
            />{' '}
            {t(`assign.areas.${a}`)}
          </label>
        ))}
        {list ? (
          <span className="baa-xref-count" data-testid="assign-count">
            {t(timed ? 'assign.usedElements' : 'assign.usedBytes', {
              used: list.used,
              limit: list.limit,
            })}
          </span>
        ) : null}
      </div>
      <p className="baa-xref-muted">{t('assign.legend')}</p>
      {!list || list.rows.length === 0 ? (
        <p className="baa-placeholder">{t('assign.empty')}</p>
      ) : (
        <table className="baa-xref-table baa-assign-table">
          <thead>
            <tr>
              <th>{t(timed ? 'assign.group' : 'assign.byte')}</th>
              {[0, 1, 2, 3, 4, 5, 6, 7].map((b) => (
                <th key={b}>{b}</th>
              ))}
              {timed ? null : (
                <>
                  <th>B</th>
                  <th>W</th>
                  <th>D</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {list.rows.map((r) => (
              <tr key={r.byte} data-testid="assign-row" data-byte={r.byte}>
                <th className={r.beyondLimit || r.unconfigured ? 'baa-assign-beyond' : undefined}>
                  {timed ? `${area}${r.byte * 8}` : `${area}B${r.byte}`}
                  {r.beyondLimit ? ` (${t('assign.beyond')})` : ''}
                  {r.unconfigured ? (
                    <span data-testid="assign-unconfigured"> ({t('assign.unconfigured')})</span>
                  ) : null}
                </th>
                {r.cells.map((c, bit) => {
                  const a = addr(r.byte, bit);
                  const used = c.keys.length > 0;
                  const cls = [
                    'baa-assign-cell',
                    c.access ? `is-${c.access}` : '',
                    c.overlap ? 'is-overlap' : '',
                    !used && c.tags.length === 0 ? 'is-free' : '',
                  ].join(' ');
                  return (
                    <td key={bit}>
                      <button
                        type="button"
                        className={cls}
                        data-testid="assign-cell"
                        data-address={a}
                        data-access={c.access ?? ''}
                        aria-label={label(c, a)}
                        title={label(c, a)}
                        onClick={() => openCrossRef(store, editor.deviceId, a)}
                      >
                        {c.access ? ACCESS_MARK[c.access] : ''}
                        {c.tags.length ? '•' : ''}
                      </button>
                    </td>
                  );
                })}
                {timed
                  ? null
                  : (['B', 'W', 'D'] as const).map((s) => (
                      <td key={s} data-testid={`assign-size-${s}`}>
                        {r.sizes[s] ? ACCESS_MARK[r.sizes[s]!] : ''}
                      </td>
                    ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const ACCESS_MARK = { read: 'R', write: 'W', readWrite: 'RW' } as const;
