import type { CpuType, CpuVersion } from './types';

// Fonti pubbliche (solo numeri e identificatori, nessun testo copiato).
const MAN_2011 =
  'S7-300 CPU 31xC and CPU 31x: Technical specifications, Manual 03/2011, A5E00105475-12 (https://www.mroelectric.com/static/app/product/pdfs/6ES7315-2EH14-0AB0.pdf)';
const MAN_2008 =
  'S7-300 CPU 31xC und CPU 31x: Technische Daten, Gerätehandbuch 06/2008, A5E00105474-08 (https://cache.industry.siemens.com/dl/files/149/36305149/att_1845/v1/s7300_cpu_31xc_and_cpu_31x_manual_de-DE_de-DE.pdf)';
const MANUALS = `${MAN_2011}; ${MAN_2008}`;
const sheet = (mlfb: string, url: string) => `Siemens data sheet ${mlfb} (${url})`;

// Valori comuni alle versioni V3.x dei manuali 03/2011 e dei data sheet delle CPU F.
// Dati locali per classe di priorità: verificato CPU per CPU nel manuale 03/2011, voce "Local data /
// Per priority class, max." delle tabelle dati tecnici di tutte e 12 le CPU V3.x (cap. 8 e 9): sempre
// 32 KB (2048 byte per blocco). I valori inferiori (256/510/1024 byte) sono delle versioni V2.x (manuale 2008).
const LOCAL_V3 = 32768;
const MAX_DB = 16000; // numeri DB 1..16000
const MAX_FB_FC = 7999; // numeri FB/FC 0..7999

// OB tra i 12 gestiti: OB86 solo con interfaccia DP o PROFINET.
const OBS_BASE = [1, 10, 20, 35, 40, 80, 82, 85, 100, 121, 122];
const OBS_WITH_86 = [1, 10, 20, 35, 40, 80, 82, 85, 86, 100, 121, 122];

// I/O integrato: "Default addresses of the integrated" nei dati tecnici delle 31xC del manuale 03/2011
// (cap. 8: 312C p. 222, 313C p. 231, 313C-2 p. 243, 314C-2 p. 255, 314C-2 PN/DP p. 271).
// Analogici: 2 byte per canale (AI 5 → 752..761, AO 2 → 752..755).
const io = (
  name: string,
  inStart: number,
  inBytes: number,
  outStart: number,
  outBytes: number,
) => ({
  name,
  inputs: { start: inStart, bytes: inBytes },
  outputs: { start: outStart, bytes: outBytes },
});
const IO_DI24_AI5 = [io('DI24/DO16', 124, 3, 124, 2), io('AI5/AO2', 752, 10, 752, 4)];

const v = (orderNumber: string, ...firmware: string[]): CpuVersion => ({ orderNumber, firmware });

interface Spec {
  id: string;
  name: string;
  group: CpuType['group'];
  versions: CpuVersion[];
  mpi?: boolean;
  dp: boolean;
  pn: boolean;
  workMemoryKB: number;
  mBytes: number;
  timers: number;
  counters: number;
  ioBytes: number;
  integratedIo?: CpuType['integratedIo'];
  /** Profondità di annidamento per classe di priorità; 16 se non indicata (CPU 312/312C: 8). */
  nesting?: number;
  source: string;
}

// Il massimo remanente è l'intera area: i manuali indicano "configurabile" e, nei data sheet
// delle CPU F, limite superiore pari all'ultimo elemento; per i merker "MB 0 a MB <n-1>".
function cpu(s: Spec): CpuType {
  return {
    id: s.id,
    name: s.name,
    group: s.group,
    versions: s.versions,
    interfaces: { mpi: s.mpi ?? true, dp: s.dp, pn: s.pn },
    workMemoryKB: s.workMemoryKB,
    limits: {
      mBytes: s.mBytes,
      timers: s.timers,
      counters: s.counters,
      inputBytes: s.ioBytes,
      outputBytes: s.ioBytes,
      maxFb: MAX_FB_FC,
      maxFc: MAX_FB_FC,
      maxDb: MAX_DB,
      localDataBytesPerClass: LOCAL_V3,
      blockNesting: s.nesting ?? 16,
    },
    retentiveMax: { mBytes: s.mBytes, timers: s.timers, counters: s.counters },
    obs: s.dp || s.pn ? OBS_WITH_86 : OBS_BASE,
    ...(s.integratedIo ? { integratedIo: s.integratedIo } : {}),
    source: s.source,
  };
}

export const CPU_CATALOG: readonly CpuType[] = [
  // CPU standard 31x
  cpu({
    id: 'cpu-312',
    name: 'CPU 312',
    group: 'standard',
    versions: [v('6ES7 312-1AE14-0AB0', 'V3.3'), v('6ES7 312-1AE13-0AB0', 'V2.6')],
    dp: false,
    pn: false,
    workMemoryKB: 32,
    mBytes: 256,
    timers: 256,
    counters: 256,
    ioBytes: 1024,
    nesting: 8,
    source: MANUALS,
  }),
  cpu({
    id: 'cpu-314',
    name: 'CPU 314',
    group: 'standard',
    versions: [v('6ES7 314-1AG14-0AB0', 'V3.3'), v('6ES7 314-1AG13-0AB0', 'V2.6')],
    dp: false,
    pn: false,
    workMemoryKB: 128,
    mBytes: 256,
    timers: 256,
    counters: 256,
    ioBytes: 1024,
    source: MANUALS,
  }),
  cpu({
    id: 'cpu-315-2-dp',
    name: 'CPU 315-2 DP',
    group: 'standard',
    versions: [v('6ES7 315-2AH14-0AB0', 'V3.3'), v('6ES7 315-2AG10-0AB0', 'V2.6')],
    dp: true,
    pn: false,
    workMemoryKB: 256,
    mBytes: 2048,
    timers: 256,
    counters: 256,
    ioBytes: 2048,
    source: MANUALS,
  }),
  cpu({
    id: 'cpu-315-2-pn-dp',
    name: 'CPU 315-2 PN/DP',
    group: 'standard',
    versions: [v('6ES7 315-2EH14-0AB0', 'V3.2.1', 'V3.2'), v('6ES7 315-2EH13-0AB0', 'V2.6')],
    dp: true,
    pn: true,
    workMemoryKB: 384,
    mBytes: 2048,
    timers: 256,
    counters: 256,
    ioBytes: 2048,
    source: MANUALS,
  }),
  cpu({
    id: 'cpu-317-2-dp',
    name: 'CPU 317-2 DP',
    group: 'standard',
    versions: [v('6ES7 317-2AK14-0AB0', 'V3.3'), v('6ES7 317-2AJ10-0AB0', 'V2.6')],
    dp: true,
    pn: false,
    workMemoryKB: 1024,
    mBytes: 4096,
    timers: 512,
    counters: 512,
    ioBytes: 8192,
    source: MANUALS,
  }),
  cpu({
    id: 'cpu-317-2-pn-dp',
    name: 'CPU 317-2 PN/DP',
    group: 'standard',
    versions: [v('6ES7 317-2EK14-0AB0', 'V3.2.1', 'V3.2'), v('6ES7 317-2EK13-0AB0', 'V2.6')],
    dp: true,
    pn: true,
    workMemoryKB: 1024,
    mBytes: 4096,
    timers: 512,
    counters: 512,
    ioBytes: 8192,
    source: MANUALS,
  }),
  cpu({
    id: 'cpu-319-3-pn-dp',
    name: 'CPU 319-3 PN/DP',
    group: 'standard',
    versions: [v('6ES7 318-3EL01-0AB0', 'V3.2.1', 'V3.2'), v('6ES7 318-3EL00-0AB0', 'V2.7')],
    dp: true,
    pn: true,
    workMemoryKB: 2048,
    mBytes: 8192,
    timers: 2048,
    counters: 2048,
    ioBytes: 8192,
    source: MANUALS,
  }),
  // CPU compatte 31xC
  cpu({
    id: 'cpu-312c',
    name: 'CPU 312C',
    group: 'compact',
    versions: [v('6ES7 312-5BF04-0AB0', 'V3.3'), v('6ES7 312-5BE03-0AB0', 'V2.6')],
    dp: false,
    pn: false,
    workMemoryKB: 64,
    mBytes: 256,
    timers: 256,
    counters: 256,
    ioBytes: 1024,
    nesting: 8,
    integratedIo: [io('DI10/DO6', 124, 2, 124, 1)],
    source: MANUALS,
  }),
  cpu({
    id: 'cpu-313c',
    name: 'CPU 313C',
    group: 'compact',
    versions: [v('6ES7 313-5BG04-0AB0', 'V3.3'), v('6ES7 313-5BF03-0AB0', 'V2.6')],
    dp: false,
    pn: false,
    workMemoryKB: 128,
    mBytes: 256,
    timers: 256,
    counters: 256,
    ioBytes: 1024,
    integratedIo: IO_DI24_AI5,
    source: MANUALS,
  }),
  cpu({
    id: 'cpu-313c-2-ptp',
    name: 'CPU 313C-2 PtP',
    group: 'compact',
    versions: [v('6ES7 313-6BG04-0AB0', 'V3.3'), v('6ES7 313-6BF03-0AB0', 'V2.6')],
    dp: false,
    pn: false,
    workMemoryKB: 128,
    mBytes: 256,
    timers: 256,
    counters: 256,
    ioBytes: 1024,
    integratedIo: [io('DI16/DO16', 124, 2, 124, 2)],
    source: MANUALS,
  }),
  cpu({
    id: 'cpu-313c-2-dp',
    name: 'CPU 313C-2 DP',
    group: 'compact',
    versions: [v('6ES7 313-6CG04-0AB0', 'V3.3'), v('6ES7 313-6CF03-0AB0', 'V2.6')],
    dp: true,
    pn: false,
    workMemoryKB: 128,
    mBytes: 256,
    timers: 256,
    counters: 256,
    ioBytes: 2048,
    integratedIo: [io('DI16/DO16', 124, 2, 124, 2)],
    source: MANUALS,
  }),
  cpu({
    id: 'cpu-314c-2-ptp',
    name: 'CPU 314C-2 PtP',
    group: 'compact',
    versions: [v('6ES7 314-6BH04-0AB0', 'V3.3'), v('6ES7 314-6BG03-0AB0', 'V2.6')],
    dp: false,
    pn: false,
    workMemoryKB: 192,
    mBytes: 256,
    timers: 256,
    counters: 256,
    ioBytes: 1024,
    integratedIo: IO_DI24_AI5,
    source: MANUALS,
  }),
  cpu({
    id: 'cpu-314c-2-dp',
    name: 'CPU 314C-2 DP',
    group: 'compact',
    versions: [v('6ES7 314-6CH04-0AB0', 'V3.3'), v('6ES7 314-6CG03-0AB0', 'V2.6')],
    dp: true,
    pn: false,
    workMemoryKB: 192,
    mBytes: 256,
    timers: 256,
    counters: 256,
    ioBytes: 2048,
    integratedIo: IO_DI24_AI5,
    source: MANUALS,
  }),
  cpu({
    id: 'cpu-314c-2-pn-dp',
    name: 'CPU 314C-2 PN/DP',
    group: 'compact',
    versions: [v('6ES7 314-6EH04-0AB0', 'V3.3')],
    dp: true,
    pn: true,
    workMemoryKB: 192,
    mBytes: 256,
    timers: 256,
    counters: 256,
    ioBytes: 2048,
    integratedIo: [io('DI24/DO16', 136, 3, 136, 2), io('AI5/AO2', 800, 10, 800, 4)],
    source: MAN_2011,
  }),
  // CPU F (in 1B si programma solo la parte standard)
  cpu({
    id: 'cpu-315f-2-dp',
    name: 'CPU 315F-2 DP',
    group: 'failsafe',
    versions: [v('6ES7 315-6FF04-0AB0', 'V3.3'), v('6ES7 315-6FF01-0AB0', 'V2.6')],
    dp: true,
    pn: false,
    workMemoryKB: 384,
    mBytes: 2048,
    timers: 256,
    counters: 256,
    ioBytes: 2048,
    source: `${sheet('6ES7315-6FF04-0AB0', 'https://assets.euautomation.com/uploads/parts/pdf/6es73156ff040ab0.pdf')}; ${sheet('6ES7315-6FF01-0AB0', 'https://www.all4sps.com/mediafiles/Sonstiges/6ES7315-6FF01-0AB0.pdf')}`,
  }),
  cpu({
    id: 'cpu-315f-2-pn-dp',
    name: 'CPU 315F-2 PN/DP',
    group: 'failsafe',
    versions: [v('6ES7 315-2FJ14-0AB0', 'V3.2'), v('6ES7 315-2FH13-0AB0', 'V2.6')],
    dp: true,
    pn: true,
    workMemoryKB: 512,
    mBytes: 2048,
    timers: 256,
    counters: 256,
    ioBytes: 2048,
    source: `${sheet('6ES7315-2FJ14-0AB0', 'https://www.all4sps.com/mediafiles/Sonstiges/6ES7315-2FJ14-0AB0.pdf')}; ${sheet('6ES7315-2FH13-0AB0', 'https://assets.euautomation.com/uploads/parts/pdf/6es73152fh130ab0.pdf')}`,
  }),
  cpu({
    id: 'cpu-317f-2-dp',
    name: 'CPU 317F-2 DP',
    group: 'failsafe',
    versions: [v('6ES7 317-6FF04-0AB0', 'V3.3'), v('6ES7 317-6FF03-0AB0', 'V2.6')],
    dp: true,
    pn: false,
    workMemoryKB: 1536,
    mBytes: 4096,
    timers: 512,
    counters: 512,
    ioBytes: 8192,
    source: `${sheet('6ES7317-6FF04-0AB0', 'https://www.all4sps.com/mediafiles/Sonstiges/6ES7317-6FF04-0AB0.pdf')}; ${sheet('6ES7317-6FF03-0AB0', 'https://assets.euautomation.com/uploads/parts/pdf/6es73176ff030ab0.pdf')}`,
  }),
  cpu({
    id: 'cpu-317f-2-pn-dp',
    name: 'CPU 317F-2 PN/DP',
    group: 'failsafe',
    versions: [v('6ES7 317-2FK14-0AB0', 'V3.2')],
    dp: true,
    pn: true,
    workMemoryKB: 1536,
    mBytes: 4096,
    timers: 512,
    counters: 512,
    ioBytes: 8192,
    source: sheet(
      '6ES7317-2FK14-0AB0',
      'https://www.all4sps.com/mediafiles/Sonstiges/6ES7317-2FK14-0AB0.pdf',
    ),
  }),
  cpu({
    id: 'cpu-319f-3-pn-dp',
    name: 'CPU 319F-3 PN/DP',
    group: 'failsafe',
    versions: [v('6ES7 318-3FL01-0AB0', 'V3.2'), v('6ES7 318-3FL00-0AB0', 'V2.8')],
    dp: true,
    pn: true,
    workMemoryKB: 2560,
    mBytes: 8192,
    timers: 2048,
    counters: 2048,
    ioBytes: 8192,
    source: `${sheet('6ES7318-3FL01-0AB0', 'https://www.all4sps.com/mediafiles/Sonstiges/6ES7318-3FL01-0AB0.pdf')}; ${sheet('6ES7318-3FL00-0AB0', 'https://assets.euautomation.com/uploads/parts/pdf/6es73183fl000ab0.pdf')}`,
  }),
];

const norm = (s: string) => s.replace(/\s+/g, '').toUpperCase();
const BY_ID = new Map(CPU_CATALOG.map((c) => [c.id, c]));
const BY_ORDER = new Map<string, { cpu: CpuType; version: CpuVersion }>();
for (const c of CPU_CATALOG)
  for (const version of c.versions) BY_ORDER.set(norm(version.orderNumber), { cpu: c, version });

export function findCpu(id: string): CpuType | undefined {
  return BY_ID.get(id);
}

export function findCpuByOrderNumber(
  orderNumber: string,
): { cpu: CpuType; version: CpuVersion } | undefined {
  return BY_ORDER.get(norm(orderNumber));
}
