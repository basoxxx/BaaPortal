import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  configuredAccess,
  MPI_BUS_SPEEDS,
  MPI_HIGHEST_ADDRESSES,
  type MpiLink,
  type PlcAccess,
} from '@baaportal/project';
import { plcControllerFor } from '../online/plcController';
import { uploadFromDevice } from '../online/uploadProject';
import { Dialog } from '../components/Dialog';
import { parseAccessInput, parseTsap } from '../online/accessInput';
import type { FoundDevice, NetInterface, PlcScanEvent, SerialPortInfo } from '../online/plcTypes';
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

/** Riferimento stabile: senza progetto il selettore non deve dare un array nuovo a ogni lettura. */
const NO_DEVICES: never[] = [];

const rowKey = (r: Row): string => (r.port ? `${r.host}:${r.port}` : r.host);
const toInt = (s: string): number | null => (/^\d+$/.test(s.trim()) ? Number(s) : null);
/** Velocità della porta seriale proposte; il PC Adapter usa di solito 38400 o 19200. */
const BAUD_RATES = [9600, 19200, 38400, 57600, 115200];

/**
 * «Dispositivi accessibili»: cerca le CPU nella sottorete, permette di aggiungere un indirizzo a
 * mano e di collegarsi. «Collega» salva l'accesso nella CPU scelta (modifica annullabile) ed esegue
 * il comando «Collegati online».
 */
export function AccessibleDevicesDialog({ onClose }: { onClose(): void }) {
  const { t } = useTranslation();
  const { bridge, store, service } = useServices();
  const projectDevices = useAppStore((s) => s.doc?.project.devices ?? NO_DEVICES);
  const ids = {
    iface: useId(),
    type: useId(),
    tsap: useId(),
    rack: useId(),
    slot: useId(),
    cpu: useId(),
    manual: useId(),
    link: useId(),
    serial: useId(),
    baud: useId(),
    parity: useId(),
    mpiCpu: useId(),
    mpiLocal: useId(),
    hsa: useId(),
    bus: useId(),
    variant: useId(),
  };

  const [linkKind, setLinkKind] = useState<'tcp' | 'mpi'>('tcp');
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [mpi, setMpi] = useState<Omit<MpiLink, 'cpuAddress' | 'localAddress'>>({
    kind: 'mpi',
    port: '',
    baudRate: 38400,
    parity: 'odd',
    highestAddress: 31,
    busSpeed: '187.5k',
    variant: 'auto',
  });
  const [mpiCpu, setMpiCpu] = useState('2');
  const [mpiLocal, setMpiLocal] = useState('0');
  const [mpiNodes, setMpiNodes] = useState<number[] | null>(null);
  const [mpiSearching, setMpiSearching] = useState(false);
  const [mpiError, setMpiError] = useState<string | null>(null);

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
  const [uploading, setUploading] = useState<
    { done: number; total: number; current: string } | 'starting' | null
  >(null);
  const uploadingRef = useRef(false);

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

  const loadPorts = (): void => {
    setMpiError(null);
    bridge
      .plcSerialPorts()
      .then((list) => {
        setPorts(list);
        setMpi((m) =>
          list.some((p) => p.path === m.port) ? m : { ...m, port: list[0]?.path ?? '' },
        );
      })
      .catch((e: unknown) => setMpiError(t('accessDevices.errSerialPorts', { error: String(e) })));
  };
  useEffect(() => {
    if (linkKind === 'mpi') loadPorts();
  }, [linkKind]);

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
    const offUpload = bridge.onPlcUploadProgress((p) => {
      if (uploadingRef.current) setUploading(p);
    });
    const off = bridge.onPlcScanEvent((e) => {
      if (startingRef.current) bufferRef.current.push(e);
      else if (scanIdRef.current === e.scanId) applyRef.current(e);
      // Altrimenti è di una ricerca già sostituita o chiusa: si scarta.
    });
    return () => {
      alive = false;
      off();
      offUpload();
      if (scanningRef.current) void bridge.plcScanCancel();
      if (uploadingRef.current) void bridge.plcUploadCancel();
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
  // Indirizzo della CPU dalla vista di rete (solo lettura del progetto).
  const openProject = useAppStore((s) => s.doc?.project);
  const configured = openProject && cpu ? configuredAccess(openProject, cpu.id) : undefined;
  const configuredText = linkKind === 'mpi' ? configured?.mpi?.toString() : configured?.ip;
  const useConfigured = (): void => {
    if (linkKind === 'mpi') {
      if (configured?.mpi !== undefined) setMpiCpu(String(configured.mpi));
    } else if (configured?.ip) {
      const ip = configured.ip;
      setRows((rs) =>
        rs.some((x) => rowKey(x) === ip) ? rs : [...rs, { host: ip, manual: true }],
      );
      setSelected(ip);
    }
  };
  const accessOk =
    !!row &&
    rackN !== null &&
    rackN <= 7 &&
    slotN !== null &&
    slotN <= 31 &&
    (kind === 'direct' || tsapN !== null);

  const mpiCpuN = toInt(mpiCpu);
  const mpiLocalN = toInt(mpiLocal);
  const mpiCpuBad = mpiCpuN === null || mpiCpuN > 126;
  const mpiLocalBad = mpiLocalN === null || mpiLocalN > 126;
  const mpiSame = !mpiCpuBad && !mpiLocalBad && mpiCpuN === mpiLocalN;
  const mpiLink: MpiLink | null =
    mpi.port === '' || mpiCpuN === null || mpiCpuBad || mpiLocalN === null || mpiLocalBad || mpiSame
      ? null
      : { ...mpi, cpuAddress: mpiCpuN, localAddress: mpiLocalN };
  const ready = linkKind === 'mpi' ? mpiLink !== null && !mpiSearching : accessOk;
  const canConnect = ready && !!cpu && !uploading;
  const canUpload = ready && !uploading && !scanning;

  /** «Cerca» sul bus MPI: scegliere un nodo ne fa l'indirizzo della CPU. */
  const searchMpi = async (): Promise<void> => {
    if (mpi.port === '' || mpiLocalN === null || mpiLocalBad) return;
    setMpiError(null);
    setMpiNodes(null);
    setMpiSearching(true);
    try {
      const r = await bridge.plcMpiNodes({ ...mpi, localAddress: mpiLocalN, cpuAddress: 0 });
      if (r.ok) setMpiNodes(r.nodes.filter((n) => n !== mpiLocalN));
      else setMpiError(r.error);
    } catch (e) {
      setMpiError(String(e));
    } finally {
      setMpiSearching(false);
    }
  };

  const accessOf = (): PlcAccess | null => {
    if (linkKind === 'mpi') {
      const link = mpiLink;
      if (!link) return null;
      // Con MPI l'accesso TCP della CPU resta com'era nel file, ma non si usa.
      const old = cpu?.properties.access;
      return {
        ...(old ?? { host: '', rack: 0, slot: 2, connectionType: 'PG' as const }),
        link,
      };
    }
    if (!accessOk || !row || rackN === null || slotN === null) return null;
    return {
      host: row.host,
      ...(row.port !== undefined ? { port: row.port } : {}),
      rack: rackN,
      slot: slotN,
      connectionType: 'PG',
      ...(kind === 'gateway' && tsapN !== null ? { remoteTsap: tsapN } : {}),
    };
  };

  /** «Carica dal dispositivo»: crea un progetto nuovo dalla CPU scelta; non serve un progetto aperto. */
  const upload = async (): Promise<void> => {
    const access = accessOf();
    if (!access || uploadingRef.current) return;
    setConnectError(null);
    uploadingRef.current = true;
    setUploading('starting');
    let outcome: Awaited<ReturnType<typeof uploadFromDevice>>;
    try {
      outcome = await uploadFromDevice({ store, bridge, service }, access);
    } finally {
      uploadingRef.current = false;
      setUploading(null);
    }
    if (outcome === 'done') onClose();
  };

  const connect = (): void => {
    if (!canConnect || !cpu) return;
    if (store.getState().online.status !== 'off') {
      setConnectError(t('accessDevices.errOnline'));
      return;
    }
    setConnectError(null);
    const access = accessOf();
    if (!access) return;
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
          <button type="button" disabled={!canUpload} onClick={() => void upload()}>
            {t('upload.dialogButton')}
          </button>
          {uploading ? (
            <button type="button" onClick={() => void bridge.plcUploadCancel()}>
              {t('upload.stop')}
            </button>
          ) : null}
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
        {configuredText ? (
          <div className="baa-access-actions">
            <span>{t('accessDevices.useConfiguredHint', { address: configuredText })}</span>
            <button type="button" data-testid="access-use-configured" onClick={useConfigured}>
              {t('accessDevices.useConfigured')}
            </button>
          </div>
        ) : null}
        <label className="baa-settings-row" htmlFor={ids.link}>
          <span>{t('accessDevices.linkKind')}</span>
          <select
            id={ids.link}
            value={linkKind}
            disabled={scanning || mpiSearching || !!uploading}
            onChange={(e) => setLinkKind(e.target.value as 'tcp' | 'mpi')}
          >
            <option value="tcp">{t('accessDevices.linkTcp')}</option>
            <option value="mpi">{t('accessDevices.linkMpi')}</option>
          </select>
        </label>
        {linkKind === 'mpi' ? (
          <>
            <div className="baa-settings-row">
              <label htmlFor={ids.serial}>{t('accessDevices.interface')}</label>
              <span>
                <select
                  id={ids.serial}
                  value={mpi.port}
                  disabled={mpiSearching}
                  onChange={(e) => setMpi({ ...mpi, port: e.target.value })}
                >
                  {ports.length === 0 ? (
                    <option value="">{t('accessDevices.noSerialPorts')}</option>
                  ) : null}
                  {ports.map((p) => (
                    <option key={p.path} value={p.path}>
                      {p.manufacturer ? `${p.path} (${p.manufacturer})` : p.path}
                    </option>
                  ))}
                </select>
                <button type="button" disabled={mpiSearching} onClick={loadPorts}>
                  {t('accessDevices.refreshPorts')}
                </button>
              </span>
            </div>
            <label className="baa-settings-row" htmlFor={ids.baud}>
              <span>{t('accessDevices.baudRate')}</span>
              <select
                id={ids.baud}
                value={mpi.baudRate}
                onChange={(e) => setMpi({ ...mpi, baudRate: Number(e.target.value) })}
              >
                {BAUD_RATES.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
            <label className="baa-settings-row" htmlFor={ids.parity}>
              <span>{t('accessDevices.parity')}</span>
              <select
                id={ids.parity}
                value={mpi.parity}
                onChange={(e) => setMpi({ ...mpi, parity: e.target.value as MpiLink['parity'] })}
              >
                <option value="odd">{t('accessDevices.parityOdd')}</option>
                <option value="even">{t('accessDevices.parityEven')}</option>
                <option value="none">{t('accessDevices.parityNone')}</option>
              </select>
            </label>
            <label className="baa-settings-row" htmlFor={ids.bus}>
              <span>{t('accessDevices.busSpeed')}</span>
              <select
                id={ids.bus}
                value={mpi.busSpeed}
                onChange={(e) =>
                  setMpi({ ...mpi, busSpeed: e.target.value as MpiLink['busSpeed'] })
                }
              >
                {MPI_BUS_SPEEDS.map((b) => (
                  <option key={b} value={b}>
                    {t(`accessDevices.bus_${b}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="baa-settings-row" htmlFor={ids.hsa}>
              <span>{t('accessDevices.hsa')}</span>
              <select
                id={ids.hsa}
                value={mpi.highestAddress}
                onChange={(e) => setMpi({ ...mpi, highestAddress: Number(e.target.value) })}
              >
                {MPI_HIGHEST_ADDRESSES.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </label>
            <label className="baa-settings-row" htmlFor={ids.variant}>
              <span>{t('accessDevices.variant')}</span>
              <select
                id={ids.variant}
                value={mpi.variant}
                onChange={(e) => setMpi({ ...mpi, variant: e.target.value as MpiLink['variant'] })}
              >
                <option value="auto">{t('accessDevices.variantAuto')}</option>
                <option value="v1">v1</option>
                <option value="v2">v2</option>
              </select>
            </label>
            <div className="baa-access-actions">
              <label htmlFor={ids.mpiLocal}>{t('accessDevices.mpiLocal')}</label>
              <input
                id={ids.mpiLocal}
                type="number"
                min={0}
                max={126}
                value={mpiLocal}
                onChange={(e) => setMpiLocal(e.target.value)}
              />
              <label htmlFor={ids.mpiCpu}>{t('accessDevices.mpiCpu')}</label>
              <input
                id={ids.mpiCpu}
                type="number"
                min={0}
                max={126}
                value={mpiCpu}
                onChange={(e) => setMpiCpu(e.target.value)}
              />
              {mpiCpuBad || mpiLocalBad ? (
                <span role="alert" className="baa-field-error">
                  {t('accessDevices.mpiAddressInvalid')}
                </span>
              ) : mpiSame ? (
                <span role="alert" className="baa-field-error">
                  {t('accessDevices.mpiAddressSame')}
                </span>
              ) : null}
              <button
                type="button"
                disabled={mpiSearching || mpi.port === '' || mpiLocalBad}
                onClick={() => void searchMpi()}
              >
                {t('accessDevices.mpiSearch')}
              </button>
              {mpiSearching ? <span role="status">{t('accessDevices.mpiSearching')}</span> : null}
            </div>
            {mpiError ? (
              <p role="alert" className="baa-field-error">
                {mpiError}
              </p>
            ) : null}
            {mpiNodes ? (
              mpiNodes.length === 0 ? (
                <p role="status">{t('accessDevices.mpiNoNodes')}</p>
              ) : (
                <div
                  className="baa-access-actions"
                  role="group"
                  aria-label={t('accessDevices.mpiNodes')}
                >
                  <span>{t('accessDevices.mpiNodes')}</span>
                  {mpiNodes.map((n) => (
                    <button
                      key={n}
                      type="button"
                      aria-pressed={mpiCpuN === n}
                      onClick={() => setMpiCpu(String(n))}
                    >
                      {t('accessDevices.mpiNode', { address: n })}
                    </button>
                  ))}
                </div>
              )
            ) : null}
          </>
        ) : (
          <>
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
          </>
        )}
        {uploading ? (
          <p role="status">
            {uploading === 'starting'
              ? t('upload.starting')
              : t('upload.progress', {
                  done: uploading.done,
                  total: uploading.total,
                  current: uploading.current,
                })}
          </p>
        ) : null}
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
        {linkKind === 'tcp' ? (
          <>
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
                        {f?.status === 'cpu'
                          ? f.mode
                          : f
                            ? f.reason
                            : t('accessDevices.statusManual')}
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
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
