// Vista di rete (tappa 6B): sottoreti del progetto, interfacce dei dispositivi e stazioni ET 200.
// Si salva nel progetto ma non si carica nella CPU e non si legge dalla CPU (SDB non documentati,
// vedi docs/limiti-noti.md).
import {
  HIGHEST_ADDRESSES,
  MAX_BUS_ADDRESS,
  SUBNET_RATES,
  cpuPorts,
  findCpu,
  findIoModule,
  findModule,
  findStation,
  modulePort,
  portAccepts,
  stationAccepts,
  type PortKind,
  type SubnetType,
} from '@baaportal/catalog';
import { ioRanges } from './hardware';
import type { HwInterface, HwModule, HwStation, PlcDevice, Project, Subnet } from './model';

/** Un'interfaccia collegabile: della CPU (`X1`…), di un CP del rack (id del modulo) o una stazione ET 200 (id della stazione). */
export interface NetNode {
  deviceId: string;
  /** Nome dell'interfaccia della CPU, id del CP o id della stazione. */
  port: string;
  kind: PortKind;
  /** Etichetta breve: «X1», il nome del CP o della stazione. */
  label: string;
  station?: HwStation;
  subnetId?: string;
  address?: number;
  ip?: string;
}

export const nodeKey = (n: { deviceId: string; port: string }): string => `${n.deviceId}/${n.port}`;

/** Interfacce di un dispositivo: CPU, CP 343-1 del rack, poi le stazioni ET 200, con il collegamento salvato. */
export function deviceNodes(dev: PlcDevice): NetNode[] {
  const hw = dev.hardware;
  const conf = (port: string): Partial<HwInterface> =>
    hw?.interfaces?.find((i) => i.port === port) ?? {};
  const pick = (c: Partial<HwInterface>) => ({
    ...(c.subnetId !== undefined ? { subnetId: c.subnetId } : {}),
    ...(c.address !== undefined ? { address: c.address } : {}),
    ...(c.ip !== undefined ? { ip: c.ip } : {}),
  });
  const cpu = findCpu(dev.cpu.typeId);
  const out: NetNode[] = (cpu ? cpuPorts(cpu) : []).map((p) => ({
    deviceId: dev.id,
    port: p.id,
    kind: p.kind,
    label: p.id,
    ...pick(conf(p.id)),
  }));
  for (const m of [...(hw?.modules ?? [])].sort((a, b) => a.rack - b.rack || a.slot - b.slot)) {
    const type = findModule(m.orderNumber);
    const kind = type && modulePort(type);
    if (kind) out.push({ deviceId: dev.id, port: m.id, kind, label: m.name, ...pick(conf(m.id)) });
  }
  for (const st of hw?.stations ?? []) {
    const type = findStation(st.orderNumber);
    if (!type) continue;
    out.push({
      deviceId: dev.id,
      port: st.id,
      kind: type.bus,
      label: st.name,
      station: st,
      ...pick(st),
    });
  }
  return out;
}

export const projectNodes = (p: Project): NetNode[] => p.devices.flatMap(deviceNodes);

/** Parametri iniziali di una sottorete nuova. */
export function createSubnet(type: SubnetType, id: string, name: string): Subnet {
  if (type === 'ETHERNET') return { id, name, type, subnetMask: '255.255.255.0' };
  return {
    id,
    name,
    type,
    rate: type === 'MPI' ? '187.5k' : '1.5M',
    highestAddress: type === 'MPI' ? 31 : 126,
  };
}

/** Elimina la sottorete e scollega tutto ciò che vi era collegato. */
export function deleteSubnet(p: Project, id: string): boolean {
  const i = p.subnets?.findIndex((s) => s.id === id) ?? -1;
  if (!p.subnets || i < 0) return false;
  p.subnets.splice(i, 1);
  for (const d of p.devices) {
    for (const x of [...(d.hardware?.interfaces ?? []), ...(d.hardware?.stations ?? [])]) {
      if (x.subnetId === id) {
        delete x.subnetId;
        delete x.address;
        delete x.ip;
      }
    }
  }
  return true;
}

/** Il primo indirizzo libero sulla sottorete: da 2 per MPI/PROFIBUS (0 e 1 di solito a PG e OP), 192.168.0.n per Ethernet. */
export function suggestAddress(p: Project, subnet: Subnet): { address?: number; ip?: string } {
  const on = projectNodes(p).filter((n) => n.subnetId === subnet.id);
  if (subnet.type === 'ETHERNET') {
    const used = new Set(on.map((n) => n.ip));
    for (let n = 1; n < 255; n++) if (!used.has(`192.168.0.${n}`)) return { ip: `192.168.0.${n}` };
    return {};
  }
  const used = new Set(on.map((n) => n.address));
  const max = subnet.highestAddress ?? MAX_BUS_ADDRESS;
  for (let a = 2; a <= max; a++) if (!used.has(a)) return { address: a };
  return {};
}

/**
 * Collega l'interfaccia `port` del dispositivo alla sottorete (o la scollega con `undefined`),
 * proponendo il primo indirizzo libero; falso se l'interfaccia o la sottorete non vanno bene.
 */
export function connectNode(
  p: Project,
  deviceId: string,
  port: string,
  subnetId: string | undefined,
): boolean {
  const dev = p.devices.find((d) => d.id === deviceId);
  const node = dev && deviceNodes(dev).find((n) => n.port === port);
  const subnet = p.subnets?.find((s) => s.id === subnetId);
  if (
    !dev ||
    !node ||
    (subnetId !== undefined && (!subnet || !portAccepts(node.kind, subnet.type)))
  )
    return false;
  if (node.subnetId === subnetId) return true;
  const target = nodeTarget(dev, port);
  delete target.address;
  delete target.ip;
  if (subnet) Object.assign(target, { subnetId: subnet.id }, suggestAddress(p, subnet));
  else delete target.subnetId;
  return true;
}

/** Imposta l'indirizzo MPI/DP o IP dell'interfaccia. */
export function setNodeAddress(
  p: Project,
  deviceId: string,
  port: string,
  value: { address?: number; ip?: string },
): boolean {
  const dev = p.devices.find((d) => d.id === deviceId);
  if (!dev || !deviceNodes(dev).some((n) => n.port === port)) return false;
  Object.assign(nodeTarget(dev, port), value);
  return true;
}

/** Dove si salva il collegamento: la stazione stessa o la voce di `hardware.interfaces`. */
function nodeTarget(dev: PlcDevice, port: string): HwStation | HwInterface {
  const hw = (dev.hardware ??= { modules: [] });
  const st = hw.stations?.find((s) => s.id === port);
  if (st) return st;
  hw.interfaces ??= [];
  let i = hw.interfaces.find((x) => x.port === port);
  if (!i) hw.interfaces.push((i = { port }));
  return i;
}

// ---- Stazioni ET 200 ----

/** Inserisce una stazione ET 200 del catalogo nel dispositivo (master DP o controller IO). */
export function insertStation(dev: PlcDevice, orderNumber: string, id: string, name: string) {
  const type = findStation(orderNumber);
  if (!type) return false;
  const hw = (dev.hardware ??= { modules: [] });
  (hw.stations ??= []).push({
    id,
    orderNumber: type.orderNumber,
    name,
    comment: '',
    ...(type.bus === 'PN' ? { deviceName: name.toLowerCase().replace(/[^a-z0-9-]+/g, '-') } : {}),
    modules: [],
  });
  return true;
}

export function deleteStation(dev: PlcDevice, id: string): boolean {
  const list = dev.hardware?.stations;
  const i = list?.findIndex((s) => s.id === id) ?? -1;
  if (!list || i < 0) return false;
  list.splice(i, 1);
  return true;
}

/** Primo indirizzo libero nell'area, da 0 per i digitali e da 256 per gli analogici. */
function freeAddress(dev: PlcDevice, area: 'I' | 'Q', bytes: number, from: number): number {
  const used = ioRanges(dev)[area];
  let start = from;
  for (const r of used) if (r.to >= start && r.from < start + bytes) start = r.to + 1;
  return start;
}

/**
 * Inserisce un modulo nel posto della stazione con indirizzi liberi nello spazio della CPU;
 * falso se il posto è occupato o non accetta il modulo.
 */
export function insertStationModule(
  dev: PlcDevice,
  stationId: string,
  orderNumber: string,
  slot: number,
  id: string,
): boolean {
  const st = dev.hardware?.stations?.find((s) => s.id === stationId);
  const sType = st && findStation(st.orderNumber);
  const type = findIoModule(orderNumber);
  if (!st || !sType || !type || !stationAccepts(sType, type, slot)) return false;
  if (st.modules.some((m) => m.slot === slot)) return false;
  const from = type.addressing === 'analog' ? 256 : 0;
  const m: HwModule = {
    id,
    rack: 0,
    slot,
    orderNumber: type.orderNumber,
    name: type.name,
    comment: '',
    ...(type.inputBytes > 0 ? { inputStart: freeAddress(dev, 'I', type.inputBytes, from) } : {}),
    ...(type.outputBytes > 0 ? { outputStart: freeAddress(dev, 'Q', type.outputBytes, from) } : {}),
  };
  st.modules.push(m);
  return true;
}

export function deleteStationModule(dev: PlcDevice, stationId: string, id: string): boolean {
  const list = dev.hardware?.stations?.find((s) => s.id === stationId)?.modules;
  const i = list?.findIndex((m) => m.id === id) ?? -1;
  if (!list || i < 0) return false;
  list.splice(i, 1);
  return true;
}

// ---- Controlli ----

export type NetIssueCode =
  | 'NET_NOT_CONNECTED'
  | 'NET_SUBNET_INVALID'
  | 'NET_ADDRESS_OUT_OF_RANGE'
  | 'NET_ADDRESS_DUPLICATE'
  | 'NET_IP_INVALID'
  | 'NET_IP_DUPLICATE'
  | 'NET_STATION_NO_MASTER'
  | 'NET_MASK_INVALID'
  | 'NET_GATEWAY_INVALID'
  | 'NET_RATE_INVALID';

export interface NetIssue {
  severity: 'error' | 'warning';
  code: NetIssueCode;
  /** Interfaccia interessata (`nodeKey`) oppure sottorete (`subnetId`). */
  node?: string;
  subnetId?: string;
  /** Nei doppioni: l'altra interfaccia. */
  other?: string;
}

const ipNumber = (s: string | undefined): number | undefined => {
  const m = s?.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return undefined;
  const parts = m.slice(1).map(Number);
  if (parts.some((x) => x > 255)) return undefined;
  return parts.reduce((acc, x) => acc * 256 + x, 0);
};

/** Maschera valida: uni contigui, né 0.0.0.0 né 255.255.255.255. */
export function maskValid(mask: string): boolean {
  const n = ipNumber(mask);
  if (n === undefined || n === 0 || n === 0xffffffff) return false;
  const inv = 0xffffffff - n;
  return (inv & (inv + 1)) === 0;
}

/** IP di un nodo: unicast (primo byte 1–223, non 127) e, con la maschera, né indirizzo di rete né broadcast. */
export function ipValid(ip: string, mask?: string): boolean {
  const n = ipNumber(ip);
  if (n === undefined) return false;
  const first = Math.floor(n / 2 ** 24);
  if (first === 0 || first === 127 || first > 223) return false;
  if (mask === undefined || !maskValid(mask)) return true;
  const host = n % (0xffffffff - ipNumber(mask)! + 1);
  return host !== 0 && host !== 0xffffffff - ipNumber(mask)!;
}

/** Problemi delle sottoreti e dei collegamenti di tutto il progetto. */
export function checkNetworks(p: Project): NetIssue[] {
  const out: NetIssue[] = [];
  const subnets = new Map((p.subnets ?? []).map((s) => [s.id, s]));
  for (const s of subnets.values()) {
    if (s.type === 'ETHERNET') {
      if (s.subnetMask !== undefined && s.subnetMask !== '' && !maskValid(s.subnetMask))
        out.push({ severity: 'error', code: 'NET_MASK_INVALID', subnetId: s.id });
      if (s.gateway && !ipValid(s.gateway, s.subnetMask || undefined))
        out.push({ severity: 'error', code: 'NET_GATEWAY_INVALID', subnetId: s.id });
    } else if (
      (s.rate !== undefined && !SUBNET_RATES[s.type].includes(s.rate)) ||
      (s.highestAddress !== undefined &&
        !(HIGHEST_ADDRESSES as readonly number[]).includes(s.highestAddress))
    ) {
      out.push({ severity: 'error', code: 'NET_RATE_INVALID', subnetId: s.id });
    }
  }
  const nodes = projectNodes(p);
  const seen = new Map<string, NetNode>();
  for (const n of nodes) {
    const key = nodeKey(n);
    const issue = (code: NetIssueCode, severity: NetIssue['severity'] = 'error', other?: string) =>
      out.push({
        severity,
        code,
        node: key,
        ...(n.subnetId ? { subnetId: n.subnetId } : {}),
        ...(other ? { other } : {}),
      });
    if (n.subnetId === undefined) {
      issue('NET_NOT_CONNECTED', 'warning');
      continue;
    }
    const s = subnets.get(n.subnetId);
    if (!s || !portAccepts(n.kind, s.type)) {
      issue('NET_SUBNET_INVALID');
      continue;
    }
    const dev = p.devices.find((d) => d.id === n.deviceId)!;
    const name = (x: NetNode) => `${p.devices.find((d) => d.id === x.deviceId)?.name} ${x.label}`;
    if (n.station && !deviceNodes(dev).some((m) => !m.station && m.subnetId === s.id)) {
      issue('NET_STATION_NO_MASTER', 'warning');
    }
    let dupKey: string;
    if (s.type === 'ETHERNET') {
      if (n.ip === undefined || !ipValid(n.ip, s.subnetMask || undefined)) {
        issue('NET_IP_INVALID');
        continue;
      }
      dupKey = `${s.id}/ip/${n.ip.trim()}`;
    } else {
      const max = s.highestAddress ?? MAX_BUS_ADDRESS;
      if (n.address === undefined || n.address < 0 || n.address > Math.min(max, MAX_BUS_ADDRESS)) {
        issue('NET_ADDRESS_OUT_OF_RANGE');
        continue;
      }
      dupKey = `${s.id}/bus/${n.address}`;
    }
    const prev = seen.get(dupKey);
    if (prev) {
      issue(
        s.type === 'ETHERNET' ? 'NET_IP_DUPLICATE' : 'NET_ADDRESS_DUPLICATE',
        'error',
        name(prev),
      );
    } else seen.set(dupKey, n);
  }
  return out;
}

/** Indirizzi configurati del dispositivo per «Dispositivi accessibili»: il primo IP e il primo indirizzo MPI. */
export function configuredAccess(p: Project, deviceId: string): { ip?: string; mpi?: number } {
  const dev = p.devices.find((d) => d.id === deviceId);
  const type = (n: NetNode) => p.subnets?.find((s) => s.id === n.subnetId)?.type;
  const own = dev ? deviceNodes(dev).filter((n) => !n.station) : [];
  const ip = own.find((n) => type(n) === 'ETHERNET' && n.ip)?.ip;
  const mpi = own.find((n) => type(n) === 'MPI' && n.address !== undefined)?.address;
  return { ...(ip ? { ip } : {}), ...(mpi !== undefined ? { mpi } : {}) };
}
