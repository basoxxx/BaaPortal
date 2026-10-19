import type { DataType, TypedMember } from './types';

export interface FbSections {
  input: TypedMember[];
  output: TypedMember[];
  inOut: TypedMember[];
  static: TypedMember[];
}
export type TypeResolver = (
  name: string,
) => { kind: 'udt'; members: TypedMember[] } | { kind: 'fb'; sections: FbSections } | null;
export interface LayoutEntry {
  path: string;
  byte: number;
  bit: number;
  sizeBits: number;
  strideBits?: number; // solo per gli Array
}
export type LayoutResult =
  | { ok: true; sizeBytes: number; entries: LayoutEntry[] }
  | { ok: false; error: 'UNKNOWN_TYPE' | 'CYCLE' | 'NOT_LAYOUTABLE'; name: string };

class LayoutFail extends Error {
  constructor(
    readonly code: 'UNKNOWN_TYPE' | 'CYCLE' | 'NOT_LAYOUTABLE',
    readonly typeName: string,
  ) {
    super(code);
  }
}

interface Ctx {
  resolve: TypeResolver;
  entries: LayoutEntry[];
  active: string[]; // nomi in corso di risoluzione (rilevamento cicli)
}

const POINTER_BITS = 48;

const ELEMENTARY_BITS = new Map<string, number>([
  ['Bool', 1],
  ['Byte', 8],
  ['Char', 8],
  ['Word', 16],
  ['Int', 16],
  ['S5Time', 16],
  ['Date', 16],
  ['DWord', 32],
  ['DInt', 32],
  ['Real', 32],
  ['Time', 32],
  ['Time_Of_Day', 32],
]);
const PARAMETER_BITS = new Map<string, number>([
  ['Timer', 16],
  ['Counter', 16],
  ['Block_FB', 16],
  ['Block_FC', 16],
  ['Block_DB', 16],
  ['Block_SDB', 16],
  ['Pointer', 48],
  ['Any', 80],
]);

const evenByteBits = (bits: number) => Math.ceil(bits / 16) * 16;
const alignEven = evenByteBits;
const alignByte = (bits: number) => Math.ceil(bits / 8) * 8;

function arrayCount(dims: { lo: number; hi: number }[]): number {
  return dims.reduce((n, d) => n * (d.hi - d.lo + 1), 1);
}

// Dimensione e allineamento dei tipi semplici; null per i tipi composti.
function simple(type: DataType): { bits: number; align: (c: number) => number } | null {
  switch (type.kind) {
    case 'elementary': {
      const bits = ELEMENTARY_BITS.get(type.name) as number;
      if (bits === 1) return { bits, align: (c) => c };
      return { bits, align: bits === 8 ? alignByte : alignEven };
    }
    case 'string':
      return { bits: (type.length + 2) * 8, align: alignEven };
    case 'dateAndTime':
      return { bits: 64, align: alignEven };
    case 'parameter':
      return { bits: PARAMETER_BITS.get(type.name) as number, align: alignEven };
    default:
      return null;
  }
}

// Disposizione di un tipo composto a partire da `base`; ritorna il bit finale (non arrotondato).
function placeComposite(type: DataType, base: number, path: string, ctx: Ctx): number {
  if (type.kind === 'struct') return placeMembers(type.members, base, path, ctx, false);
  if (type.kind !== 'named') throw new LayoutFail('NOT_LAYOUTABLE', type.kind);
  if (ctx.active.includes(type.name)) throw new LayoutFail('CYCLE', type.name);
  const found = ctx.resolve(type.name);
  if (!found) throw new LayoutFail('UNKNOWN_TYPE', type.name);
  ctx.active.push(type.name);
  try {
    return found.kind === 'udt'
      ? placeMembers(found.members, base, path, ctx, false)
      : placeSections(found.sections, base, path, ctx);
  } finally {
    ctx.active.pop();
  }
}

// Dimensione in bit di un tipo (elemento di array), senza lasciare voci.
function measure(type: DataType, ctx: Ctx): number {
  const s = simple(type);
  if (s) return s.bits;
  if (type.kind === 'array') {
    return evenByteBits(arrayCount(type.dims) * strideOf(type.element, ctx));
  }
  const scratch: Ctx = { ...ctx, entries: [] };
  return evenByteBits(placeComposite(type, 0, '', scratch));
}

function strideOf(element: DataType, ctx: Ctx): number {
  if (element.kind === 'array') throw new LayoutFail('NOT_LAYOUTABLE', 'Array');
  if (element.kind === 'elementary' && element.name === 'Bool') return 1;
  const bits = measure(element, ctx);
  // Ogni elemento segue l'allineamento del suo tipo: Byte/Char a 8 bit, il resto a byte pari.
  const isByte =
    element.kind === 'elementary' && (element.name === 'Byte' || element.name === 'Char');
  return isByte ? 8 : evenByteBits(bits);
}

function isComplex(type: DataType): boolean {
  return (
    type.kind === 'string' ||
    type.kind === 'dateAndTime' ||
    type.kind === 'array' ||
    type.kind === 'struct' ||
    type.kind === 'named'
  );
}

function placeMembers(
  members: TypedMember[],
  start: number,
  prefix: string,
  ctx: Ctx,
  inOut: boolean,
): number {
  let cursor = start;
  for (const member of members) {
    const path = prefix ? `${prefix}.${member.name}` : member.name;
    const type = member.type;
    const push = (at: number, sizeBits: number, strideBits?: number) => {
      const e: LayoutEntry = { path, byte: Math.floor(at / 8), bit: at % 8, sizeBits };
      if (strideBits !== undefined) e.strideBits = strideBits;
      ctx.entries.push(e);
    };

    if (inOut && isComplex(type)) {
      // Il tipo deve comunque esistere, anche se in InOut occupa solo un puntatore.
      if (type.kind === 'named') {
        if (ctx.active.includes(type.name)) throw new LayoutFail('CYCLE', type.name);
        if (!ctx.resolve(type.name)) throw new LayoutFail('UNKNOWN_TYPE', type.name);
      }
      cursor = alignEven(cursor);
      push(cursor, POINTER_BITS);
      cursor += POINTER_BITS;
      continue;
    }

    const s = simple(type);
    if (s) {
      cursor = s.align(cursor);
      push(cursor, s.bits);
      cursor += s.bits;
    } else if (type.kind === 'array') {
      cursor = alignEven(cursor);
      const stride = strideOf(type.element, ctx);
      const size = evenByteBits(arrayCount(type.dims) * stride);
      push(cursor, size, stride);
      cursor += size;
    } else {
      cursor = alignEven(cursor);
      const at = cursor;
      const index = ctx.entries.length;
      push(at, 0);
      const end = placeComposite(type, at, path, ctx);
      const size = evenByteBits(end - at);
      (ctx.entries[index] as LayoutEntry).sizeBits = size;
      cursor = at + size;
    }
  }
  return cursor;
}

function placeSections(sections: FbSections, start: number, prefix: string, ctx: Ctx): number {
  let cursor = alignEven(start);
  const order: [TypedMember[], boolean][] = [
    [sections.input, false],
    [sections.output, false],
    [sections.inOut, true],
    [sections.static, false],
  ];
  for (const [members, inOut] of order) {
    cursor = alignEven(placeMembers(members, alignEven(cursor), prefix, ctx, inOut));
  }
  return cursor;
}

function run(fn: (ctx: Ctx) => number, resolve: TypeResolver): LayoutResult {
  const ctx: Ctx = { resolve, entries: [], active: [] };
  try {
    const end = fn(ctx);
    return { ok: true, sizeBytes: evenByteBits(end) / 8, entries: ctx.entries };
  } catch (e) {
    if (e instanceof LayoutFail) return { ok: false, error: e.code, name: e.typeName };
    throw e;
  }
}

// DB, UDT, Temp.
export function layoutStruct(members: TypedMember[], resolve: TypeResolver): LayoutResult {
  return run((ctx) => placeMembers(members, 0, '', ctx, false), resolve);
}

// Dati di istanza di un FB.
export function layoutInstance(sections: FbSections, resolve: TypeResolver): LayoutResult {
  return run((ctx) => placeSections(sections, 0, '', ctx), resolve);
}

export function formatOffset(e: { byte: number; bit: number }): string {
  return `${e.byte}.${e.bit}`;
}
