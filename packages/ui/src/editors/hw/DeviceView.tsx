import { useId, useMemo, useState, type DragEvent, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MAX_RACKS,
  MODULE_CATALOG,
  RACK_SLOTS,
  findCpu,
  findIoModule,
  findModule,
  type ModuleType,
} from '@baaportal/catalog';
import {
  checkHardware,
  deleteModule,
  findDevice,
  firstFreeSlot,
  insertModule,
  moduleAt,
  moveModule,
  type HwIssue,
  type HwModule,
  type PlcDevice,
  type Project,
} from '@baaportal/project';
import { NumberField, TextAreaField, TextField } from '../../project/inspector/properties/fields';
import { useAppStore, useServices } from '../../state/AppContext';
import type { EditorRef } from '../../state/workArea';
import './hw.css';

// Trascinamento: dal catalogo il numero d'articolo, dal rack l'id del modulo.
const DRAG_NEW = 'application/x-baa-hw-order';
const DRAG_MOVE = 'application/x-baa-hw-module';
const SLOTS = Array.from({ length: RACK_SLOTS }, (_, i) => i + 1);
const newId = () => globalThis.crypto.randomUUID();

const range = (start: number | undefined, bytes: number) =>
  start === undefined || bytes === 0 ? '' : `${start}…${start + bytes - 1}`;

/** Editor «Vista dispositivi»: rack S7-300, catalogo hardware, proprietà e panoramica dei moduli. */
export function DeviceView({ editor }: { editor: EditorRef }) {
  const { t } = useTranslation();
  const { store } = useServices();
  const dev = useAppStore((s) => (s.doc ? findDevice(s.doc.project, editor.deviceId) : undefined));
  const [rack, setRack] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [family, setFamily] = useState('');
  const [notice, setNotice] = useState('');
  const noteId = useId();
  const cpu = dev ? findCpu(dev.cpu.typeId) : undefined;
  const issues = useMemo(() => (dev ? checkHardware(dev, cpu) : []), [dev, cpu]);
  if (!dev) return null;

  const edit = (labelKey: string, fn: (d: PlcDevice) => boolean) => {
    let ok = false;
    store.getState().edit(labelKey, (p: Project) => {
      ok = fn(findDevice(p, editor.deviceId)!);
    });
    return ok;
  };
  const insert = (type: ModuleType, slot?: number) => {
    const s = slot ?? firstFreeSlot(dev, type, rack);
    const id = newId();
    if (
      s !== undefined &&
      edit('history.hwInsert', (d) => insertModule(d, type.orderNumber, rack, s, id))
    ) {
      setSelected(id);
      setNotice('');
    } else {
      setNotice(t('hw.noSlot', { name: type.name, rack }));
    }
  };
  const move = (id: string, slot: number) => {
    if (!edit('history.hwMove', (d) => moveModule(d, id, rack, slot))) {
      setNotice(t('hw.cannotMove', { slot }));
    }
  };
  const remove = (id: string) => {
    if (edit('history.hwDelete', (d) => deleteModule(d, id))) setSelected(null);
  };

  const modules = dev.hardware?.modules ?? [];
  const sel = modules.find((m) => m.id === selected);
  const issuesOf = (id: string) => issues.filter((i) => i.moduleId === id);
  const issueText = (i: HwIssue) => t(`diag.${i.code}`, { area: i.area, other: i.other });

  const onDrop = (slot: number) => (e: DragEvent) => {
    e.preventDefault();
    const order = e.dataTransfer.getData(DRAG_NEW);
    const id = e.dataTransfer.getData(DRAG_MOVE);
    const type = order ? findModule(order) : undefined;
    if (type) insert(type, slot);
    else if (id) move(id, slot);
  };
  const onSlotKey = (m: HwModule | undefined) => (e: KeyboardEvent) => {
    if (!m) return;
    if (e.key === 'Delete') {
      e.preventDefault();
      remove(m.id);
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      move(m.id, m.slot + (e.key === 'ArrowLeft' ? -1 : 1));
    }
  };

  const q = search.trim().toLowerCase();
  const families = [...new Set(MODULE_CATALOG.map((m) => m.family))];
  const shown = MODULE_CATALOG.filter(
    (m) =>
      (!family || m.family === family) &&
      (!q || `${m.name} ${m.orderNumber} ${m.description}`.toLowerCase().includes(q)),
  );
  const overview = [...modules].sort((a, b) => a.rack - b.rack || a.slot - b.slot);

  return (
    <div className="baa-hw" data-testid="device-view">
      <div className="baa-hw-bar">
        <div role="radiogroup" aria-label={t('hw.racks')}>
          {Array.from({ length: MAX_RACKS }, (_, r) => (
            <label key={r}>
              <input
                type="radio"
                name={`hw-rack-${editor.deviceId}`}
                checked={rack === r}
                onChange={() => setRack(r)}
              />{' '}
              {t('hw.rack', { n: r })}
            </label>
          ))}
        </div>
        <button type="button" disabled aria-describedby={noteId} data-testid="hw-download">
          {t('hw.download')}
        </button>
      </div>
      <p id={noteId} role="note" className="baa-hw-note">
        {t('hw.downloadDisabled')}
      </p>
      {notice ? (
        <p role="status" className="baa-hw-notice" data-testid="hw-notice">
          {notice}
        </p>
      ) : null}
      <div className="baa-hw-main">
        <div className="baa-hw-left">
          <ol className="baa-hw-rack" aria-label={t('hw.rack', { n: rack })} data-testid="hw-rack">
            {SLOTS.map((slot) => {
              const cpuSlot = rack === 0 && slot === 2;
              const m = moduleAt(dev, rack, slot);
              const type = m ? findModule(m.orderNumber) : undefined;
              const bad = m ? issuesOf(m.id).length > 0 : false;
              const label = cpuSlot
                ? `${cpu?.name ?? dev.cpu.typeId} ${dev.cpu.orderNumber}`
                : (m?.name ?? t('hw.emptySlot'));
              return (
                <li
                  key={slot}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={cpuSlot ? undefined : onDrop(slot)}
                >
                  <button
                    type="button"
                    className={[
                      'baa-hw-slot',
                      m ? 'is-filled' : '',
                      cpuSlot ? 'is-cpu' : '',
                      m && m.id === selected ? 'is-selected' : '',
                      bad ? 'is-error' : '',
                    ].join(' ')}
                    data-testid="hw-slot"
                    data-slot={slot}
                    aria-pressed={m ? m.id === selected : undefined}
                    aria-invalid={bad || undefined}
                    aria-label={`${t('hw.slot')} ${slot}: ${label}`}
                    draggable={!!m}
                    onDragStart={(e) => m && e.dataTransfer.setData(DRAG_MOVE, m.id)}
                    onClick={() => setSelected(m?.id ?? null)}
                    onKeyDown={onSlotKey(m)}
                  >
                    <span className="baa-hw-slot-n">{slot}</span>
                    <span className="baa-hw-slot-name">{label}</span>
                    {type ? <span className="baa-hw-slot-order">{type.orderNumber}</span> : null}
                  </button>
                </li>
              );
            })}
          </ol>
          <h4>{t('hw.overview')}</h4>
          <table className="baa-xref-table" data-testid="hw-overview">
            <thead>
              <tr>
                <th>{t('hw.rackCol')}</th>
                <th>{t('hw.slot')}</th>
                <th>{t('hw.module')}</th>
                <th>{t('hw.orderNumber')}</th>
                <th>{t('hw.iAddr')}</th>
                <th>{t('hw.qAddr')}</th>
                <th>{t('hw.comment')}</th>
              </tr>
            </thead>
            <tbody>
              {overview.map((m) => {
                const type = findModule(m.orderNumber);
                return (
                  <tr
                    key={m.id}
                    data-testid="hw-overview-row"
                    data-slot={`${m.rack}.${m.slot}`}
                    className={m.id === selected ? 'is-selected' : undefined}
                  >
                    <td>{m.rack}</td>
                    <td>{m.slot}</td>
                    <td>
                      <button
                        type="button"
                        className="baa-info-link"
                        onClick={() => {
                          setRack(m.rack);
                          setSelected(m.id);
                        }}
                      >
                        {m.name}
                      </button>
                    </td>
                    <td>{m.orderNumber}</td>
                    <td>{range(m.inputStart, type?.inputBytes ?? 0)}</td>
                    <td>{range(m.outputStart, type?.outputBytes ?? 0)}</td>
                    <td>{m.comment}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <section className="baa-hw-props" aria-label={t('hw.properties')} data-testid="hw-props">
          <h4>{t('hw.properties')}</h4>
          {sel ? (
            <ModuleProps
              key={sel.id}
              m={sel}
              issues={issuesOf(sel.id).map(issueText)}
              onChange={(labelKey, fn) =>
                edit(labelKey, (d) => {
                  const m = d.hardware?.modules.find((x) => x.id === sel.id);
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
          <input
            type="search"
            aria-label={t('hw.search')}
            placeholder={t('hw.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            aria-label={t('hw.family')}
            value={family}
            onChange={(e) => setFamily(e.target.value)}
          >
            <option value="">{t('hw.allFamilies')}</option>
            {families.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <p className="baa-xref-muted">{t('hw.insertHint')}</p>
          <ul className="baa-hw-list">
            {shown.map((m) => (
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

export function ModuleProps(p: {
  m: HwModule;
  issues: string[];
  onChange(labelKey: string, fn: (m: HwModule) => void): void;
  onDelete(): void;
}) {
  const { t } = useTranslation();
  const type = findIoModule(p.m.orderNumber);
  const start = (key: 'inputStart' | 'outputStart', bytes: number, label: string) => {
    const v = p.m[key];
    return v === undefined || bytes === 0 ? null : (
      <NumberField
        label={label}
        value={v}
        validate={(n) => (n < 0 ? t('hw.negative') : null)}
        onCommit={(n) => p.onChange('history.hwEdit', (m) => void (m[key] = n))}
      />
    );
  };
  return (
    <div className="baa-props">
      <TextField label={t('hw.orderNumber')} value={p.m.orderNumber} />
      <TextField label={t('hw.description')} value={type?.description ?? ''} />
      <TextField
        label={t('hw.name')}
        value={p.m.name}
        onCommit={(v) => p.onChange('history.hwEdit', (m) => void (m.name = v))}
      />
      {start('inputStart', type?.inputBytes ?? 0, t('hw.inputStart'))}
      {start('outputStart', type?.outputBytes ?? 0, t('hw.outputStart'))}
      <TextAreaField
        label={t('hw.comment')}
        value={p.m.comment}
        onCommit={(v) => p.onChange('history.hwEdit', (m) => void (m.comment = v))}
      />
      {p.issues.length ? (
        <ul className="baa-hw-issues" role="alert" data-testid="hw-issues">
          {p.issues.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      ) : null}
      <button type="button" onClick={p.onDelete} data-testid="hw-delete">
        {t('hw.delete')}
      </button>
    </div>
  );
}
