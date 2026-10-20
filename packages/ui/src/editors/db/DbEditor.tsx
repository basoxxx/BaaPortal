import { useTranslation } from 'react-i18next';
import { findDevice } from '@baaportal/project';
import { useAppStore } from '../../state/AppContext';
import type { EditorRef } from '../../state/workArea';
import { InterfaceTable } from '../block/InterfaceTable';
import { instanceFb } from '../block/interfaceRows';
import { isLockedImport, lockedBannerKey } from '../block/readOnlyImport';

/** Editor dei DB globali e di istanza: la tabella dei dati, o l'errore se l'FB dell'istanza manca. */
export function DbEditor({ editor }: { editor: EditorRef }) {
  const { t } = useTranslation();
  const missing = useAppStore((s) => {
    const dev = s.doc ? findDevice(s.doc.project, editor.deviceId) : undefined;
    const b = dev?.blocks.find((x) => x.id === editor.objectId);
    return dev && b?.kind === 'IDB' && !instanceFb(dev, b) ? b.instanceOf : null;
  });
  const lockedBanner = useAppStore((s) => {
    const dev = s.doc ? findDevice(s.doc.project, editor.deviceId) : undefined;
    const b = dev?.blocks.find((x) => x.id === editor.objectId);
    return isLockedImport(b) ? lockedBannerKey(b) : null;
  });
  return (
    <div className="baa-editor-body" data-testid={`editor-body-${editor.key}`}>
      {lockedBanner !== null ? (
        <p className="baa-readonly-banner" role="note" data-testid="readonly-banner">
          {t(lockedBanner)}
        </p>
      ) : null}
      {missing !== null ? (
        <div role="alert" className="baa-block-error">
          {t('block.instanceFbMissing', { name: missing })}
        </div>
      ) : (
        <InterfaceTable
          deviceId={editor.deviceId}
          target={{ kind: 'block', id: editor.objectId }}
          label={t('block.gridDb')}
          valueHeaderKey="block.col.initial"
        />
      )}
    </div>
  );
}
