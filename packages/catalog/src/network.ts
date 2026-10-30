import type { CpuType } from './types';
import { MODULE_CATALOG, findModule, type ModuleType } from './modules';

// Reti e periferia decentrata (tappa 6B). Fonti pubbliche, solo numeri d'articolo, interfacce,
// posti e occupazione degli indirizzi; nessun testo copiato. Nessuna importazione di file GSD.

/** Tipo di sottorete. */
export type SubnetType = 'MPI' | 'PROFIBUS' | 'ETHERNET';
/** Tipo di interfaccia: l'MPI/DP (X1 delle CPU PN/DP) va su una sottorete MPI o PROFIBUS. */
export type PortKind = 'MPI' | 'DP' | 'MPI/DP' | 'PN';

export interface PortType {
  /** Nome dell'interfaccia sulla CPU, es. «X1». */
  id: string;
  kind: PortKind;
}

export const SUBNET_TYPES: readonly SubnetType[] = ['MPI', 'PROFIBUS', 'ETHERNET'];

/** Velocità di trasmissione (manuale «S7-300 CPU 31xC and CPU 31x», cap. «Communication»). */
export const SUBNET_RATES: Record<'MPI' | 'PROFIBUS', readonly string[]> = {
  MPI: ['19.2k', '187.5k', '1.5M'],
  PROFIBUS: ['9.6k', '19.2k', '45.45k', '93.75k', '187.5k', '500k', '1.5M', '3M', '6M', '12M'],
};
/** Indirizzo più alto (HSA) ammesso per MPI e PROFIBUS. */
export const HIGHEST_ADDRESSES = [15, 31, 63, 126] as const;
/** Gli indirizzi MPI e PROFIBUS vanno da 0 a 126. */
export const MAX_BUS_ADDRESS = 126;

export const portAccepts = (kind: PortKind, subnet: SubnetType): boolean =>
  kind === 'PN'
    ? subnet === 'ETHERNET'
    : kind === 'MPI'
      ? subnet === 'MPI'
      : kind === 'DP'
        ? subnet === 'PROFIBUS'
        : subnet !== 'ETHERNET';

/**
 * Interfacce integrate della CPU (manuale 03/2011 delle CPU 31x, tabelle dei dati tecnici,
 * «1st/2nd/3rd interface»): CPU senza DP (anche le 31xC-2 PtP: la PtP non va in rete) solo X1 MPI;
 * CPU DP X1 MPI e X2 DP, ma la 317-2 DP e la 317F-2 DP hanno X1 MPI/DP; CPU PN/DP X1 MPI/DP e X2 PN;
 * la 319-3 PN/DP X1 MPI/DP, X2 DP e X3 PN.
 */
export function cpuPorts(cpu: CpuType): PortType[] {
  const { dp, pn } = cpu.interfaces;
  if (pn && dp && /319/.test(cpu.id)) {
    return [
      { id: 'X1', kind: 'MPI/DP' },
      { id: 'X2', kind: 'DP' },
      { id: 'X3', kind: 'PN' },
    ];
  }
  if (pn) {
    return [
      { id: 'X1', kind: 'MPI/DP' },
      { id: 'X2', kind: 'PN' },
    ];
  }
  if (dp) {
    return [
      { id: 'X1', kind: /317/.test(cpu.id) ? 'MPI/DP' : 'MPI' },
      { id: 'X2', kind: 'DP' },
    ];
  }
  return [{ id: 'X1', kind: 'MPI' }];
}

/** CP del rack con un'interfaccia di rete propria: i CP 343-1 su Industrial Ethernet. */
export const modulePort = (m: ModuleType): PortKind | undefined =>
  m.family === 'CP 343-1' ? 'PN' : undefined;

// ---- Periferia decentrata ET 200 ----

const ET200S_SRC =
  'SIMATIC ET 200S Distributed I/O System, Operating Instructions; IM151-1 STANDARD (6ES7 151-1AA05-0AB0) e IM151-3 PN (6ES7 151-3AA23-0AB0), Manual (Siemens Industry Online Support): fino a 63 moduli; moduli elettronici 2DI/4DI/2DO/4DO DC24V ST, 1 byte ciascuno senza compressione degli indirizzi';
const ET200M_SRC =
  'SIMATIC ET 200M Distributed I/O Device, Operating Instructions; IM 153-1 (6ES7 153-1AA03-0XB0) (Siemens Industry Online Support): moduli di segnale S7-300 nei posti 4–11';

/** Stazione di periferia decentrata: slave DP o IO device PROFINET, con i suoi posti. */
export interface StationType {
  orderNumber: string;
  name: string;
  family: 'ET 200S' | 'ET 200M';
  /** Bus della stazione: PROFIBUS DP o PROFINET IO. */
  bus: 'DP' | 'PN';
  firstSlot: number;
  lastSlot: number;
  description: string;
  source: string;
}

export const STATION_CATALOG: readonly StationType[] = [
  {
    orderNumber: '6ES7 151-1AA05-0AB0',
    name: 'IM151-1 Standard',
    family: 'ET 200S',
    bus: 'DP',
    firstSlot: 1,
    lastSlot: 63,
    description: 'ET 200S, PROFIBUS DP slave',
    source: ET200S_SRC,
  },
  {
    orderNumber: '6ES7 151-3AA23-0AB0',
    name: 'IM151-3 PN',
    family: 'ET 200S',
    bus: 'PN',
    firstSlot: 1,
    lastSlot: 63,
    description: 'ET 200S, PROFINET IO device',
    source: ET200S_SRC,
  },
  {
    orderNumber: '6ES7 153-1AA03-0XB0',
    name: 'IM 153-1',
    family: 'ET 200M',
    bus: 'DP',
    firstSlot: 4,
    lastSlot: 11,
    description: 'ET 200M, PROFIBUS DP slave, S7-300 modules',
    source: ET200M_SRC,
  },
];

/** Moduli elettronici ET 200S: senza compressione occupano un byte intero ciascuno. */
const em = (
  orderNumber: string,
  name: string,
  description: string,
  inputBytes: number,
  outputBytes: number,
): ModuleType => ({
  orderNumber,
  name,
  family: 'ET 200S',
  kind: 'SM',
  description,
  addressing: 'digital',
  inputBytes,
  outputBytes,
  source: ET200S_SRC,
});
export const ET200S_MODULES: readonly ModuleType[] = [
  em('6ES7 131-4BB01-0AA0', '2DI DC24V ST', '2 DI, DC 24 V', 1, 0),
  em('6ES7 131-4BD01-0AA0', '4DI DC24V ST', '4 DI, DC 24 V', 1, 0),
  em('6ES7 132-4BB01-0AA0', '2DO DC24V/0.5A ST', '2 DO, DC 24 V / 0.5 A', 0, 1),
  em('6ES7 132-4BD02-0AA0', '4DO DC24V/0.5A ST', '4 DO, DC 24 V / 0.5 A', 0, 1),
];

const norm = (s: string) => s.replace(/\s+/g, '').toUpperCase();
const STATIONS = new Map(STATION_CATALOG.map((s) => [norm(s.orderNumber), s]));
const ET200S_BY_ORDER = new Map(ET200S_MODULES.map((m) => [norm(m.orderNumber), m]));

export const findStation = (orderNumber: string): StationType | undefined =>
  STATIONS.get(norm(orderNumber));

/** Modulo del rack S7-300 o della ET 200S. */
export const findIoModule = (orderNumber: string): ModuleType | undefined =>
  findModule(orderNumber) ?? ET200S_BY_ORDER.get(norm(orderNumber));

/** Moduli che si inseriscono nella stazione: SM S7-300 nella ET 200M, moduli elettronici nella ET 200S. */
export const stationModules = (st: StationType): readonly ModuleType[] =>
  st.family === 'ET 200M' ? MODULE_CATALOG.filter((m) => m.kind === 'SM') : ET200S_MODULES;

export const stationAccepts = (st: StationType, m: ModuleType, slot: number): boolean =>
  slot >= st.firstSlot && slot <= st.lastSlot && stationModules(st).includes(m);
