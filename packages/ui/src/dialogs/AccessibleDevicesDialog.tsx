import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PlcAccess } from '@baaportal/project';
import { plcControllerFor } from '../online/plcController';
import { Dialog } from '../components/Dialog';
import { parseAccessInput, parseTsap } from '../online/accessInput';
import type { FoundDevice, NetInterface, PlcScanEvent } from '../online/plcTypes';
import { useAppStore, useServices } from '../state/AppContext';
import { targetPlcId } from '../project/navigation/treeIds';
import './settingsDialog.css';

/** Una riga della tabella: un dispositivo trovato dalla ricerca o un indirizzo scritto a mano. */
interface Row {
  host: string;
  port?: number;
  found?: FoundDevice;
  /** Aggiunta a mano: sopravvive a una nuova ricerca. */
  manual?: boolean;
}

const rowKey = (r: Row): string => (r.port ? `${r.host}:${r.port}` : r.host);
const toInt = (s: string): number | null => (/^\d+$/.test(s.trim()) ? Number(s) : null);

/**
 * «Dispositivi accessibili»: cerca le CPU nella sottorete, permette di aggiungere un indirizzo a
 * mano e di collegarsi. «Collega» salva l'accesso nella CPU scelta (modifica annullabile) ed esegue
 * il comando «Collegati online».
 */
export function AccessibleDevicesDialog({ onClose }: { onClose(): void }) {
  const { t } = useTranslation();
  const { bridge, store } = useServices();
  const projectDevices = useAppStore((s) => s.doc?.project.devices ?? []);
  const ids = {
    iface: useId(),
    type: useId(),
    tsap: useId(),
    rack: useId(),
    slot: useId(),
    cpu: useId(),
    manual: useId(),
  };

  const [interfaces, setInterfaces] = useState<NetInterface[]>([]);
  const [ifaceAddr, setIfaceAddr] = useState('');
  const [kind, setKind] = useState<'direct' | 'gateway'>('direct');
  const [tsap, setTsap] = useState('');
  const [rack, setRack] = useState('0');
  const [slot, setSlot] = useState('2');
  const [cpuId, setCpuId] = useState<string>(() => targetPlcId(store.getState()) ?? '');
  const [rows, setRows] = useState<Row[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [manual, setManual] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  // Il numero della ricerca è noto solo alla risposta di `plcScanStart`, ma gli eventi possono
  // arrivare prima: finché è ignoto si accumulano, poi si tengono solo quelli della ricerca giusta.
  const scanIdRef = useRef<number | null>(null);
  const startingRef = useRef(false);
  const bufferRef = useRef<PlcScanEvent[]>([]);
  const scanningRef = useRef(false);
  scanningRef.current = scanning;

  const apply = (e: PlcScanEvent): void => {
    switch (e.kind) {
      case 'found':
        setRows((rs) =>
          rs.some((r) => r.host === e.device.host && r.port === undefined)
            ? rs.map((r) =>
                r.host === e.device.host && r.port === undefined ? { ...r, found: e.device } : r,
              )
            : [...rs, { host: e.device.host, found: e.device }],
        );
        break;
      case 'progress':
        setProgress({ done: e.done, total: e.total });
        break;
      case 'done':
        setScanning(false);
        scanIdRef.current = null;
        setNotice(
          e.cancelled
            ? t('accessDevices.cancelled')
            : t('accessDevices.finished', { found: e.found }),
        );
        break;
      case 'error':
        setScanning(false);
        scanIdRef.current = null;
        setScanError(e.error);
        break;
    }
  };
  const applyRef = useRef(apply);
  applyRef.current = apply;

  useEffect(() => {
    let alive = true;
    bridge
      .plcInterfaces()
      .then((list) => {
        if (!alive) return;
        setInterfaces(list);
        setIfaceAddr((cur) => cur || (list[0]?.address ?? ''));
      })
      .catch((e: unknown) => {
        if (alive) setScanError(t('accessDevices.errInterfaces', { error: String(e) }));
      });
    const off = bridge.onPlcScanEvent((e) => {
      if (startingRef.current) bufferRef.current.push(e);
      else if (scanIdRef.current === e.scanId) applyRef.current(e);
      // Altrimenti è di una ricerca già sostituita o chiusa: si scarta.
    });
    return () => {
      alive = false;
      off();
      if (scanningRef.current) void bridge.plcScanCancel();
    };
  }, [bridge]);

  const start = async (): Promise<void> => {
    // Una nuova ricerca riparte da zero, ma gli indirizzi scritti a mano restano.
    setRows((rs) =>
      rs
        .filter((r) => r.manual)
        .map((r) => ({
          host: r.host,
          manual: true,
          ...(r.port !== undefined ? { port: r.port } : {}),
        })),
    );
    setNotice(null);
    setScanError(null);
    setProgress(null);
    setScanning(true);
    scanIdRef.current = null;
    bufferRef.current = [];
    startingRef.current = true;
    let r: Awaited<ReturnType<typeof bridge.plcScanStart>>;
    try {
      r = await bridge.plcScanStart(ifaceAddr);
    } catch (e) {
      startingRef.current = false;
      bufferRef.current = [];
      setScanning(false);
      setScanError(String(e));
      return;
    }
    startingRef.current = false;
    const buffered = bufferRef.current;
    bufferRef.current = [];
    if (!r.ok) {
      setScanning(false);
      setScanError(r.error);
      return;
    }
    scanIdRef.current = r.scanId;
    setProgress({ done: 0, total: r.total });
    for (const e of buffered) if (e.scanId === r.scanId) applyRef.current(e);
  };

  const stop = (): void => {
    void bridge.plcScanCancel();
  };

  const addManual = (): void => {
    const r = parseAccessInput(manual);
    if ('error' in r) {
      setManualError(r.error);
      return;
    }
    setManualError(null);
    setManual('');
    const row: Row = {
      host: r.host,
      manual: true,
      ...(r.port !== undefined ? { port: r.port } : {}),
    };
    setRows((rs) => (rs.some((x) => rowKey(x) === rowKey(row)) ? rs : [...rs, row]));
    setSelected(rowKey(row));
  };

  const rackN = toInt(rack);
  const slotN = toInt(slot);
  const rackBad = rackN === null || rackN > 7;
  const slotBad = slotN === null || slotN > 31;
  const tsapN = kind === 'gateway' ? parseTsap(tsap) : null;
  const tsapBad = kind === 'gateway' && tsap.trim() !== '' && tsapN === null;
  const row = rows.find((r) => rowKey(r) === selected);
  const cpu = projectDevices.find((d) => d.id === cpuId) ?? projectDevices[0];
  const canConnect =
    !!row &&
    !!cpu &&
    rackN !== null &&
    rackN <= 7 &&
    slotN !== null &&
    slotN <= 31 &&
    (kind === 'direct' || tsapN !== null);

  const connect = (): void => {
    if (!canConnect || !row || !cpu || rackN === null || slotN === null) return;
    if (store.getState().online.status !== 'off') {
      setConnectError(t('accessDevices.errOnline'));
      return;
    }
    setConnectError(null);
    const access: PlcAccess = {
      host: row.host,
      ...(row.port !== undefined ? { port: row.port } : {}),
      rack: rackN,
      slot: slotN,
      connectionType: 'PG',
      ...(kind === 'gateway' && tsapN !== null ? { remoteTsap: tsapN } : {}),
    };
    store.getState().edit('history.setAccess', (p) => {
      const d = p.devices.find((x) => x.id === cpu.id);
      if (d) d.properties.access = access;
    });
    onClose();
    void plcControllerFor(store, bridge).goOnline(cpu.id);
  };

  const typeText = (r: Row): string =>
    !r.found
      ? t('accessDevices.typeManual')
      : r.found.status === 'cpu'
        ? t('accessDevices.typeCpu')
        : t('accessDevices.typeUnknown');

  return (
    <Dialog
      title={t('accessDevices.title')}
      onClose={onClose}
      onOk={connect}
      okDisabled={!canConnect}
      testId="dialog-access-devices"
      footer={
        <>
          <button type="button" disabled={!canConnect} onClick={connect}>
            {t('accessDevices.connect')}
          </button>
          <button type="button" data-testid="dialog-cancel" onClick={onClose}>
            {t('accessDevices.close')}
          </button>
        </>
      }
    >
      <div className="baa-access">
        {projectDevices.length > 1 ? (
          <label className="baa-settings-row" htmlFor={ids.cpu}>
            <span>{t('accessDevices.cpu')}</span>
            <select id={ids.cpu} value={cpu?.id ?? ''} onChange={(e) => setCpuId(e.target.value)}>
              {projectDevices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="baa-settings-row" htmlFor={ids.iface}>
          <span>{t('accessDevices.interface')}</span>
          <select
            id={ids.iface}
            value={ifaceAddr}
            disabled={scanning}
            onChange={(e) => setIfaceAddr(e.target.value)}
          >
            {interfaces.length === 0 ? (
              <option value="">{t('accessDevices.noInterfaces')}</option>
            ) : null}
            {interfaces.map((i) => (
              <option key={i.address} value={i.address}>
                {i.name} ({i.address})
              </option>
            ))}
          </select>
        </label>
        <label className="baa-settings-row" htmlFor={ids.type}>
          <span>{t('accessDevices.type')}</span>
          <select
            id={ids.type}
            value={kind}
            onChange={(e) => setKind(e.target.value as 'direct' | 'gateway')}
          >
            <option value="direct">{t('accessDevices.direct')}</option>
            <option value="gateway">{t('accessDevices.gateway')}</option>
          </select>
        </label>
        {kind === 'gateway' ? (
          <div className="baa-settings-row">
            <label htmlFor={ids.tsap}>{t('accessDevices.tsap')}</label>
            <span>
              <input
                id={ids.tsap}
                type="text"
                value={tsap}
                placeholder="03.02"
                aria-invalid={tsapBad ? true : undefined}
                onChange={(e) => setTsap(e.target.value)}
              />
              {tsapBad ? (
                <span role="alert" className="baa-field-error">
                  {t('accessDevices.tsapInvalid')}
                </span>
              ) : null}
            </span>
          </div>
        ) : null}
        <div className="baa-access-actions">
          <label htmlFor={ids.rack}>{t('accessDevices.rack')}</label>
          <input
            id={ids.rack}
            type="number"
            min={0}
            max={7}
            value={rack}
            onChange={(e) => setRack(e.target.value)}
          />
          <label htmlFor={ids.slot}>{t('accessDevices.slot')}</label>
          <input
            id={ids.slot}
            type="number"
            min={0}
            max={31}
            value={slot}
            onChange={(e) => setSlot(e.target.value)}
          />
          {rackBad || slotBad ? (
            <span role="alert" className="baa-field-error">
              {t(rackBad ? 'accessDevices.rackInvalid' : 'accessDevices.slotInvalid')}
            </span>
          ) : null}
          <button type="button" disabled={scanning || !ifaceAddr} onClick={() => void start()}>
            {t('accessDevices.start')}
          </button>
          <button type="button" disabled={!scanning} onClick={stop}>
            {t('accessDevices.stop')}
          </button>
          {scanning && progress ? (
            <span role="status">
              {t('accessDevices.progress', { done: progress.done, total: progress.total })}
            </span>
          ) : null}
        </div>
        {connectError ? (
          <p role="alert" className="baa-field-error">
            {connectError}
          </p>
        ) : null}
        {notice ? <p role="status">{notice}</p> : null}
        {scanError ? (
          <p role="alert" className="baa-field-error">
            {scanError}
          </p>
        ) : null}
        <table className="baa-access-table">
          <thead>
            <tr>
              <th>{t('accessDevices.colAddress')}</th>
              <th>{t('accessDevices.colType')}</th>
              <th>{t('accessDevices.colModule')}</th>
              <th>{t('accessDevices.colOrder')}</th>
              <th>{t('accessDevices.colStatus')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5}>{t('accessDevices.empty')}</td>
              </tr>
            ) : null}
            {rows.map((r) => {
              const k = rowKey(r);
              const f = r.found;
              return (
                <tr
                  key={k}
                  aria-selected={k === selected}
                  aria-label={k}
                  tabIndex={0}
                  onClick={() => setSelected(k)}
                  onKeyDown={(e) => {
                    if (e.key === ' ') {
                      e.preventDefault();
                      setSelected(k);
                    }
                  }}
                >
                  <td>{k}</td>
                  <td>{typeText(r)}</td>
                  <td>{f?.status === 'cpu' ? (f.identity.moduleName ?? '') : ''}</td>
                  <td>{f?.status === 'cpu' ? f.identity.orderNumber : ''}</td>
                  <td>
                    {f?.status === 'cpu' ? f.mode : f ? f.reason : t('accessDevices.statusManual')}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="baa-access-actions">
          <label htmlFor={ids.manual}>{t('accessDevices.manual')}</label>
          <input
            id={ids.manual}
            type="text"
            value={manual}
            placeholder={t('accessDevices.manualHint')}
            aria-invalid={manualError ? true : undefined}
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                addManual();
              }
            }}
          />
          <button type="button" onClick={addManual}>
            {t('accessDevices.add')}
          </button>
        </div>
        {manualError ? (
          <p role="alert" className="baa-field-error">
            {t(manualError)}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
