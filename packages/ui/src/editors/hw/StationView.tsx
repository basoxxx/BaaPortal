import { useMemo, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  findCpu,
  findIoModule,
  findStation,
  stationModules,
  type ModuleType,
} from '@baaportal/catalog';
import {
  checkHardware,
  deleteStationModule,
  findDevice,
  insertStationModule,
  type PlcDevice,
  type Project,
} from '@baaportal/project';
import { useAppStore, useServices } from '../../state/AppContext';
import type { EditorRef } from '../../state/workArea';
import { ModuleProps } from './DeviceView';
import './hw.css';

const DRAG_NEW = 'application/x-baa-hw-order';
const newId = () => globalThis.crypto.randomUUID();

/** Vista dispositivi di una stazione ET 200 (tappa 6B): i suoi posti e i moduli che accetta. */
export function StationView({ editor }: { editor: EditorRef }) {
  const { t } = useTranslation();
  const { store } = useServices();
  const dev = useAppStore((s) => (s.doc ? findDevice(s.doc.project, editor.deviceId) : undefined));
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const issues = useMemo(() => (dev ? checkHardware(dev, findCpu(dev.cpu.typeId)) : []), [dev]);
  const st = dev?.hardware?.stations?.find((s) => s.id === editor.objectId);
  const type = st && findStation(st.orderNumber);
  if (!dev || !st || !type) return null;

  const edit = (labelKey: string, fn: (d: PlcDevice) => boolean) => {
    let ok = false;
    store.getState().edit(labelKey, (p: Project) => {
      ok = fn(findDevice(p, editor.deviceId)!);
    });
    return ok;
  };
  const slots = Array.from(
    { length: type.lastSlot - type.firstSlot + 1 },
    (_, i) => type.firstSlot + i,
  );
  const insert = (m: ModuleType, slot?: number) => {
    const s = slot ?? slots.find((n) => !st.modules.some((x) => x.slot === n));
    const id = newId();
    if (
      s !== undefined &&
      edit('history.hwInsert', (d) => insertStationModule(d, st.id, m.orderNumber, s, id))
    ) {
      setSelected(id);
      setNotice('');
    } else setNotice(t('hw.noStationSlot', { name: m.name }));
  };
  const remove = (id: string) => {
    if (edit('history.hwDelete', (d) => deleteStationModule(d, st.id, id))) setSelected(null);
  };
  const onDrop = (slot: number) => (e: DragEvent) => {
    e.preventDefault();
    const m = findIoModule(e.dataTransfer.getData(DRAG_NEW));
    if (m) insert(m, slot);
  };
  const sel = st.modules.find((m) => m.id === selected);
  const issuesOf = (id: string) =>
    issues
      .filter((i) => i.moduleId === id)
      .map((i) => t(`diag.${i.code}`, { area: i.area, other: i.other }));

  return (
    <div className="baa-hw" data-testid="station-view">
      <p className="baa-hw-note">
        {st.name} · {type.name} {type.orderNumber} · {t('hw.stationOf', { plc: dev.name })}
      </p>
      {notice ? (
        <p role="status" className="baa-hw-notice">
          {notice}
        </p>
      ) : null}
      <div className="baa-hw-main">
        <ol className="baa-hw-rack" aria-label={st.name} data-testid="hw-rack">
          {slots.map((slot) => {
            const m = st.modules.find((x) => x.slot === slot);
            const bad = m ? issuesOf(m.id).length > 0 : false;
            const label = m?.name ?? t('hw.emptySlot');
            return (
              <li key={slot} onDragOver={(e) => e.preventDefault()} onDrop={onDrop(slot)}>
                <button
                  type="button"
                  className={[
                    'baa-hw-slot',
                    m ? 'is-filled' : '',
                    m && m.id === selected ? 'is-selected' : '',
                    bad ? 'is-error' : '',
                  ].join(' ')}
                  data-testid="hw-slot"
                  data-slot={slot}
                  aria-pressed={m ? m.id === selected : undefined}
                  aria-invalid={bad || undefined}
                  aria-label={`${t('hw.slot')} ${slot}: ${label}`}
                  onClick={() => setSelected(m?.id ?? null)}
                  onKeyDown={(e) => {
                    if (m && e.key === 'Delete') {
                      e.preventDefault();
                      remove(m.id);
                    }
                  }}
                >
                  <span className="baa-hw-slot-n">{slot}</span>
                  <span className="baa-hw-slot-name">{label}</span>
                </button>
              </li>
            );
          })}
        </ol>
        <section className="baa-hw-props" aria-label={t('hw.properties')} data-testid="hw-props">
          <h4>{t('hw.properties')}</h4>
          {sel ? (
            <ModuleProps
              key={sel.id}
              m={sel}
              issues={issuesOf(sel.id)}
              onChange={(labelKey, fn) =>
                edit(labelKey, (d) => {
                  const m = d.hardware?.stations
                    ?.find((x) => x.id === st.id)
                    ?.modules.find((x) => x.id === sel.id);
                  if (m) fn(m);
                  return !!m;
                })
              }
              onDelete={() => remove(sel.id)}
            />
          ) : (
            <p className="baa-placeholder">{t('hw.noSelection')}</p>
          )}
        </section>
        <section className="baa-hw-catalog" aria-label={t('hw.catalog')} data-testid="hw-catalog">
          <h4>{t('hw.catalog')}</h4>
          <p className="baa-xref-muted">{t('hw.insertHint')}</p>
          <ul className="baa-hw-list">
            {stationModules(type).map((m) => (
              <li key={m.orderNumber}>
                <button
                  type="button"
                  data-testid="hw-catalog-item"
                  data-order={m.orderNumber}
                  draggable
                  title={m.description}
                  onDragStart={(e) => e.dataTransfer.setData(DRAG_NEW, m.orderNumber)}
                  onDoubleClick={() => insert(m)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      insert(m);
                    }
                  }}
                >
                  <span>{m.name}</span>
                  <span className="baa-xref-muted">
                    {m.orderNumber} · {m.description}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
