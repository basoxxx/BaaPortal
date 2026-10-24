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
  /** Stack dei dati locali, condiviso fra i blocchi in esecuzione. */
  readonly L: Uint8Array;
  /** Periferia: PI legge `physIn`, PQ scrive `physOut`. */
  readonly physIn: Uint8Array;
  readonly physOut: Uint8Array;
  dbs = new Map<number, SimDb>();

  constructor(sizes: MemorySizes) {
    this.I = new Uint8Array(sizes.inputs);
    this.Q = new Uint8Array(sizes.outputs);
    this.M = new Uint8Array(sizes.flags);
    this.L = new Uint8Array(sizes.localBytes);
    this.physIn = new Uint8Array(sizes.inputs);
    this.physOut = new Uint8Array(sizes.outputs);
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
        if (!block) throw new SimError('DB_NON_CARICATO', `DB${db ?? '?'}`);
        arr = block.data;
        break;
      }
      default:
        throw new SimError('NON_SIMULATA_2B', `area ${area}`);
    }
    if (!Number.isInteger(byteOffset) || byteOffset < 0 || byteOffset + length > arr.length)
      throw new SimError('AREA_LUNGHEZZA', `${area} byte ${byteOffset} lunghezza ${length}`);
    return arr.subarray(byteOffset, byteOffset + length);
  }
}
