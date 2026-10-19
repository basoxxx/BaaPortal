import { useTranslation } from 'react-i18next';
import { findCpu, findCpuByOrderNumber } from '@baaportal/catalog';
import { findDevice } from '@baaportal/project';
import { useAppStore } from '../../../state/AppContext';
import { useDeviceDiagnostics } from '../../../state/diagnostics';
import { ids } from '../../navigation/treeIds';
import { NameField } from './NameField';
import { PropertySection } from './PropertySection';
import { CheckField, NumberField, TextAreaField, TextField } from './fields';
import { useDeviceEdit, useDiagText } from './useDeviceEdit';

export function PlcProperties({ deviceId }: { deviceId: string }) {
  const { t } = useTranslation();
  const dev = useAppStore((s) => (s.doc ? findDevice(s.doc.project, deviceId) : undefined));
  const diag = useDiagText(useDeviceDiagnostics(deviceId));
  const edit = useDeviceEdit(deviceId);
  if (!dev) return <p className="baa-placeholder">{t('inspector.noProperties')}</p>;

  const p = dev.properties;
  const cpu = findCpu(dev.cpu.typeId);
  const firmware = findCpuByOrderNumber(dev.cpu.orderNumber)?.version.firmware ?? [];
  const firmwareOptions = firmware.includes(dev.cpu.firmware)
    ? firmware
    : [dev.cpu.firmware, ...firmware];
  const bad = (property: string) =>
    diag((d) => d.code === 'PROPERTY_INVALID' && d.property === property);
  // Dove la CPU non è nel catalogo, le interfacce seguono ciò che il modello contiene.
  const hasPn = p.pn !== undefined && (cpu?.interfaces.pn ?? true);
  const hasDp = p.dpAddress !== undefined && (cpu?.interfaces.dp ?? true);
  const num = (label: string, property: string, value: number, set: (n: number) => void) => (
    <NumberField label={label} value={value} diag={bad(property)} onCommit={set} />
  );
  const fwId = 'plc-firmware';

  return (
    <div className="baa-prop-panel">
      <p role="note" className="baa-prop-note">
        {t('props.banner')}
      </p>
      <PropertySection title={t('props.section.general')}>
        <NameField nodeId={ids.plc(deviceId)} fallback={dev.name} />
        <TextAreaField
          label={t('inspector.comment')}
          value={p.comment}
          onCommit={(v) => edit((d) => void (d.properties.comment = v))}
        />
        <TextField label={t('props.orderNumber')} value={dev.cpu.orderNumber} />
        <label htmlFor={fwId}>{t('props.firmware')}</label>
        <select
          id={fwId}
          value={dev.cpu.firmware}
          onChange={(e) => edit((d) => void (d.cpu.firmware = e.target.value))}
        >
          {firmwareOptions.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </PropertySection>
      {hasPn && p.pn ? (
        <PropertySection title={t('props.section.pn')}>
          <TextField
            label={t('props.ip')}
            value={p.pn.ipAddress}
            diag={bad('pn.ipAddress')}
            onCommit={(v) => edit((d) => void (d.properties.pn!.ipAddress = v))}
          />
          <TextField
            label={t('props.mask')}
            value={p.pn.subnetMask}
            diag={bad('pn.subnetMask')}
            onCommit={(v) => edit((d) => void (d.properties.pn!.subnetMask = v))}
          />
          <CheckField
            label={t('props.useRouter')}
            checked={p.pn.useRouter}
            onChange={(v) => edit((d) => void (d.properties.pn!.useRouter = v))}
          />
          <TextField
            label={t('props.router')}
            value={p.pn.routerAddress}
            disabled={!p.pn.useRouter}
            diag={bad('pn.routerAddress')}
            onCommit={(v) => edit((d) => void (d.properties.pn!.routerAddress = v))}
          />
        </PropertySection>
      ) : null}
      <PropertySection title={t('props.section.mpi')}>
        {num(t('props.mpiAddress'), 'mpiAddress', p.mpiAddress, (n) =>
          edit((d) => void (d.properties.mpiAddress = n)),
        )}
      </PropertySection>
      {hasDp ? (
        <PropertySection title={t('props.section.dp')}>
          {num(t('props.dpAddress'), 'dpAddress', p.dpAddress ?? 0, (n) =>
            edit((d) => void (d.properties.dpAddress = n)),
          )}
        </PropertySection>
      ) : null}
      <PropertySection title={t('props.section.cycle')}>
        {num(t('props.maxCycle'), 'cycle.maxCycleMs', p.cycle.maxCycleMs, (n) =>
          edit((d) => void (d.properties.cycle.maxCycleMs = n)),
        )}
        {num(t('props.minCycle'), 'cycle.minCycleMs', p.cycle.minCycleMs, (n) =>
          edit((d) => void (d.properties.cycle.minCycleMs = n)),
        )}
        {num(t('props.commLoad'), 'cycle.commLoadPercent', p.cycle.commLoadPercent, (n) =>
          edit((d) => void (d.properties.cycle.commLoadPercent = n)),
        )}
      </PropertySection>
      <PropertySection title={t('props.section.clock')}>
        <CheckField
          label={t('props.clockEnabled')}
          checked={p.clockMemory.enabled}
          onChange={(v) => edit((d) => void (d.properties.clockMemory.enabled = v))}
        />
        {num(t('props.clockByte'), 'clockMemory.byte', p.clockMemory.byte, (n) =>
          edit((d) => void (d.properties.clockMemory.byte = n)),
        )}
      </PropertySection>
      <PropertySection title={t('props.section.retentivity')}>
        {num(t('props.retM'), 'retentivity.mBytes', p.retentivity.mBytes, (n) =>
          edit((d) => void (d.properties.retentivity.mBytes = n)),
        )}
        {num(t('props.retT'), 'retentivity.timers', p.retentivity.timers, (n) =>
          edit((d) => void (d.properties.retentivity.timers = n)),
        )}
        {num(t('props.retC'), 'retentivity.counters', p.retentivity.counters, (n) =>
          edit((d) => void (d.properties.retentivity.counters = n)),
        )}
      </PropertySection>
      <PropertySection title={t('props.section.schedule')}>
        {num(t('props.ob35'), 'cyclicInterrupts.ob35Ms', p.cyclicInterrupts.ob35Ms, (n) =>
          edit((d) => void (d.properties.cyclicInterrupts.ob35Ms = n)),
        )}
      </PropertySection>
    </div>
  );
}
