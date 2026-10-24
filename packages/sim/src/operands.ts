import type { AreaId, Operand } from '@baaportal/awl';
import { AREA_OF_CODE, parseOffset } from '@baaportal/mc7';
import { SimError } from './errors';
import type { SimMemory } from './memory';
import type { Registers } from './registers';

/** Basi dello stack L: `lBase` del blocco corrente, `prevLBase` del chiamante (area `V`). */
export interface FrameView {
  lBase: number;
  prevLBase: number;
  /** Byte della finestra L del blocco e di quella del chiamante (V); senza, vale solo il limite dell'area. */
  lSize?: number;
  prevLSize?: number;
  /** Parametri attuali di una FC: posizioni assolute risolte dalla lista dei puntatori (null = non in memoria). */
  params?: readonly (Location | null)[];
  /** Voci grezze della lista dei puntatori: per TIMER e COUNTER il numero sta nei primi 2 byte (mc7 §2.5). */
  rawParams?: readonly Uint8Array[];
}

/** Posizione risolta: `bit` è l'indirizzo in bit (byte·8 + bit) nell'area; per L/V è assoluto nello stack L. */
export interface Location {
  /** 'P' = periferia da puntatore trasversale: la lettura va a physIn, la scrittura a physOut. */
  area: AreaId | 'V' | 'P';
  db: number | null;
  bit: number;
  /** Fine (byte, esclusa) della finestra dello stack L entro cui l'accesso deve stare. */
  limit?: number;
}

type Size = 'X' | 'B' | 'W' | 'D';

/** Bit utili di un puntatore a 32 bit: byte nei bit 3–18, bit nei bit 0–2 (manuale AWL S7-300/400, indirizzamento indiretto). */
const ADDR_MASK = 0x7ffff;

function openDb(area: 'DB' | 'DI', explicit: number | undefined, regs: Registers): number {
  const n = explicit ?? (area === 'DB' ? regs.db : regs.di);
  if (n === 0) throw new SimError('DB_NON_APERTO', area);
  return n;
}

function window(area: 'L' | 'V', bit: number, base: number, size: number | undefined): Location {
  return size === undefined ? { area, db: null, bit } : { area, db: null, bit, limit: base + size };
}

/** Aggiunge la base dello stack L: `L` al blocco corrente, `V` al chiamante. */
function place(
  area: AreaId | 'V' | 'P',
  bit: number,
  db: number | null,
  frame: FrameView,
): Location {
  if (area === 'L') return window(area, bit + frame.lBase * 8, frame.lBase, frame.lSize);
  if (area === 'V')
    return window(area, bit + frame.prevLBase * 8, frame.prevLBase, frame.prevLSize);
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

/** Indice del parametro dal nome generato `PAR<n>` (`PARW<offset>` = offset in byte, pari). */
function formalIndex(name: string | undefined): number {
  const m = /^PAR(W?)(\d+)$/.exec(name ?? '');
  if (!m) throw new SimError('MC7_NON_ESEGUIBILE', `operando locale #${name ?? '?'}`);
  const n = Number(m[2]);
  if (!m[1]) return n;
  if (n < 2 || n % 2) throw new SimError('MC7_NON_ESEGUIBILE', `parametro formale ${name}`);
  return n / 2 - 1;
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
        // Manuale AWL S7-300/400, indirizzamento indiretto: AR + offset (P#x.y, 16 bit).
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
    case 'local': {
      // Parametro formale di FC (`#PAR<n>`, mc7 §2.2.6): la posizione viene dalla lista dei puntatori.
      const idx = formalIndex(op.path[0]?.name);
      const p = frame.params?.[idx];
      if (!p) throw new SimError('NON_SIMULATA_2B', `parametro formale #${op.path[0]?.name}`);
      return p;
    }
    default:
      throw new SimError('MC7_NON_ESEGUIBILE', `operando ${op.kind} senza posizione`);
  }
}

/**
 * Numero di T o C passato come parametro formale di una FC (`#T_IN`): i primi 2 byte della voce
 * della lista dei puntatori (mc7 §2.5, ⚠️ solo [DN]); una voce con area (p[0] >= 0x80) non è un numero.
 */
export function formalTcNumber(op: Operand, frame: FrameView): number {
  if (op.kind !== 'local') throw new SimError('MC7_NON_ESEGUIBILE', 'parametro formale atteso');
  const p = frame.rawParams?.[formalIndex(op.path[0]?.name)];
  if (!p || p[0]! >= 0x80)
    throw new SimError('MC7_NON_ESEGUIBILE', `parametro formale #${op.path[0]?.name} senza numero`);
  return (p[0]! << 8) | p[1]!;
}

/**
 * Numero di T, C o blocco da un accesso indiretto da memoria: puntatore a 16 bit
 * (manuale AWL S7-300/400, indirizzamento indiretto, parola per T/C/blocchi).
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

function checkWindow(loc: Location, size: Size): void {
  if (loc.limit !== undefined && (loc.bit >> 3) + BYTES[size] > loc.limit)
    throw new SimError('AREA_LUNGHEZZA', `${loc.area} byte ${loc.bit >> 3} fuori dalla finestra`);
}

export function readBits(mem: SimMemory, loc: Location, size: Size): number {
  checkWindow(loc, size);
  const b = mem.bytes(loc.area === 'P' ? 'PI' : loc.area, loc.db, loc.bit >> 3, BYTES[size]);
  if (size === 'X') return (b[0]! >> (loc.bit & 7)) & 1;
  let v = 0;
  for (const x of b) v = v * 256 + x;
  return v;
}

export function writeBits(mem: SimMemory, loc: Location, size: Size, value: number): void {
  checkWindow(loc, size);
  const periph = loc.area === 'P' || loc.area === 'PQ';
  const b = mem.bytes(loc.area === 'P' ? 'PQ' : loc.area, loc.db, loc.bit >> 3, BYTES[size]);
  store(b, loc.bit & 7, size, value);
  // ⚠️ L'accesso diretto alle uscite di periferia aggiorna anche la PIQ (Q), se l'indirizzo vi cade.
  if (periph && (loc.bit >> 3) + BYTES[size] <= mem.Q.length)
    store(mem.Q.subarray(loc.bit >> 3, (loc.bit >> 3) + BYTES[size]), loc.bit & 7, size, value);
}

function store(b: Uint8Array, bit: number, size: Size, value: number): void {
  if (size === 'X') {
    const m = 1 << bit;
    b[0] = value ? b[0]! | m : b[0]! & ~m;
    return;
  }
  let v = value >>> 0;
  for (let i = b.length - 1; i >= 0; i--) {
    b[i] = v & 255;
    v = Math.floor(v / 256);
  }
}
