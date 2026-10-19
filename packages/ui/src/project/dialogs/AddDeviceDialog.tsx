import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { CPU_CATALOG, findCpu, type CpuType } from '@baaportal/catalog';
import { createPlcDevice, uniqueName } from '@baaportal/project';
import { sameName, validateS7Name } from '@baaportal/s7-types';
import { Dialog } from '../../components/Dialog';
import { Icon } from '../../icons';
import '../../icons/objects';
import { useServices } from '../../state/AppContext';
import { ids } from '../navigation/treeIds';

const GROUPS: CpuType['group'][] = ['standard', 'compact', 'failsafe'];

/** Riga dell'albero del catalogo: le intestazioni non si scelgono, CPU e numeri di articolo sì. */
interface CatalogRow {
  key: string;
  level: number;
  label: string;
  pick?: { cpuId: string; orderNumber: string };
}

function catalogRows(t: (k: string) => string): CatalogRow[] {
  const rows: CatalogRow[] = [
    { key: 'h:controllers', level: 1, label: t('addDevice.controllers') },
    { key: 'h:family', level: 2, label: t('addDevice.family') },
    { key: 'h:cpu', level: 3, label: t('addDevice.cpu') },
  ];
  for (const g of GROUPS) {
    rows.push({ key: `h:${g}`, level: 4, label: t(`addDevice.group.${g}`) });
    for (const cpu of CPU_CATALOG.filter((c) => c.group === g)) {
      const first = cpu.versions[0];
      if (!first) continue;
      rows.push({
        key: `cpu:${cpu.id}`,
        level: 5,
        label: cpu.name,
        pick: { cpuId: cpu.id, orderNumber: first.orderNumber },
      });
      for (const v of cpu.versions) {
        rows.push({
          key: `order:${cpu.id}:${v.orderNumber}`,
          level: 6,
          label: v.orderNumber,
          pick: { cpuId: cpu.id, orderNumber: v.orderNumber },
        });
      }
    }
  }
  return rows;
}

const DEFAULT_CPU = 'cpu-315-2-pn-dp';

export function AddDeviceDialog({ onClose }: { onClose(): void }) {
  const { t } = useTranslation();
  const { store } = useServices();
  const nameId = useId();
  const fwId = useId();
  const devices = store.getState().doc?.project.devices ?? [];
  const rows = useMemo(() => catalogRows((k) => t(k)), [t]);

  const initialCpu = findCpu(DEFAULT_CPU) ?? CPU_CATALOG[0]!;
  // La riga scelta (CPU o numero di articolo); da essa si ricavano CPU e numero.
  const [selKey, setSelKey] = useState(`cpu:${initialCpu.id}`);
  const [firmware, setFirmware] = useState('');
  const [name, setName] = useState(() =>
    uniqueName(
      t('defaults.plc'),
      devices.map((d) => d.name),
    ),
  );

  const selectedRow = rows.find((r) => r.key === selKey);
  const sel = selectedRow?.pick ?? {
    cpuId: initialCpu.id,
    orderNumber: initialCpu.versions[0]?.orderNumber ?? '',
  };
  const cpu = findCpu(sel.cpuId) ?? initialCpu;
  const firmwareList = cpu.versions.find((v) => v.orderNumber === sel.orderNumber)?.firmware ?? [];
  const fw = firmwareList.includes(firmware) ? firmware : (firmwareList[0] ?? '');

  const trimmed = name.trim();
  // Stesse regole della rinomina nell'albero e nella finestra di ispezione.
  const nameError =
    trimmed === ''
      ? t('addDevice.nameEmpty')
      : !validateS7Name(trimmed).ok
        ? t('objects.errInvalid')
        : devices.some((d) => sameName(d.name, trimmed))
          ? t('addDevice.nameExists')
          : null;

  const focusPending = useRef(false);
  const treeRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!focusPending.current) return;
    focusPending.current = false;
    treeRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }, [selKey]);

  const onTreeKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const pickable = rows.filter((r) => r.pick);
    const i = pickable.findIndex((r) => r.key === selKey);
    const next = pickable[i + (e.key === 'ArrowDown' ? 1 : -1)];
    if (next) {
      focusPending.current = true;
      setSelKey(next.key);
    }
    e.preventDefault();
  };

  const submit = () => {
    if (nameError) return;
    const device = createPlcDevice({
      cpu,
      orderNumber: sel.orderNumber,
      firmware: fw,
      name: trimmed,
      texts: { defaultTagTable: t('defaults.defaultTagTable') },
    });
    store.getState().edit('history.addDevice', (p) => {
      p.devices.push(device);
    });
    const s = store.getState();
    if (s.view === 'portal') s.setView('project');
    s.select(ids.plc(device.id));
    onClose();
  };

  const interfaces = [
    cpu.interfaces.mpi ? 'MPI' : '',
    cpu.interfaces.dp ? 'PROFIBUS DP' : '',
    cpu.interfaces.pn ? 'PROFINET' : '',
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <Dialog
      title={t('addDevice.title')}
      onClose={onClose}
      onOk={submit}
      okDisabled={nameError !== null}
      testId="dialog-add-device"
    >
      <div className="baa-dialog-side">
        <ul
          role="tree"
          aria-label={t('addDevice.catalog')}
          className="baa-dialog-list"
          ref={treeRef}
          onKeyDown={onTreeKey}
        >
          {rows.map((r) => {
            const selected = r.key === selKey;
            return (
              <li
                key={r.key}
                role="treeitem"
                aria-level={r.level}
                aria-selected={r.pick ? selected : undefined}
                data-heading={r.pick ? undefined : 'true'}
                data-testid={`catalog-${r.key}`}
                tabIndex={selected ? 0 : -1}
                style={{ paddingLeft: 6 + (r.level - 1) * 14 }}
                onClick={() => r.pick && setSelKey(r.key)}
              >
                {r.level === 5 ? <Icon name="objCpu" size={16} /> : null}
                {r.label}
              </li>
            );
          })}
        </ul>
      </div>
      <div className="baa-dialog-form">
        <div className="baa-dialog-field">
          <label htmlFor={nameId}>{t('addDevice.name')}</label>
          <input
            id={nameId}
            type="text"
            value={name}
            aria-invalid={nameError ? true : undefined}
            onChange={(e) => setName(e.target.value)}
          />
          {nameError ? (
            <span role="alert" className="baa-field-error">
              {nameError}
            </span>
          ) : null}
        </div>
        <div className="baa-dialog-fact">
          <div>
            {t('addDevice.cpuName')}: {cpu.name}
          </div>
          <div>
            {t('addDevice.orderNumber')}: {sel.orderNumber}
          </div>
          <div>
            {t('addDevice.workMemory')}: {cpu.workMemoryKB} KB
          </div>
          <div>
            {t('addDevice.interfaces')}: {interfaces}
          </div>
        </div>
        <div className="baa-dialog-field">
          <label htmlFor={fwId}>{t('addDevice.firmware')}</label>
          <select id={fwId} value={fw} onChange={(e) => setFirmware(e.target.value)}>
            {firmwareList.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
      </div>
    </Dialog>
  );
}
