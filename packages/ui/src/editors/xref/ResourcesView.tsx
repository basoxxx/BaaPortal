import { useDeferredValue, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { findCpu } from '@baaportal/catalog';
import {
  assignmentList,
  blockSizes,
  callGraph,
  crossReferences,
  findDevice,
  programResources,
} from '@baaportal/project';
import { useAppStore, useServices } from '../../state/AppContext';
import type { EditorRef } from '../../state/workArea';
import './xref.css';

/** Editor «Risorse»: memoria e dati locali dei blocchi, percorsi di chiamata di ogni OB, aree usate. */
export function ResourcesView({ editor }: { editor: EditorRef }) {
  const { t } = useTranslation();
  const { store } = useServices();
  const dev = useDeferredValue(
    useAppStore((s) => (s.doc ? findDevice(s.doc.project, editor.deviceId) : undefined)),
  );
  const res = useMemo(() => {
    if (!dev) return undefined;
    const cpu = findCpu(dev.cpu.typeId);
    const xref = crossReferences(dev);
    const assign = assignmentList(
      dev,
      xref,
      cpu?.limits ?? { mBytes: 0, timers: 0, counters: 0, inputBytes: 0, outputBytes: 0 },
    );
    return programResources(dev, cpu, blockSizes(dev, cpu), callGraph(dev, xref), assign);
  }, [dev]);
  if (!dev || !res) return null;
  const n = (v: number) => v.toLocaleString();
  return (
    <div className="baa-xref" data-testid="resources-view">
      <p className="baa-xref-muted">{t('resources.estimate')}</p>
      <table className="baa-xref-table">
        <thead>
          <tr>
            <th>{t('resources.block')}</th>
            <th>{t('resources.load')}</th>
            <th>{t('resources.work')}</th>
            <th>{t('resources.local')}</th>
          </tr>
        </thead>
        <tbody>
          {res.blocks.map((b) => (
            <tr key={b.blockId} data-testid="resources-row" data-key={b.key}>
              <td>
                <button
                  type="button"
                  className="baa-info-link"
                  onClick={() =>
                    store
                      .getState()
                      .openEditor({ kind: 'block', deviceId: editor.deviceId, objectId: b.blockId })
                  }
                >
                  {b.name} [{b.key}]
                </button>
              </td>
              {b.size ? (
                <>
                  <td>{n(b.size.load)}</td>
                  <td>{n(b.size.work)}</td>
                  <td>{b.key.startsWith('DB') ? '' : n(b.size.local)}</td>
                </>
              ) : (
                <td colSpan={3} data-testid="resources-uncompiled">
                  {t('resources.uncompiled')}
                </td>
              )}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr data-testid="resources-total">
            <th>{t('resources.total')}</th>
            <th>{n(res.total.load)}</th>
            <th>
              {n(res.total.work)}
              {res.workLimit ? ` / ${n(res.workLimit)}` : ''}
            </th>
            <th />
          </tr>
        </tfoot>
      </table>
      <h4>{t('resources.paths')}</h4>
      {res.obPaths.length === 0 ? (
        <p className="baa-placeholder">{t('callTree.noOb')}</p>
      ) : (
        <table className="baa-xref-table">
          <thead>
            <tr>
              <th>OB</th>
              <th>{t('resources.local')}</th>
              <th>{t('resources.path')}</th>
            </tr>
          </thead>
          <tbody>
            {res.obPaths.map((p) => (
              <tr key={p.ob} data-testid="resources-path" data-ob={p.ob}>
                <td>{p.ob}</td>
                <td>
                  {n(p.bytes)}
                  {res.localLimit ? ` / ${n(res.localLimit)}` : ''}
                  {p.partial ? ` (${t('resources.partial')})` : ''}
                  {p.overLimit ? (
                    <span className="baa-xref-badge" role="alert">
                      {t('resources.overLimit')}
                    </span>
                  ) : null}
                </td>
                <td>{p.path.join(' → ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h4>{t('resources.areas')}</h4>
      <table className="baa-xref-table">
        <tbody>
          {res.areas.map((a) => (
            <tr key={a.area} data-testid="resources-area" data-area={a.area}>
              <td>{t(`assign.areas.${a.area}`)}</td>
              <td>
                {n(a.used)} / {n(a.limit)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
