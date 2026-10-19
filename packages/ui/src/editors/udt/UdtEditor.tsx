import { useTranslation } from 'react-i18next';
import type { EditorRef } from '../../state/workArea';
import { InterfaceTable } from '../block/InterfaceTable';

export function UdtEditor({ editor }: { editor: EditorRef }) {
  const { t } = useTranslation();
  return (
    <div className="baa-editor-body" data-testid={`editor-body-${editor.key}`}>
      <InterfaceTable
        deviceId={editor.deviceId}
        target={{ kind: 'udt', id: editor.objectId }}
        label={t('block.gridUdt')}
        valueHeaderKey="block.col.default"
      />
    </div>
  );
}
