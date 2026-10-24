import type { AreaId, Operand } from '@baaportal/awl';
import { AREA_OF_CODE, parseOffset } from '@baaportal/mc7';
import { SimError } from './errors';
import type { SimMemory } from './memory';
import type { Registers } from './registers';

/** Basi dello stack L: `lBase` del blocco corrente, `prevLBase` del chiamante (area `V`). */
export interface FrameView {
  lBase: number;
  prevLBase: number;
}

/** Posizione risolta: `bit` è l'indirizzo in bit (byte·8 + bit) nell'area; per L/V è assoluto nello stack L. */
export interface Location {
  /** 'P' = periferia da puntatore trasversale: la lettura va a physIn, la scrittura a physOut. */
  area: AreaId | 'V' | 'P';
  db: number | null;
  bit: number;
}

type Size = 'X' | 'B' | 'W' | 'D';

/** Bit utili di un puntatore a 32 bit: byte nei bit 3–18, bit nei bit 0–2 (manuale AWL, «Formato dei puntatori»). */
const ADDR_MASK = 0x7ffff;

function openDb(area: 'DB' | 'DI', explicit: number | undefined, regs: Registers): number {
  const n = explicit ?? (area === 'DB' ? regs.db : regs.di);
  if (n === 0) throw new SimError('DB_NON_APERTO', area);
  return n;
}

/** Aggiunge la base dello stack L: `L` al blocco corrente, `V` al chiamante. */
function place(
  area: AreaId | 'V' | 'P',
  bit: number,
  db: number | null,
  frame: FrameView,
): Location {
  if (area === 'L') return { area, db: null, bit: bit + frame.lBase * 8 };
  if (area === 'V') return { area, db: null, bit: bit + frame.prevLBase * 8 };
  return { area, db, bit };
}

function withDb(
  area: AreaId | 'V' | 'P',
  bit: number,
  explicitDb: number | undefined,
  regs: Registers,
  frame: FrameView,
): Location {
  const db = area === 'DB' || area === 'DI' ? openDb(area, explicitDb, regs) : null;
  return place(area, bit, db, frame);
}

/** Legge il puntatore di un accesso indiretto da memoria (`size` 'W' = 16 bit, 'D' = 32 bit). */
function readPointer(
  loc: Operand,
  size: 'W' | 'D',
  regs: Registers,
  mem: SimMemory,
  frame: FrameView,
): number {
  if (loc.kind !== 'address' || loc.size !== size)
    throw new SimError('MC7_NON_ESEGUIBILE', `puntatore in memoria non ${size}`);
  const l = resolveOperand(loc, regs, mem, frame);
  return readBits(mem, l, size);
}

/** Area dal puntatore per l'accesso trasversale: bit 24–26 (0 = periferia, 7 = V). */
function areaOfPointer(ptr: number): AreaId | 'V' | 'P' {
  // Il bit 31 distingue il puntatore trasversale da quello interno all'area.
  if (ptr >>> 31 === 0) throw new SimError('AREA_LUNGHEZZA', 'puntatore senza area');
  const c = (ptr >>> 24) & 7;
  return c === 7 ? 'V' : c === 0 ? 'P' : AREA_OF_CODE[c]!;
}

export function resolveOperand(
  op: Operand,
  regs: Registers,
  mem: SimMemory,
  frame: FrameView,
): Location {
  switch (op.kind) {
    case 'address':
      return withDb(op.area, op.byte * 8 + (op.bit ?? 0), op.db, regs, frame);
    case 'indirect': {
      if (op.area === 'T' || op.area === 'C')
        throw new SimError('NON_SIMULATA_2B', `accesso indiretto a ${op.area}`);
      if (op.via.kind === 'register') {
        // Manuale AWL, «Indirizzamento indiretto da registro»: AR + offset (P#x.y, 16 bit).
        const off = parseOffset(op.via.offset);
        if (off === undefined) throw new SimError('MC7_NON_ESEGUIBILE', op.via.offset);
        const ar = op.via.ar === 1 ? regs.ar1 : regs.ar2;
        // Interno all'area: l'area è nell'operando. Trasversale: l'area sta nei bit 24–26 di AR.
        const area = op.area ?? areaOfPointer(ar);
        const bit = (ar & ADDR_MASK) + off;
        if (bit > ADDR_MASK) throw new SimError('AREA_LUNGHEZZA', 'indirizzo oltre il puntatore');
        return withDb(area, bit, undefined, regs, frame);
      }
      // Da memoria: a 32 bit per bit e byte/parola/doppia; l'area è nell'operando (o nel puntatore).
      const ptr = readPointer(op.via.location, 'D', regs, mem, frame);
      const area = op.area ?? areaOfPointer(ptr);
      return withDb(area, ptr & ADDR_MASK, undefined, regs, frame);
    }
    default:
      throw new SimError('MC7_NON_ESEGUIBILE', `operando ${op.kind} senza posizione`);
  }
}

/**
 * Numero di T, C o blocco da un accesso indiretto da memoria: puntatore a 16 bit
 * (manuale AWL, «Indirizzamento indiretto da memoria», parola per T/C/blocchi).
 */
export function resolveIndirectNumber(
  op: Operand,
  regs: Registers,
  mem: SimMemory,
  frame: FrameView,
): number {
  if (op.kind !== 'indirect' || op.via.kind !== 'memory')
    throw new SimError('MC7_NON_ESEGUIBILE', 'numero indiretto atteso da memoria');
  return readPointer(op.via.location, 'W', regs, mem, frame);
}

const BYTES: Record<Size, number> = { X: 1, B: 1, W: 2, D: 4 };

export function readBits(mem: SimMemory, loc: Location, size: Size): number {
  const b = mem.bytes(loc.area === 'P' ? 'PI' : loc.area, loc.db, loc.bit >> 3, BYTES[size]);
  if (size === 'X') return (b[0]! >> (loc.bit & 7)) & 1;
  let v = 0;
  for (const x of b) v = v * 256 + x;
  return v;
}

export function writeBits(mem: SimMemory, loc: Location, size: Size, value: number): void {
  const b = mem.bytes(loc.area === 'P' ? 'PQ' : loc.area, loc.db, loc.bit >> 3, BYTES[size]);
  if (size === 'X') {
    const m = 1 << (loc.bit & 7);
    b[0] = value ? b[0]! | m : b[0]! & ~m;
    return;
  }
  let v = value >>> 0;
  for (let i = b.length - 1; i >= 0; i--) {
    b[i] = v & 255;
    v = Math.floor(v / 256);
  }
}
