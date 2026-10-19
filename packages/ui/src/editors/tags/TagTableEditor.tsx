import { useId, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { EditorRef } from '../../state/workArea';
import { ConstantsView } from './ConstantsView';
import { TagsView } from './TagsView';

type Tab = 'tags' | 'constants';
const TABS: Tab[] = ['tags', 'constants'];

export function TagTableEditor({ editor }: { editor: EditorRef }) {
  const { t } = useTranslation();
  const uid = useId();
  const [tab, setTab] = useState<Tab>('tags');
  const tabId = (id: Tab) => `${uid}-tab-${id}`;
  // Schede WAI-ARIA: frecce, Home e Fine spostano il focus e attivano la scheda.
  const onTabKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.indexOf(tab);
    const next =
      e.key === 'ArrowRight'
        ? (i + 1) % TABS.length
        : e.key === 'ArrowLeft'
          ? (i + TABS.length - 1) % TABS.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? TABS.length - 1
              : -1;
    if (next < 0) return;
    e.preventDefault();
    const id = TABS[next]!;
    setTab(id);
    e.currentTarget.ownerDocument.getElementById(tabId(id))?.focus();
  };
  return (
    <div className="baa-editor-body baa-tags-editor" data-testid={`editor-body-${editor.key}`}>
      <div
        role="tablist"
        aria-label={t('tags.tabs')}
        className="baa-tags-tabs"
        onKeyDown={onTabKeyDown}
      >
        {TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={tabId(id)}
            aria-selected={tab === id}
            aria-controls={`${uid}-panel`}
            tabIndex={tab === id ? 0 : -1}
            className={tab === id ? 'is-active' : undefined}
            onClick={() => setTab(id)}
          >
            {t(`tags.tab.${id}`)}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${uid}-panel`}
        aria-labelledby={tabId(tab)}
        className="baa-tags-panel"
      >
        {tab === 'tags' ? (
          <TagsView deviceId={editor.deviceId} tableId={editor.objectId} />
        ) : (
          <ConstantsView deviceId={editor.deviceId} tableId={editor.objectId} />
        )}
      </div>
    </div>
  );
}
