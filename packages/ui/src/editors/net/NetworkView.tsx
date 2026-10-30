import {
  useId,
  useMemo,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  HIGHEST_ADDRESSES,
  MAX_BUS_ADDRESS,
  STATION_CATALOG,
  SUBNET_RATES,
  SUBNET_TYPES,
  findStation,
  portAccepts,
  type SubnetType,
} from '@baaportal/catalog';
import {
  checkNetworks,
  connectNode,
  createSubnet,
  deleteStation,
  deleteSubnet,
  deviceNodes,
  insertStation,
  nodeKey,
  setNodeAddress,
  type NetIssue,
  type NetNode,
  type PlcDevice,
  type Project,
  type Subnet,
} from '@baaportal/project';
import { TextField, NumberField } from '../../project/inspector/properties/fields';
import { useAppStore, useServices } from '../../state/AppContext';
import '../hw/hw.css';
import './net.css';

const DRAG_NODE = 'application/x-baa-net-node';
const newId = () => globalThis.crypto.randomUUID();
const NO_SUBNETS: Subnet[] = [];
const SUBNET_NAME: Record<SubnetType, string> = {
  MPI: 'MPI',
  PROFIBUS: 'PROFIBUS',
  ETHERNET: 'Ethernet',
};

// Disposizione fissa (niente misure del DOM): sottoreti in alto, riquadri dei dispositivi sotto.
const PAD = 16;
const ROW = 30;
const BOX_W = 200;
const GAP = 32;
const HEAD = 44;
const PORT = 26;

type Selection = { kind: 'subnet'; id: string } | { kind: 'node'; key: string } | null;

interface Box {
  key: string;
  dev: PlcDevice;
  /** Stazione ET 200, se il riquadro è una stazione. */
  stationId?: string;
  title: string;
  subtitle: string;
  nodes: NetNode[];
}

const addressText = (n: NetNode, s: Subnet | undefined) =>
  !s ? '' : s.type === 'ETHERNET' ? (n.ip ?? '') : n.address === undefined ? '' : String(n.address);

/** Editor «Vista di rete»: sottoreti, interfacce dei dispositivi e «Panoramica dispositivi». */
export function NetworkView() {
  const { t } = useTranslation();
  const { store } = useServices();
  const project = useAppStore((s) => s.doc?.project);
  const [sel, setSel] = useState<Selection>(null);
  const [notice, setNotice] = useState('');
  const [stationType, setStationType] = useState(STATION_CATALOG[0]!.orderNumber);
  const [masterId, setMasterId] = useState('');
  const ids = { station: useId(), master: useId() };
  const issues = useMemo(() => (project ? checkNetworks(project) : []), [project]);
  if (!project) return null;

  const subnets = project.subnets ?? NO_SUBNETS;
  const subnetOf = (n: NetNode) => subnets.find((s) => s.id === n.subnetId);
  const edit = (labelKey: string, fn: (p: Project) => boolean) => {
    let ok = false;
    store.getState().edit(labelKey, (p: Project) => {
      ok = fn(p);
    });
    return ok;
  };
  const issueText = (i: NetIssue) => t(`diag.${i.code}`, { other: i.other });
  const nodeIssues = (key: string) => issues.filter((i) => i.node === key);

  const boxes: Box[] = project.devices.flatMap((dev) => {
    const nodes = deviceNodes(dev);
    const own: Box = {
      key: dev.id,
      dev,
      title: dev.name,
      subtitle: dev.cpu.orderNumber,
      nodes: nodes.filter((n) => !n.station),
    };
    return [
      own,
      ...nodes
        .filter((n) => n.station)
        .map((n) => ({
          key: nodeKey(n),
          dev,
          stationId: n.port,
          title: n.label,
          subtitle: findStation(n.station!.orderNumber)?.name ?? '',
          nodes: [n],
        })),
    ];
  });
  const allNodes = boxes.flatMap((b) => b.nodes);

  const addSubnet = (type: SubnetType) => {
    const base = SUBNET_NAME[type];
    let n = 1;
    while (subnets.some((s) => s.name === `${base}_${n}`)) n++;
    const id = newId();
    edit('history.netAddSubnet', (p) => {
      (p.subnets ??= []).push(createSubnet(type, id, `${base}_${n}`));
      return true;
    });
    setSel({ kind: 'subnet', id });
  };
  const connect = (n: NetNode, subnetId: string | undefined) => {
    if (!edit('history.netConnect', (p) => connectNode(p, n.deviceId, n.port, subnetId))) {
      setNotice(t('net.cannotConnect', { name: n.label }));
    } else setNotice('');
  };
  const addStation = () => {
    const dev = project.devices.find((d) => d.id === masterId) ?? project.devices[0];
    const type = findStation(stationType);
    if (!dev || !type) return;
    const id = newId();
    let n = 1;
    const base = type.family.replace(/\s+/g, '');
    const names = new Set(allNodes.map((x) => x.label));
    while (names.has(`${base}_${n}`)) n++;
    edit('history.netAddStation', (p) => {
      const d = p.devices.find((x) => x.id === dev.id)!;
      if (!insertStation(d, type.orderNumber, id, `${base}_${n}`)) return false;
      // Sulla sottorete del master, se ce n'è una adatta: l'IO system o il sistema master DP.
      const master = deviceNodes(d).find(
        (m) =>
          !m.station &&
          m.subnetId &&
          p.subnets?.some((s) => s.id === m.subnetId && portAccepts(type.bus, s.type)),
      );
      if (master) connectNode(p, d.id, id, master.subnetId);
      return true;
    });
    setSel({ kind: 'node', key: `${dev.id}/${id}` });
  };
  const openDeviceView = (b: Box) =>
    store
      .getState()
      .openEditor({ kind: 'deviceView', deviceId: b.dev.id, objectId: b.stationId ?? '' });

  const onDrop = (s: Subnet) => (e: DragEvent) => {
    e.preventDefault();
    const n = allNodes.find((x) => nodeKey(x) === e.dataTransfer.getData(DRAG_NODE));
    if (n) connect(n, s.id);
  };
  const onNodeKey = (n: NetNode) => (e: KeyboardEvent) => {
    if (e.key === 'Delete' && n.subnetId) {
      e.preventDefault();
      connect(n, undefined);
    }
  };

  // Geometria.
  const boxTop = PAD + subnets.length * ROW + 24;
  const boxLeft = (i: number) => PAD + i * (BOX_W + GAP);
  const portY = (k: number) => boxTop + HEAD + k * PORT + PORT / 2;
  const width = Math.max(640, PAD * 2 + boxes.length * (BOX_W + GAP));
  const height = boxTop + Math.max(1, ...boxes.map((b) => b.nodes.length)) * PORT + HEAD + PAD;
  const subnetY = (id: string) => PAD + subnets.findIndex((s) => s.id === id) * ROW + ROW / 2;

  const selNode = sel?.kind === 'node' ? allNodes.find((n) => nodeKey(n) === sel.key) : undefined;
  const selSubnet = sel?.kind === 'subnet' ? subnets.find((s) => s.id === sel.id) : undefined;

  return (
    <div className="baa-hw baa-net" data-testid="network-view">
      <div className="baa-hw-bar">
        <div className="baa-net-tools" role="group" aria-label={t('net.addSubnet')}>
          {SUBNET_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              data-testid={`net-add-${type}`}
              onClick={() => addSubnet(type)}
            >
              {t('net.add', { type: t(`net.type.${type}`) })}
            </button>
          ))}
        </div>
        <div className="baa-net-tools">
          <label htmlFor={ids.station}>{t('net.station')}</label>
          <select
            id={ids.station}
            value={stationType}
            onChange={(e) => setStationType(e.target.value)}
          >
            {STATION_CATALOG.map((s) => (
              <option key={s.orderNumber} value={s.orderNumber} title={s.source}>
                {s.family} {s.name} ({s.bus === 'DP' ? 'PROFIBUS DP' : 'PROFINET IO'})
              </option>
            ))}
          </select>
          {project.devices.length > 1 ? (
            <>
              <label htmlFor={ids.master}>{t('net.master')}</label>
              <select
                id={ids.master}
                value={masterId || project.devices[0]!.id}
                onChange={(e) => setMasterId(e.target.value)}
              >
                {project.devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </>
          ) : null}
          <button
            type="button"
            data-testid="net-add-station"
            disabled={project.devices.length === 0}
            onClick={addStation}
          >
            {t('net.addStation')}
          </button>
        </div>
      </div>
      <p role="note" className="baa-hw-note">
        {t('net.note')}
      </p>
      {notice ? (
        <p role="status" className="baa-hw-notice" data-testid="net-notice">
          {notice}
        </p>
      ) : null}
      <div className="baa-hw-main baa-net-main">
        <div className="baa-hw-left">
          <div className="baa-net-canvas" style={{ width, height }} data-testid="net-canvas">
            <svg className="baa-net-lines" width={width} height={height} aria-hidden="true">
              {boxes.flatMap((b, i) =>
                b.nodes.map((n, k) => {
                  const s = subnetOf(n);
                  if (!s) return null;
                  const x = boxLeft(i) + BOX_W + 6 + k * 5;
                  return (
                    <path
                      key={nodeKey(n)}
                      className={`baa-net-wire is-${s.type}`}
                      d={`M${x},${subnetY(s.id)} V${portY(k)} H${boxLeft(i) + BOX_W}`}
                    />
                  );
                }),
              )}
            </svg>
            {subnets.map((s, i) => (
              <button
                key={s.id}
                type="button"
                className={`baa-net-subnet is-${s.type}${selSubnet?.id === s.id ? ' is-selected' : ''}`}
                style={{ top: PAD + i * ROW + 4, left: PAD, width: width - 2 * PAD }}
                data-testid="net-subnet"
                data-subnet={s.id}
                aria-pressed={selSubnet?.id === s.id}
                aria-label={`${s.name} (${t(`net.type.${s.type}`)})`}
                onClick={() => setSel({ kind: 'subnet', id: s.id })}
                onDragOver={(e) => e.preventDefault()}
                onDrop={onDrop(s)}
              >
                <span>
                  {s.name} · {t(`net.type.${s.type}`)}
                </span>
              </button>
            ))}
            {boxes.map((b, i) => (
              <div
                key={b.key}
                className={`baa-net-box${b.stationId ? ' is-station' : ''}`}
                style={{ top: boxTop, left: boxLeft(i), width: BOX_W }}
                data-testid="net-box"
                role="group"
                aria-label={b.title}
                onDoubleClick={() => openDeviceView(b)}
              >
                <div className="baa-net-box-head" title={t('net.openHint')}>
                  <strong>{b.title}</strong>
                  <span className="baa-xref-muted">{b.subtitle}</span>
                </div>
                {b.nodes.map((n) => {
                  const key = nodeKey(n);
                  const s = subnetOf(n);
                  const bad = nodeIssues(key).some((x) => x.severity === 'error');
                  const addr = addressText(n, s);
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`baa-net-port${sel?.kind === 'node' && sel.key === key ? ' is-selected' : ''}${bad ? ' is-error' : ''}`}
                      style={{ height: PORT - 4 }}
                      draggable
                      data-testid="net-port"
                      data-node={key}
                      aria-pressed={sel?.kind === 'node' && sel.key === key}
                      aria-invalid={bad || undefined}
                      onDragStart={(e) => e.dataTransfer.setData(DRAG_NODE, key)}
                      onClick={() => setSel({ kind: 'node', key })}
                      onKeyDown={onNodeKey(n)}
                    >
                      {n.station ? n.kind : `${n.label} ${n.kind}`}
                      {s ? ` → ${s.name}${addr ? `: ${addr}` : ''}` : ` · ${t('net.notConnected')}`}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <h4>{t('net.overview')}</h4>
          <table className="baa-xref-table" data-testid="net-overview">
            <thead>
              <tr>
                <th>{t('net.device')}</th>
                <th>{t('net.interface')}</th>
                <th>{t('net.kind')}</th>
                <th>{t('net.subnet')}</th>
                <th>{t('net.address')}</th>
                <th>{t('net.problems')}</th>
              </tr>
            </thead>
            <tbody>
              {boxes.flatMap((b) =>
                b.nodes.map((n) => {
                  const key = nodeKey(n);
                  const s = subnetOf(n);
                  return (
                    <tr
                      key={key}
                      data-testid="net-overview-row"
                      data-node={key}
                      className={
                        sel?.kind === 'node' && sel.key === key ? 'is-selected' : undefined
                      }
                    >
                      <td>{b.stationId ? `${b.title} (${b.dev.name})` : b.title}</td>
                      <td>
                        <button
                          type="button"
                          className="baa-info-link"
                          onClick={() => setSel({ kind: 'node', key })}
                        >
                          {n.station ? b.subtitle : n.label}
                        </button>
                      </td>
                      <td>{n.kind}</td>
                      <td>{s?.name ?? ''}</td>
                      <td>{addressText(n, s)}</td>
                      <td>{nodeIssues(key).map(issueText).join(' · ')}</td>
                    </tr>
                  );
                }),
              )}
            </tbody>
          </table>
        </div>
        <section className="baa-hw-props" aria-label={t('hw.properties')} data-testid="net-props">
          <h4>{t('hw.properties')}</h4>
          {selSubnet ? (
            <SubnetProps
              key={selSubnet.id}
              s={selSubnet}
              issues={issues.filter((i) => i.subnetId === selSubnet.id && !i.node).map(issueText)}
              onChange={(fn) =>
                edit('history.netEdit', (p) => {
                  const s = p.subnets?.find((x) => x.id === selSubnet.id);
                  if (s) fn(s);
                  return !!s;
                })
              }
              onDelete={() => {
                if (edit('history.netDeleteSubnet', (p) => deleteSubnet(p, selSubnet.id)))
                  setSel(null);
              }}
            />
          ) : selNode ? (
            <NodeProps
              key={`${nodeKey(selNode)}/${selNode.subnetId ?? ''}`}
              n={selNode}
              subnets={subnets}
              issues={nodeIssues(nodeKey(selNode)).map(issueText)}
              onConnect={(id) => connect(selNode, id)}
              onAddress={(v) =>
                edit('history.netEdit', (p) => setNodeAddress(p, selNode.deviceId, selNode.port, v))
              }
              onStation={(fn) =>
                edit('history.netEdit', (p) => {
                  const st = p.devices
                    .find((d) => d.id === selNode.deviceId)
                    ?.hardware?.stations?.find((x) => x.id === selNode.port);
                  if (st) fn(st);
                  return !!st;
                })
              }
              onOpen={() => {
                const b = boxes.find((x) => x.nodes.includes(selNode));
                if (b) openDeviceView(b);
              }}
              onDeleteStation={() => {
                if (
                  edit('history.netDeleteStation', (p) => {
                    const d = p.devices.find((x) => x.id === selNode.deviceId);
                    return !!d && deleteStation(d, selNode.port);
                  })
                )
                  setSel(null);
              }}
            />
          ) : (
            <p className="baa-placeholder">{t('net.noSelection')}</p>
          )}
        </section>
      </div>
    </div>
  );
}

function Select(p: {
  label: string;
  value: string;
  onChange(v: string): void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <>
      <label htmlFor={id}>{p.label}</label>
      <select id={id} value={p.value} onChange={(e) => p.onChange(e.target.value)}>
        {p.children}
      </select>
    </>
  );
}

const Issues = ({ list }: { list: string[] }) =>
  list.length ? (
    <ul className="baa-hw-issues" role="alert" data-testid="net-issues">
      {list.map((x) => (
        <li key={x}>{x}</li>
      ))}
    </ul>
  ) : null;

function SubnetProps(p: {
  s: Subnet;
  issues: string[];
  onChange(fn: (s: Subnet) => void): void;
  onDelete(): void;
}) {
  const { t } = useTranslation();
  const { s } = p;
  return (
    <div className="baa-props">
      <TextField
        label={t('hw.name')}
        value={s.name}
        validate={(v) => (v.trim() ? null : t('net.nameEmpty'))}
        onCommit={(v) => p.onChange((x) => void (x.name = v.trim()))}
      />
      <TextField label={t('net.kind')} value={t(`net.type.${s.type}`)} />
      {s.type === 'ETHERNET' ? (
        <>
          <TextField
            label={t('net.mask')}
            value={s.subnetMask ?? ''}
            onCommit={(v) => p.onChange((x) => void (x.subnetMask = v.trim()))}
          />
          <TextField
            label={t('net.gateway')}
            value={s.gateway ?? ''}
            onCommit={(v) =>
              p.onChange((x) => {
                if (v.trim()) x.gateway = v.trim();
                else delete x.gateway;
              })
            }
          />
        </>
      ) : (
        <>
          <Select
            label={t('net.rate')}
            value={s.rate ?? ''}
            onChange={(v) => p.onChange((x) => void (x.rate = v))}
          >
            {SUBNET_RATES[s.type].map((r) => (
              <option key={r} value={r}>
                {r}bit/s
              </option>
            ))}
          </Select>
          <Select
            label={t('net.highest')}
            value={String(s.highestAddress ?? MAX_BUS_ADDRESS)}
            onChange={(v) => p.onChange((x) => void (x.highestAddress = Number(v)))}
          >
            {HIGHEST_ADDRESSES.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </Select>
        </>
      )}
      <Issues list={p.issues} />
      <button type="button" onClick={p.onDelete} data-testid="net-delete-subnet">
        {t('net.deleteSubnet')}
      </button>
    </div>
  );
}

function NodeProps(p: {
  n: NetNode;
  subnets: Subnet[];
  issues: string[];
  onConnect(id: string | undefined): void;
  onAddress(v: { address?: number; ip?: string }): void;
  onStation(fn: (st: NonNullable<NetNode['station']>) => void): void;
  onOpen(): void;
  onDeleteStation(): void;
}) {
  const { t } = useTranslation();
  const { n } = p;
  const s = p.subnets.find((x) => x.id === n.subnetId);
  const st = n.station;
  return (
    <div className="baa-props">
      {st ? (
        <>
          <TextField
            label={t('hw.name')}
            value={st.name}
            validate={(v) => (v.trim() ? null : t('net.nameEmpty'))}
            onCommit={(v) => p.onStation((x) => void (x.name = v.trim()))}
          />
          <TextField label={t('hw.orderNumber')} value={st.orderNumber} />
        </>
      ) : (
        <TextField label={t('net.interface')} value={n.label} />
      )}
      <TextField label={t('net.kind')} value={n.kind} />
      <Select
        label={t('net.subnet')}
        value={n.subnetId ?? ''}
        onChange={(v) => p.onConnect(v || undefined)}
      >
        <option value="">{t('net.notConnected')}</option>
        {p.subnets
          .filter((x) => portAccepts(n.kind, x.type) || x.id === n.subnetId)
          .map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
      </Select>
      {s?.type === 'ETHERNET' ? (
        <TextField
          label={t('net.ip')}
          value={n.ip ?? ''}
          onCommit={(v) => p.onAddress({ ip: v.trim() })}
        />
      ) : s ? (
        <NumberField
          label={t(s.type === 'MPI' ? 'net.mpiAddress' : 'net.dpAddress')}
          value={n.address ?? 0}
          validate={(v) =>
            v < 0 || v > MAX_BUS_ADDRESS ? t('net.addressRange', { max: MAX_BUS_ADDRESS }) : null
          }
          onCommit={(v) => p.onAddress({ address: v })}
        />
      ) : null}
      {st && n.kind === 'PN' ? (
        <TextField
          label={t('net.deviceName')}
          value={st.deviceName ?? ''}
          onCommit={(v) => p.onStation((x) => void (x.deviceName = v.trim()))}
        />
      ) : null}
      <Issues list={p.issues} />
      <button type="button" onClick={p.onOpen} data-testid="net-open-device">
        {t('net.openDeviceView')}
      </button>
      {st ? (
        <button type="button" onClick={p.onDeleteStation} data-testid="net-delete-station">
          {t('net.deleteStation')}
        </button>
      ) : null}
    </div>
  );
}
