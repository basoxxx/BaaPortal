import { useTranslation } from 'react-i18next';
import { EDITORS, useEditorInfo } from '../../editors/registry';
import { Icon } from '../../icons';
import '../../icons/objects';
import '../../icons/tree';
import { useServices } from '../../state/AppContext';
import type { EditorRef } from '../../state/workArea';

/** Cornice di un editor: intestazione (icona, percorso, finestra separata, chiudi) e corpo. */
export function EditorFrame({ editor, detached }: { editor: EditorRef; detached?: boolean }) {
  const { t } = useTranslation();
  const { store } = useServices();
  const info = useEditorInfo(editor);
  if (!info) return null;
  const Body = EDITORS[editor.kind].Component;
  const toggleLabel = detached ? t('editor.attach') : t('editor.detach');
  return (
    <section className="baa-editor-frame" data-testid={`editor-frame-${editor.key}`}>
      <header className="baa-editor-header">
        <Icon name={info.icon} size={16} />
        <span className="baa-editor-crumb">{`${info.deviceName} › ${info.title}`}</span>
        <button
          type="button"
          className="baa-panel-btn"
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={() => {
            const s = store.getState();
            if (detached) s.attachEditor(editor.key);
            else s.detachEditor(editor.key);
          }}
        >
          <Icon name="editorWindow" size={16} />
        </button>
        <button
          type="button"
          className="baa-panel-btn"
          aria-label={t('editor.close')}
          title={t('editor.close')}
          onClick={() => store.getState().closeEditor(editor.key)}
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>
      <div className="baa-editor-content">
        <Body editor={editor} />
      </div>
    </section>
  );
}
