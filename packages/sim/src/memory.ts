import type { AreaId } from '@baaportal/awl';
import { findCpu } from '@baaportal/catalog';
import { SimError } from './errors';

/** Dimensioni delle aree, dal catalogo: inputBytes, outputBytes, mBytes, localDataBytesPerClass. */
export interface MemorySizes {
  inputs: number;
  outputs: number;
  flags: number;
  localBytes: number;
}

const DEFAULT_CPU = 'cpu-315-2-pn-dp';

/** Una CPU sconosciuta usa i valori di una 315-2 PN/DP. */
export function memorySizesFor(cpuTypeId: string): MemorySizes {
  const cpu = findCpu(cpuTypeId) ?? findCpu(DEFAULT_CPU);
  if (!cpu) throw new Error(`catalogo senza ${DEFAULT_CPU}`);
  const l = cpu.limits;
  return {
    inputs: l.inputBytes,
    outputs: l.outputBytes,
    flags: l.mBytes,
    localBytes: l.localDataBytesPerClass,
  };
}

export interface SimDb {
  data: Uint8Array;
  initial: Uint8Array;
  retentive: boolean;
}

/** Memoria della CPU simulata. Tutte le aree sono big-endian (lettura/scrittura in `operands.ts`). */
export class SimMemory {
  readonly I: Uint8Array;
  readonly Q: Uint8Array;
  readonly M: Uint8Array;
  /** Byte dello stack L di ogni classe di priorità (`localDataBytesPerClass`). */
  readonly localBytes: number;
  /** Stack L per classe di priorità (manuale delle CPU 31x): ogni classe ha il suo. */
  private readonly lStacks = new Map<number, Uint8Array>();
  private currentL: Uint8Array;
  /** Periferia: PI legge `physIn`, PQ scrive `physOut`. */
  readonly physIn: Uint8Array;
  readonly physOut: Uint8Array;
  dbs = new Map<number, SimDb>();
  /**
   * Byte di periferia raggiungibili (1 = un modulo presente li copre), dalla configurazione hardware;
   * senza configurazione tutto il campo di I/O della CPU.
   */
  periphery: { in: Uint8Array; out: Uint8Array } | undefined;

  constructor(sizes: MemorySizes) {
    this.I = new Uint8Array(sizes.inputs);
    this.Q = new Uint8Array(sizes.outputs);
    this.M = new Uint8Array(sizes.flags);
    this.localBytes = sizes.localBytes;
    this.currentL = this.lStack(1);
    this.physIn = new Uint8Array(sizes.inputs);
    this.physOut = new Uint8Array(sizes.outputs);
  }

  /** Stack dei dati locali della classe di priorità in esecuzione, condiviso fra i suoi blocchi. */
  get L(): Uint8Array {
    return this.currentL;
  }

  /** Stack L della classe `prio` (creato alla prima richiesta). */
  lStack(prio: number): Uint8Array {
    let s = this.lStacks.get(prio);
    if (!s) this.lStacks.set(prio, (s = new Uint8Array(this.localBytes)));
    return s;
  }

  /** Rende `L` lo stack della classe `prio`; restituisce quello di prima, da ripassare a `restoreL`. */
  selectL(prio: number): Uint8Array {
    const prev = this.currentL;
    this.currentL = this.lStack(prio);
    return prev;
  }

  restoreL(prev: Uint8Array): void {
    this.currentL = prev;
  }

  /**
   * Vista di `length` byte dall'offset indicato. `V` (dati locali del chiamante) sta nello
   * stesso array di `L`: l'offset è già assoluto (lo calcola `resolveOperand`).
   * Errori: AREA_LUNGHEZZA (fuori area), DB_NON_CARICATO (DB/DI assente).
   */
  bytes(area: AreaId | 'V', db: number | null, byteOffset: number, length: number): Uint8Array {
    let arr: Uint8Array;
    switch (area) {
      case 'I':
        arr = this.I;
        break;
      case 'Q':
        arr = this.Q;
        break;
      case 'M':
        arr = this.M;
        break;
      case 'L':
      case 'V':
        arr = this.L;
        break;
      case 'PI':
        arr = this.physIn;
        break;
      case 'PQ':
        arr = this.physOut;
        break;
      case 'DB':
      case 'DI': {
        const block = db === null ? undefined : this.dbs.get(db);
        if (!block) throw new SimError('DB_NON_CARICATO', `DB${db ?? '?'}`, { faultReg: db ?? 0 });
        arr = block.data;
        break;
      }
      default:
        throw new SimError('MC7_NON_ESEGUIBILE', `area ${area}`);
    }
    const io = area === 'PI' ? this.periphery?.in : area === 'PQ' ? this.periphery?.out : undefined;
    const missing = io && io.subarray(byteOffset, byteOffset + length).includes(0);
    if (
      !Number.isInteger(byteOffset) ||
      byteOffset < 0 ||
      byteOffset + length > arr.length ||
      missing
    )
      throw new SimError(
        'AREA_LUNGHEZZA',
        `${area} byte ${byteOffset} lunghezza ${length}`,
        // Periferia oltre il campo di I/O o senza modulo: è l'evento di OB122, non di OB121.
        area === 'PI' || area === 'PQ' ? { periphery: { byte: byteOffset, width: length } } : {},
      );
    return arr.subarray(byteOffset, byteOffset + length);
  }
}
