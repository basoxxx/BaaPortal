import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { findDevice, type CodeBlock, type Network, type PlcDevice } from '@baaportal/project';
import { CommitInput, CommitTextarea } from '../../components/CommitField';
import { ContextMenu } from '../../components/ContextMenu';
import { useAppStore, useServices } from '../../state/AppContext';

const newId = () => globalThis.crypto.randomUUID();

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

  if (!block) return null;
  const editHeader = (field: 'title' | 'comment', value: string) =>
    edit('history.editBlockHeader', (b) => {
      b.header[field] = value;
    });
  const only = block.networks.length <= 1;
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
          <div className="baa-network-source" title={t('block.sourceHint')}>
            <CommitTextarea
              value={n.source}
              rows={6}
              aria-label={`${t('block.source')} ${i + 1}`}
              onCommit={(v) => editNetwork(n.id, 'source', v)}
            />
          </div>
        </section>
      ))}
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
