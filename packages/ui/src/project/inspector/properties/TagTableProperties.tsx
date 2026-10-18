import { useTranslation } from 'react-i18next';
import { findDevice, findTagTable } from '@baaportal/project';
import { useAppStore } from '../../../state/AppContext';
import { ids } from '../../navigation/treeIds';
import { NameField } from './NameField';
import { PropertySection } from './PropertySection';
import { TextField } from './fields';

export function TagTableProperties({ deviceId, tableId }: { deviceId: string; tableId: string }) {
  const { t } = useTranslation();
  const table = useAppStore((s) => {
    const d = s.doc ? findDevice(s.doc.project, deviceId) : undefined;
    return d ? findTagTable(d, tableId) : undefined;
  });
  if (!table) return <p className="baa-placeholder">{t('inspector.noProperties')}</p>;
  return (
    <div className="baa-prop-panel">
      <PropertySection title={t('props.section.general')}>
        <NameField nodeId={ids.tagTable(deviceId, tableId)} fallback={table.name} />
        <TextField label={t('props.group')} value={table.group} />
        <TextField label={t('props.tagCount')} value={String(table.tags.length)} />
        <TextField label={t('props.constantCount')} value={String(table.constants.length)} />
      </PropertySection>
    </div>
  );
}
