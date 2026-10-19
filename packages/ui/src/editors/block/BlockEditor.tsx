import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EditorRef } from '../../state/workArea';
import { InterfaceTable } from './InterfaceTable';
import { NetworksView } from './NetworksView';

/** Editor di OB, FB e FC: interfaccia in alto (comprimibile), poi intestazione e segmenti. */
export function BlockEditor({ editor }: { editor: EditorRef }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  return (
    <div className="baa-editor-body baa-block-editor" data-testid={`editor-body-${editor.key}`}>
      <button
        type="button"
        className="baa-block-section-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {t(open ? 'block.collapseInterface' : 'block.expandInterface')}
      </button>
      {open ? (
        <InterfaceTable
          deviceId={editor.deviceId}
          target={{ kind: 'block', id: editor.objectId }}
          label={t('block.gridBlock')}
          valueHeaderKey="block.col.default"
        />
      ) : null}
      <NetworksView deviceId={editor.deviceId} blockId={editor.objectId} />
    </div>
  );
}
