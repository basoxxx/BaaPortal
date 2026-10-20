import { Mc7Error } from './blockFile';
import type { SsbElement, SsbInterface, SsbSection, SsbType } from './ssb';

/** Voce del layout. `bit` solo per BOOL; `strideBits` per gli ARRAY (passo tra due elementi). */
export interface LayoutOffset {
  path: string;
  byte: number;
  bit?: number;
  type: SsbType;
  strideBits?: number;
}
export interface DataLayout {
  size: number;
  offsets: LayoutOffset[];
}

const NAME_OF: Record<SsbSection, string> = {
  in: 'IN',
  out: 'OUT',
  inOut: 'IN_OUT',
  stat: 'STAT',
  temp: 'TEMP',
  ret: 'RET_VAL',
};
/** Sezioni che occupano spazio in un'istanza, nell'ordine di memoria (mc7 §1.4.8 regola 7). */
const STORED: SsbSection[] = ['in', 'out', 'inOut', 'stat'];

const MAX_ENTRIES = 1_000_000;
/** Un blocco S7-300 non supera i 64 KB (DB, o dati locali e statici di un blocco di codice). */
const MAX_BITS = 65536 * 8;
const tooBig = (what: string): never => {
  throw new RangeError(`layout: ${what} oltre il limite di 65536 byte di un blocco S7-300`);
};

const alignTo = (bits: number, to: 8 | 16): number => Math.ceil(bits / to) * to;
const POINTER_BITS = 48;

const ELEMENTARY_BITS: Record<string, number> = {
  Bool: 1,
  Byte: 8,
  Char: 8,
  Word: 16,
  Int: 16,
  S5Time: 16,
  Date: 16,
  DWord: 32,
  DInt: 32,
  Real: 32,
  Time: 32,
  Time_Of_Day: 32,
};
const PARAMETER_BITS: Record<string, number> = {
  Pointer: 48,
  Any: 80,
  Timer: 16,
  Counter: 16,
  Block_FB: 16,
  Block_FC: 16,
  Block_DB: 16,
  Block_SDB: 16,
};

const isComplex = (t: SsbType): boolean =>
  t.kind === 'string' ||
  t.kind === 'dateAndTime' ||
  t.kind === 'array' ||
  t.kind === 'struct' ||
  t.kind === 'named';

interface Ctx {
  offsets: LayoutOffset[];
  /** Non registra voci (misura soltanto). */
  quiet: boolean;
}

/** Nomi dei fratelli: `name`, o `<SEZIONE><n>` con n = posizione tra quelli della stessa sezione. */
export function generatedNames(els: SsbElement[]): string[] {
  const count: Record<string, number> = {};
  return els.map((e) => {
    const base = NAME_OF[e.section];
    const n = count[base] ?? 0;
    count[base] = n + 1;
    return e.name ?? `${base}${n}`;
  });
}

function arrayCount(dims: { lo: number; hi: number }[]): number {
  let n = 1;
  for (const d of dims) {
    if (d.hi < d.lo)
      throw new Mc7Error('FORMAT', `layout: ARRAY con limiti invertiti ${d.lo}..${d.hi}`);
    n *= d.hi - d.lo + 1;
  }
  return n;
}

function push(ctx: Ctx, path: string, at: number, type: SsbType, stride?: number): void {
  if (ctx.quiet) return;
  if (ctx.offsets.length >= MAX_ENTRIES) throw new Mc7Error('UNSUPPORTED', 'layout: troppe voci');
  const o: LayoutOffset = { path, byte: Math.floor(at / 8), type };
  if (type.kind === 'elementary' && type.name === 'Bool') o.bit = at % 8;
  if (stride !== undefined) o.strideBits = stride;
  ctx.offsets.push(o);
}

/** Dimensione in bit del tipo di un elemento di ARRAY, già arrotondata al suo passo. */
function strideOf(el: SsbElement): number {
  const t = el.type;
  if (t.kind === 'elementary' && t.name === 'Bool') return 1;
  if (t.kind === 'elementary' && (t.name === 'Byte' || t.name === 'Char')) return 8;
  const scratch: Ctx = { offsets: [], quiet: true };
  const end = place(el, 0, '', scratch, false);
  return alignTo(end, 16);
}

/** Colloca un elemento a partire da `cur` (bit); ritorna il bit successivo. */
function place(el: SsbElement, cur: number, path: string, ctx: Ctx, inOut: boolean): number {
  const t = el.type;
  if (t.kind === 'raw' || t.kind === 'void') {
    throw new Mc7Error('UNSUPPORTED', `layout: tipo senza dimensione noto (${path})`);
  }
  if (inOut && isComplex(t)) {
    // Un IN_OUT di tipo complesso è un puntatore di 6 byte (regola 7).
    const at = alignTo(cur, 16);
    push(ctx, path, at, t);
    return at + POINTER_BITS;
  }
  switch (t.kind) {
    case 'elementary': {
      const bits = ELEMENTARY_BITS[t.name]!;
      const at = bits === 1 ? cur : bits === 8 ? alignTo(cur, 8) : alignTo(cur, 16);
      push(ctx, path, at, t);
      return at + bits;
    }
    case 'parameter': {
      const at = alignTo(cur, 16);
      push(ctx, path, at, t);
      return at + PARAMETER_BITS[t.name]!;
    }
    case 'string': {
      const at = alignTo(cur, 16);
      push(ctx, path, at, t);
      return at + (t.length + 2) * 8;
    }
    case 'dateAndTime': {
      const at = alignTo(cur, 16);
      push(ctx, path, at, t);
      return at + 64;
    }
    case 'struct': {
      const at = alignTo(cur, 16);
      push(ctx, path, at, t);
      const end = placeMembers(el.children ?? [], at, path, ctx);
      return at + alignTo(end - at, 16);
    }
    case 'array': {
      const at = alignTo(cur, 16);
      const elem = el.children?.[0];
      if (!elem) throw new Mc7Error('FORMAT', `layout: ARRAY senza elemento (${path})`);
      if (elem.type.kind === 'array') {
        throw new Mc7Error('UNSUPPORTED', `layout: ARRAY di ARRAY (${path})`);
      }
      const stride = strideOf(elem);
      const count = arrayCount(t.dims);
      if (count * stride > MAX_BITS) tooBig(`ARRAY ${path}`);
      push(ctx, path, at, t, stride);
      if (elem.type.kind === 'struct' && !ctx.quiet) {
        // Solo il primo elemento: gli altri seguono col passo.
        const first = t.dims.map((d) => d.lo).join(',');
        placeMembers(elem.children ?? [], at, `${path}[${first}]`, ctx);
      }
      return at + alignTo(count * stride, 16);
    }
    case 'named': {
      // Multi-istanza: la STRUCT dell'FB, sezioni in ordine di memoria.
      const at = alignTo(cur, 16);
      push(ctx, path, at, t);
      const inner = el.children?.[0];
      if (!inner) throw new Mc7Error('FORMAT', `layout: multi-istanza senza struttura (${path})`);
      const end = placeInstance(inner.children ?? [], at, path, ctx);
      return at + alignTo(end - at, 16);
    }
  }
}

function placeMembers(els: SsbElement[], start: number, prefix: string, ctx: Ctx): number {
  let cur = start;
  const names = generatedNames(els);
  els.forEach((e, i) => {
    cur = place(e, cur, prefix ? `${prefix}.${names[i]}` : names[i]!, ctx, false);
  });
  return cur;
}

/** Istanza di FB: IN, OUT, IN_OUT, STAT; TEMP e RET_VAL non occupano spazio (regola 7). */
function placeInstance(els: SsbElement[], start: number, prefix: string, ctx: Ctx): number {
  const names = generatedNames(els);
  let cur = alignTo(start, 16);
  for (const sec of STORED) {
    cur = alignTo(cur, 16);
    els.forEach((e, i) => {
      if (e.section !== sec) return;
      cur = place(e, cur, prefix ? `${prefix}.${names[i]}` : names[i]!, ctx, sec === 'inOut');
    });
    cur = alignTo(cur, 16);
  }
  return cur;
}

/**
 * Layout dei dati (mc7 §1.4.8). DB globale (genere 05): i membri dell'unica STRUCT esterna.
 * DB d'istanza e blocchi di codice: le sezioni IN, OUT, IN_OUT, STAT. Percorsi con nomi generati
 * (`STAT0`, `IN1`, `STAT2[1].STAT0`) se l'elemento non ha `name`; gli ARRAY hanno una voce e,
 * se di STRUCT, le voci del primo elemento sotto `[lo]`.
 */
export function dataLayout(i: SsbInterface): DataLayout {
  const ctx: Ctx = { offsets: [], quiet: false };
  let end: number;
  const top = i.elements[0];
  if (i.header[0] === 0x05) {
    if (i.elements.length !== 1 || top?.type.kind !== 'struct') {
      throw new Mc7Error('FORMAT', 'layout: un DB globale ha una sola STRUCT');
    }
    end = placeMembers(top.children ?? [], 0, '', ctx);
  } else {
    end = placeInstance(i.elements, 0, '', ctx);
  }
  if (end > MAX_BITS) tooBig('area dati');
  return { size: alignTo(end, 16) / 8, offsets: ctx.offsets };
}
