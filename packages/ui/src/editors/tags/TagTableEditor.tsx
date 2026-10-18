import { useId, useState } from 'react';
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
  return (
    <div className="baa-editor-body baa-tags-editor" data-testid={`editor-body-${editor.key}`}>
      <div role="tablist" aria-label={t('tags.tabs')} className="baa-tags-tabs">
        {TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`${uid}-tab-${id}`}
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
        aria-labelledby={`${uid}-tab-${tab}`}
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
