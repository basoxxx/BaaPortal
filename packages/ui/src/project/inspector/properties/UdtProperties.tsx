import { useTranslation } from 'react-i18next';
import { findDevice, findUdt, nextFreeNumber } from '@baaportal/project';
import { useAppStore } from '../../../state/AppContext';
import { useDeviceDiagnostics } from '../../../state/diagnostics';
import { MAX_UDT } from '../../navigation/addActions';
import { ids } from '../../navigation/treeIds';
import { NameField } from './NameField';
import { PropertySection } from './PropertySection';
import { AutoNumberField, TextAreaField, TextField } from './fields';
import { useDeviceEdit, useDiagText } from './useDeviceEdit';

export function UdtProperties({ deviceId, udtId }: { deviceId: string; udtId: string }) {
  const { t } = useTranslation();
  const dev = useAppStore((s) => (s.doc ? findDevice(s.doc.project, deviceId) : undefined));
  const diag = useDiagText(useDeviceDiagnostics(deviceId));
  const edit = useDeviceEdit(deviceId);
  const udt = dev ? findUdt(dev, udtId) : undefined;
  if (!dev || !udt) return <p className="baa-placeholder">{t('inspector.noProperties')}</p>;

  const numberError = (n: number): string | null => {
    if (n < 1 || n > MAX_UDT) return t('addBlock.numberRange', { max: MAX_UDT });
    return dev.udts.some((u) => u.id !== udtId && u.number === n)
      ? t('addBlock.numberTaken')
      : null;
  };
  const setNumber = (n: number) =>
    edit((d) => {
      const u = findUdt(d, udtId);
      if (u) u.number = n;
    });
  const text = (label: string, key: 'author' | 'family' | 'version') => (
    <TextField
      label={label}
      value={udt[key]}
      diag={diag(
        (d) =>
          d.code === 'HEADER_INVALID' &&
          d.property === key &&
          d.ref.kind === 'udt' &&
          d.ref.id === udtId,
      )}
      onCommit={(v) =>
        edit((d) => {
          const u = findUdt(d, udtId);
          if (u) u[key] = v;
        })
      }
    />
  );
  return (
    <div className="baa-prop-panel">
      <PropertySection title={t('props.section.general')}>
        <NameField nodeId={ids.udt(deviceId, udtId)} fallback={udt.name} />
        <AutoNumberField
          label={t('addBlock.number')}
          value={udt.number}
          validate={numberError}
          free={nextFreeNumber(dev, 'UDT', MAX_UDT)}
          onCommit={setNumber}
        />
        <TextAreaField
          label={t('inspector.comment')}
          value={udt.comment}
          onCommit={(v) =>
            edit((d) => {
              const u = findUdt(d, udtId);
              if (u) u.comment = v;
            })
          }
        />
        {text(t('inspector.author'), 'author')}
        {text(t('props.family'), 'family')}
        {text(t('props.version'), 'version')}
      </PropertySection>
    </div>
  );
}
