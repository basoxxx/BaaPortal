import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { commands } from '../commands/commands';
import { ContextMenu } from '../components/ContextMenu';
import { EDITORS } from '../editors/registry';
import { Icon } from '../icons';
import '../icons/objects';
import '../icons/tree';
import { useAppStore, useServices } from '../state/AppContext';
import type { EditorRef } from '../state/workArea';
import { editorBarItems } from './workarea/editorBarModel';

const BUTTON_WIDTH = 160;

/** Quanti pulsanti stanno nella larghezza misurata; senza misura (0, jsdom) nessun limite. */
function useMaxButtons() {
  const ref = useRef<HTMLDivElement>(null);
  const [max, setMax] = useState(Infinity);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setMax(w > 0 ? Math.floor(w / BUTTON_WIDTH) : Infinity);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, max] as const;
}

/** Barra degli editor: il collegamento alla vista portale e un pulsante per editor aperto. */
export function EditorBar() {
  const { t } = useTranslation();
  const ctx = useServices();
  const { store } = ctx;
  const doc = useAppStore((s) => s.doc);
  const editors = useAppStore((s) => s.workArea.editors);
  const detached = useAppStore((s) => s.workArea.detached);
  const panes = useAppStore((s) => s.workArea.panes);
  const focused = useAppStore((s) => s.workArea.focusedPane);
  const [itemsRef, max] = useMaxButtons();
  const [menu, setMenu] = useState<{ x: number; y: number; keys: string[] } | null>(null);

  const items = useMemo(() => editorBarItems(editors, max), [editors, max]);
  const byKey = new Map(editors.map((e) => [e.key, e]));
  const active = panes[focused];

  const label = (e: EditorRef) => {
    const def = EDITORS[e.kind];
    return doc && def.exists(e, doc) ? def.title(e, doc, t) : '';
  };
  const icon = (e: EditorRef) => (doc ? EDITORS[e.kind].icon(e, doc) : 'objGroup');

  return (
    <div data-testid="editor-bar" className="baa-editor-bar">
      <button
        type="button"
        data-testid="link-portal-view"
        className="baa-link-portal"
        onClick={() => void commands['view.portal'].run(ctx)}
      >
        <span aria-hidden="true">◂ </span>
        {t(commands['view.portal'].labelKey)}
      </button>
      <div className="baa-editor-bar-items" data-testid="editor-bar-items" ref={itemsRef}>
        {items.map((item) => {
          if (item.type === 'group') {
            const first = byKey.get(item.keys[0]!);
            if (!first) return null;
            const name = `${t(`editor.kind.${item.kind}`)} (${item.keys.length})`;
            return (
              <button
                key={`group:${item.kind}`}
                type="button"
                className="baa-editor-tab"
                aria-haspopup="menu"
                aria-pressed={active !== null && item.keys.includes(active)}
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  // La barra è in basso: il menu si apre verso l'alto.
                  setMenu({
                    x: r.left,
                    y: Math.max(0, r.top - item.keys.length * 26 - 8),
                    keys: item.keys,
                  });
                }}
              >
                <Icon name={icon(first)} size={16} />
                <span className="baa-editor-tab-label">{name}</span>
              </button>
            );
          }
          const e = byKey.get(item.key);
          if (!e) return null;
          const inWindow = detached.includes(e.key);
          return (
            <button
              key={e.key}
              type="button"
              className="baa-editor-tab"
              aria-pressed={active === e.key}
              onClick={() => store.getState().activateEditor(e.key)}
            >
              <Icon name={icon(e)} size={16} />
              <span className="baa-editor-tab-label">{label(e)}</span>
              {inWindow ? (
                <span title={t('editor.inWindow')}>
                  <Icon name="editorWindow" size={16} />
                  <span className="baa-sr-only">{t('editor.inWindow')}</span>
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={t('editor.groupMenu')}
          items={menu.keys.flatMap((k) => {
            const e = byKey.get(k);
            return e
              ? [{ id: k, label: label(e), run: () => store.getState().activateEditor(k) }]
              : [];
          })}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}
