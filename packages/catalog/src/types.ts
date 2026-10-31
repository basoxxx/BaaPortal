import type { TypedMember } from '@baaportal/s7-types';

export interface CpuVersion {
  orderNumber: string;
  firmware: string[]; // dal più recente
}

export interface CpuType {
  id: string;
  name: string;
  group: 'standard' | 'compact' | 'failsafe';
  versions: CpuVersion[]; // dalla più recente
  interfaces: { mpi: boolean; dp: boolean; pn: boolean };
  workMemoryKB: number;
  limits: {
    mBytes: number;
    timers: number;
    counters: number;
    inputBytes: number;
    outputBytes: number;
    maxFb: number;
    maxFc: number;
    maxDb: number;
    localDataBytesPerClass: number;
    /** Blocchi annidati per classe di priorità (manuale delle CPU 31x, dati tecnici). */
    blockNesting: number;
  };
  retentiveMax: { mBytes: number; timers: number; counters: number };
  obs: number[];
  /**
   * I/O integrato delle CPU compatte 31xC (posto 2), agli indirizzi predefiniti dei dati tecnici;
   * byte di ingresso e di uscita per sottomodulo. Assente nelle altre CPU.
   */
  integratedIo?: { name: string; inputs: ByteRange; outputs: ByteRange }[];
  source: string;
}

interface ByteRange {
  start: number;
  bytes: number;
}

export interface ObDefinition {
  number: number;
  eventKey: string; // chiave i18n ob.event.<n>
  defaultName: string;
  startInfo: TypedMember[];
}
