import type { DataType } from './types';

export type IoArea = 'I' | 'Q' | 'M' | 'PI' | 'PQ';
export type AbsoluteAddress =
  | { area: IoArea; size: 'X'; byte: number; bit: number }
  | { area: IoArea; size: 'B' | 'W' | 'D'; byte: number }
  | { area: 'T' | 'C'; number: number };
export type AddressError = 'SYNTAX' | 'BIT_RANGE' | 'NUMBER_RANGE';

const MAX_NUMBER = 65535;

// Mnemonici (inglesi e tedeschi) -> area.
const AREAS = new Map<string, IoArea | 'T' | 'C'>([
  ['I', 'I'],
  ['E', 'I'],
  ['Q', 'Q'],
  ['A', 'Q'],
  ['M', 'M'],
  ['PI', 'PI'],
  ['PE', 'PI'],
  ['PQ', 'PQ'],
  ['PA', 'PQ'],
  ['T', 'T'],
  ['C', 'C'],
  ['Z', 'C'],
]);

const ADDRESS_RE = /^%?\s*([A-Z]+?)\s*([BWD]?)\s*(\d+)(?:\.(\d+))?$/;
const SIZE_BITS = { X: 1, B: 8, W: 16, D: 32 } as const;

export function parseAddress(
  text: string,
): { ok: true; address: AbsoluteAddress } | { ok: false; error: AddressError } {
  const syntax = { ok: false, error: 'SYNTAX' } as const;
  const match = ADDRESS_RE.exec(text.trim().toUpperCase());
  if (!match) return syntax;
  const [, areaText = '', sizeText = '', numText = '', bitText] = match;
  const area = AREAS.get(areaText);
  if (!area) return syntax;
  const num = Number(numText);

  if (area === 'T' || area === 'C') {
    if (sizeText || bitText !== undefined) return syntax;
    if (num > MAX_NUMBER) return { ok: false, error: 'NUMBER_RANGE' };
    return { ok: true, address: { area, number: num } };
  }

  const peripheral = area === 'PI' || area === 'PQ';
  if (sizeText === '') {
    // Accesso a bit: area.byte.bit (non ammesso sulla periferia).
    if (peripheral || bitText === undefined) return syntax;
    if (num > MAX_NUMBER) return { ok: false, error: 'NUMBER_RANGE' };
    const bit = Number(bitText);
    if (bit > 7) return { ok: false, error: 'BIT_RANGE' };
    return { ok: true, address: { area, size: 'X', byte: num, bit } };
  }
  if (bitText !== undefined) return syntax;
  if (num > MAX_NUMBER) return { ok: false, error: 'NUMBER_RANGE' };
  return { ok: true, address: { area, size: sizeText as 'B' | 'W' | 'D', byte: num } };
}

export function formatAddress(a: AbsoluteAddress): string {
  if ('number' in a) return `%${a.area}${a.number}`;
  if (a.size === 'X') return `%${a.area}${a.byte}.${a.bit}`;
  return `%${a.area}${a.size}${a.byte}`;
}

const FITS = new Map<string, readonly string[]>([
  ['X', ['Bool']],
  ['B', ['Byte', 'Char']],
  ['W', ['Word', 'Int', 'S5Time', 'Date']],
  ['D', ['DWord', 'DInt', 'Real', 'Time', 'Time_Of_Day']],
  ['T', ['Timer']],
  ['C', ['Counter']],
]);

export function addressFitsType(a: AbsoluteAddress, type: DataType): boolean {
  if (type.kind !== 'elementary' && type.kind !== 'parameter') return false;
  const key = 'number' in a ? a.area : a.size;
  return FITS.get(key)?.includes(type.name) ?? false;
}

// Bit assoluti inclusi (byte*8+bit); per T/C il numero.
export function addressBitRange(a: AbsoluteAddress): {
  area: IoArea | 'T' | 'C';
  from: number;
  to: number;
} {
  if ('number' in a) return { area: a.area, from: a.number, to: a.number };
  const from = a.byte * 8 + (a.size === 'X' ? a.bit : 0);
  return { area: a.area, from, to: from + SIZE_BITS[a.size] - 1 };
}

export function rangesOverlap(a: AbsoluteAddress, b: AbsoluteAddress): boolean {
  const ra = addressBitRange(a);
  const rb = addressBitRange(b);
  return ra.area === rb.area && ra.from <= rb.to && rb.from <= ra.to;
}

// Passo = dimensione dell'accesso; non verifica il limite superiore.
export function incrementAddress(a: AbsoluteAddress): AbsoluteAddress {
  if ('number' in a) return { area: a.area, number: a.number + 1 };
  if (a.size === 'X') {
    return a.bit === 7
      ? { area: a.area, size: 'X', byte: a.byte + 1, bit: 0 }
      : { ...a, bit: a.bit + 1 };
  }
  return { ...a, byte: a.byte + SIZE_BITS[a.size] / 8 };
}
