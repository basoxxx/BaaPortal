import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { checkBlockCode, completeAt, type AwlDiagnostic, type Mnemonic } from '@baaportal/awl';
import { findCpu } from '@baaportal/catalog';
import {
  createAwlContext,
  findDevice,
  type CodeBlock,
  type Network,
  type PlcDevice,
} from '@baaportal/project';
import { CommitInput, CommitTextarea } from '../../components/CommitField';
import { ContextMenu } from '../../components/ContextMenu';
import { AwlEditor, type AwlEditorHandle } from '../awl/AwlEditor';
import { displayText } from '../awl/awlExtensions';
import { useMnemonic } from '../awl/mnemonicPreference';
import { useAppStore, useServices } from '../../state/AppContext';

const newId = () => globalThis.crypto.randomUUID();
const CHECK_DELAY_MS = 250;
const NO_DIAGNOSTICS: AwlDiagnostic[] = [];
const shown = displayText;

/** Testo non ancora confermato di un segmento, valido finché sorgente e mnemonica sono quelli da cui parte. */
interface Draft {
  base: string;
  mnemonic: Mnemonic;
  text: string;
}

interface Props {
  deviceId: string;
  blockId: string;
}

export function NetworksView({ deviceId, blockId }: Props) {
  const { t } = useTranslation();
  const { store } = useServices();
  const block = useAppStore((s) => {
    const dev = s.doc ? findDevice(s.doc.project, deviceId) : undefined;
    const b = dev?.blocks.find((x) => x.id === blockId);
    return b && b.kind !== 'DB' && b.kind !== 'IDB' ? b : undefined;
  });
  const dev = useAppStore((s) => (s.doc ? findDevice(s.doc.project, deviceId) : undefined));
  const [mnemonic, setMnemonic] = useMnemonic();
  const isAwl = block?.language === 'AWL';
  // Il contesto del controllo si rifà a ogni revisione del dispositivo, non a ogni tasto.
  const awlCtx = useMemo(
    () => (dev && isAwl ? createAwlContext(dev, blockId, findCpu(dev.cpu.typeId)) : null),
    [dev, blockId, isAwl],
  );
  const drafts = useRef(new Map<string, Draft>());
  const handles = useRef(new Map<string, AwlEditorHandle>());
  // Le diagnostiche di ogni segmento: un segmento che non cambia tiene lo stesso array, e il suo editor non ricalcola.
  const [byNetwork, setByNetwork] = useState<AwlDiagnostic[][]>([]);
  const problems = useMemo(() => byNetwork.flat(), [byNetwork]);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; anchor: Element } | null>(
    null,
  );

  const edit = useCallback(
    (labelKey: string, recipe: (block: CodeBlock, dev: PlcDevice) => void) =>
      store.getState().edit(labelKey, (p) => {
        const dev = findDevice(p, deviceId);
        const b = dev?.blocks.find((x) => x.id === blockId);
        if (dev && b && b.kind !== 'DB' && b.kind !== 'IDB') recipe(b, dev);
      }),
    [store, deviceId, blockId],
  );
  const editNetwork = (id: string, field: 'title' | 'comment' | 'source', value: string) =>
    edit('history.editNetwork', (b) => {
      const n = b.networks.find((x) => x.id === id);
      if (n) n[field] = value;
    });
  const insert = () =>
    edit('history.addNetwork', (b) => {
      const fresh: Network = { id: newId(), title: '', comment: '', source: '' };
      const at = b.networks.findIndex((x) => x.id === focusedId);
      b.networks.splice(at < 0 ? b.networks.length : at + 1, 0, fresh);
    });
  const remove = (id: string) =>
    edit('history.deleteNetwork', (b) => {
      if (b.networks.length > 1) b.networks = b.networks.filter((x) => x.id !== id);
    });

  const networks = block?.networks;
  /** I testi mostrati di tutti i segmenti, con la bozza al posto del testo salvato. */
  const textsShown = (override?: { index: number; text: string }): string[] =>
    (networks ?? []).map((n, i) => {
      if (override && override.index === i) return override.text;
      const d = drafts.current.get(n.id);
      return d && d.base === n.source && d.mnemonic === mnemonic
        ? d.text
        : shown(n.source, mnemonic);
    });
  // Il controllo gira 250 ms dopo l'ultima modifica; le bozze stanno in un ref, quindi scrivere non ridisegna i segmenti.
  const latest = useRef({ awlCtx, networks, mnemonic, textsShown });
  useEffect(() => {
    latest.current = { awlCtx, networks, mnemonic, textsShown };
  });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleCheck = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const l = latest.current;
      const next: AwlDiagnostic[][] = (l.networks ?? []).map(() => []);
      if (l.awlCtx && l.networks) {
        for (const d of checkBlockCode(l.textsShown(), l.awlCtx, l.mnemonic))
          next[d.network]?.push(d);
      }
      setByNetwork((prev) => {
        const merged = next.map((arr, i) =>
          prev[i] && JSON.stringify(prev[i]) === JSON.stringify(arr) ? prev[i]! : arr,
        );
        const same = merged.length === prev.length && merged.every((a, i) => a === prev[i]);
        return same ? prev : merged;
      });
    }, CHECK_DELAY_MS);
  }, []);
  useEffect(() => {
    scheduleCheck();
  }, [awlCtx, networks, mnemonic, scheduleCheck]);
  useEffect(() => () => clearTimeout(timer.current), []);

  if (!block) return null;
  const editHeader = (field: 'title' | 'comment', value: string) =>
    edit('history.editBlockHeader', (b) => {
      b.header[field] = value;
    });
  const only = block.networks.length <= 1;
  const onDraft = (n: Network, text: string) => {
    if (text === shown(n.source, mnemonic)) drafts.current.delete(n.id);
    else drafts.current.set(n.id, { base: n.source, mnemonic, text });
    scheduleCheck();
  };
  const commitCode = (id: string, stored: string) => {
    drafts.current.delete(id);
    edit('history.editNetworkCode', (b) => {
      const n = b.networks.find((x) => x.id === id);
      if (n) n.source = stored;
    });
  };
  return (
    <div className="baa-block-networks">
      <div className="baa-block-header">
        <label>
          <span>{t('block.title')}</span>
          <CommitInput
            value={block.header.title}
            aria-label={t('block.title')}
            onCommit={(v) => editHeader('title', v)}
          />
        </label>
        {isAwl ? (
          <label className="baa-awl-mnemonic">
            <span>{t('block.mnemonic')}</span>
            <select value={mnemonic} onChange={(e) => setMnemonic(e.target.value as Mnemonic)}>
              <option value="international">{t('block.mnemonicInternational')}</option>
              <option value="german">{t('block.mnemonicGerman')}</option>
            </select>
          </label>
        ) : null}
        <label>
          <span>{t('block.comment')}</span>
          <CommitTextarea
            value={block.header.comment}
            rows={2}
            aria-label={t('block.comment')}
            onCommit={(v) => editHeader('comment', v)}
          />
        </label>
      </div>
      <h4 className="baa-block-networks-title">{t('block.networks')}</h4>
      {block.networks.map((n, i) => (
        <section
          key={n.id}
          className="baa-network"
          aria-label={t('block.network', { n: i + 1 })}
          onFocus={() => setFocusedId(n.id)}
        >
          <header className="baa-network-head">
            <strong>{t('block.network', { n: i + 1 })}</strong>
            <CommitInput
              value={n.title}
              aria-label={`${t('block.networkTitle')} ${i + 1}`}
              onCommit={(v) => editNetwork(n.id, 'title', v)}
            />
            <button
              type="button"
              className="baa-panel-btn"
              aria-label={`${t('block.networkMenu')} ${i + 1}`}
              aria-haspopup="menu"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMenu({ id: n.id, x: r.left, y: r.bottom, anchor: e.currentTarget });
              }}
            >
              <span aria-hidden="true">⋯</span>
            </button>
          </header>
          <CommitTextarea
            value={n.comment}
            rows={1}
            aria-label={`${t('block.networkComment')} ${i + 1}`}
            onCommit={(v) => editNetwork(n.id, 'comment', v)}
          />
          {isAwl ? (
            <div className="baa-network-source">
              <AwlEditor
                value={n.source}
                mnemonic={mnemonic}
                aria-label={`${t('block.source')} ${i + 1}`}
                diagnostics={byNetwork[i] ?? NO_DIAGNOSTICS}
                complete={(offset, text) =>
                  awlCtx
                    ? completeAt(textsShown({ index: i, text }), i, offset, awlCtx, mnemonic)
                    : { from: offset, options: [] }
                }
                onChange={(text) => onDraft(n, text)}
                onCommit={(stored) => commitCode(n.id, stored)}
                ref={(h) => {
                  if (h) handles.current.set(n.id, h);
                  else handles.current.delete(n.id);
                }}
              />
            </div>
          ) : (
            <div className="baa-network-source" title={t('block.sourceHint')}>
              <CommitTextarea
                value={n.source}
                rows={6}
                aria-label={`${t('block.source')} ${i + 1}`}
                onCommit={(v) => editNetwork(n.id, 'source', v)}
              />
            </div>
          )}
        </section>
      ))}
      {isAwl ? (
        <section className="baa-awl-problems-panel" aria-label={t('block.awlProblems')}>
          <h4 className="baa-block-networks-title">{t('block.awlProblems')}</h4>
          {problems.length === 0 ? (
            <p className="baa-prop-note">{t('block.awlNoProblems')}</p>
          ) : null}
          <ul
            className="baa-awl-problems"
            aria-label={t('block.awlProblems')}
            hidden={problems.length === 0}
          >
            {problems.map((d, k) => (
              <li key={k}>
                <button
                  type="button"
                  className={`is-${d.severity}`}
                  onClick={() => {
                    const n = block.networks[d.network];
                    if (n) handles.current.get(n.id)?.focusAt(d.range.from.offset);
                  }}
                >
                  {t('block.awlProblemRow', {
                    n: d.network + 1,
                    line: d.range.from.line + 1,
                    message: t(`awl.diag.${d.code}`, d.params ?? {}),
                  })}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <button type="button" className="baa-block-insert" onClick={insert}>
        {t('block.insertNetwork')}
      </button>
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          anchor={menu.anchor}
          label={t('block.networkMenu')}
          items={[
            {
              id: 'delete',
              label: t('block.deleteNetwork'),
              disabled: only,
              run: () => remove(menu.id),
            },
          ]}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}
