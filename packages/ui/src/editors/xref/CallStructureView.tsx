import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callGraph, findDevice, type CallEdge, type CallGraph } from '@baaportal/project';
import { useAppStore, useServices } from '../../state/AppContext';
import type { EditorRef } from '../../state/workArea';
import { locationText } from './CrossRefView';
import { openUse } from './xrefActions';
import './xref.css';

type Mode = 'calls' | 'dependencies';

const byNumber = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

/** Editor «Struttura di richiamo»: dagli OB in giù, o le dipendenze (chi chiama ogni blocco). */
export function CallStructureView({ editor }: { editor: EditorRef }) {
  const { t } = useTranslation();
  const dev = useAppStore((s) => (s.doc ? findDevice(s.doc.project, editor.deviceId) : undefined));
  const g = useMemo(() => (dev ? callGraph(dev) : undefined), [dev]);
  const [mode, setMode] = useState<Mode>('calls');
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  if (!dev || !g) return null;
  const toggle = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  const roots =
    mode === 'calls'
      ? g.roots
      : [...g.blocks.keys()].filter((k) => !k.startsWith('DB')).sort(byNumber);
  return (
    <div className="baa-xref" data-testid="calls-view">
      <div className="baa-xref-bar" role="radiogroup" aria-label={t('callTree.mode')}>
        {(['calls', 'dependencies'] as const).map((m) => (
          <label key={m}>
            <input
              type="radio"
              name={`calls-mode-${editor.deviceId}`}
              checked={mode === m}
              onChange={() => setMode(m)}
            />{' '}
            {t(`callTree.${m}`)}
          </label>
        ))}
      </div>
      {roots.length === 0 ? (
        <p className="baa-placeholder">
          {t(mode === 'calls' ? 'callTree.noOb' : 'callTree.empty')}
        </p>
      ) : (
        <ul className="baa-calls-tree" aria-label={t(`callTree.${mode}`)}>
          {roots.map((k) => (
            <CallNode
              key={k}
              g={g}
              k={k}
              path={[k]}
              mode={mode}
              open={open}
              toggle={toggle}
              deviceId={editor.deviceId}
            />
          ))}
        </ul>
      )}
      {mode === 'calls' && g.unreferenced.length > 0 ? (
        <section>
          <h4>{t('callTree.unreferenced')}</h4>
          <ul className="baa-calls-tree" data-testid="calls-unreferenced">
            {g.unreferenced.map((k) => (
              <CallNode
                key={k}
                g={g}
                k={k}
                path={[k]}
                mode={mode}
                open={open}
                toggle={toggle}
                deviceId={editor.deviceId}
                leaf
              />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function CallNode(p: {
  g: CallGraph;
  k: string;
  path: string[];
  edge?: CallEdge;
  mode: Mode;
  open: ReadonlySet<string>;
  toggle: (path: string) => void;
  deviceId: string;
  leaf?: boolean;
}) {
  const { t } = useTranslation();
  const { store } = useServices();
  const { g, k, path, edge, mode } = p;
  const block = g.blocks.get(k);
  const loop = path.indexOf(k) < path.length - 1;
  const children = p.leaf || loop ? [] : ((mode === 'calls' ? g.calls : g.callers).get(k) ?? []);
  const id = path.join('/');
  const expanded = children.length > 0 && p.open.has(id);
  const name = block?.name ? `${block.name} [${k}]` : k;
  const location = locationText(t);
  return (
    <li data-testid="calls-node" data-key={k}>
      <div className="baa-calls-row">
        {children.length > 0 ? (
          <button
            type="button"
            className="baa-panel-btn"
            aria-expanded={expanded}
            aria-label={t(expanded ? 'callTree.collapse' : 'callTree.expand', { name })}
            onClick={() => p.toggle(id)}
          >
            <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
          </button>
        ) : (
          <span className="baa-calls-spacer" aria-hidden="true" />
        )}
        {block?.blockId ? (
          <button
            type="button"
            className="baa-info-link"
            data-testid="calls-open"
            title={t('callTree.open')}
            onClick={() =>
              store
                .getState()
                .openEditor({ kind: 'block', deviceId: p.deviceId, objectId: block.blockId! })
            }
          >
            {name}
          </button>
        ) : (
          <span>{name}</span>
        )}
        {mode === 'calls' && edge?.use.instance ? (
          <span className="baa-xref-muted">, {edge.use.instance}</span>
        ) : null}
        {edge ? (
          <button
            type="button"
            className="baa-info-link baa-xref-muted"
            title={t('xref.goTo')}
            onClick={() => openUse(store, p.deviceId, edge.use)}
          >
            {location(edge.use)}
          </button>
        ) : null}
        {loop ? <span className="baa-xref-badge">{t('callTree.recursion')}</span> : null}
      </div>
      {expanded ? (
        <ul>
          {children.map((e, i) => {
            const next = mode === 'calls' ? e.callee : e.caller;
            return (
              <CallNode
                key={`${next}|${i}`}
                {...p}
                k={next}
                path={[...path, next]}
                edge={e}
                leaf={false}
              />
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}
