import type { DataType } from '@baaportal/s7-types';

const bcd = (b: number): number => (b >> 4) * 10 + (b & 15);
const pad = (n: number, w: number): string => String(n).padStart(w, '0');
const hexOf = (v: bigint | number, w: number): string =>
  v.toString(16).toUpperCase().padStart(w, '0');

function textOf(chars: ArrayLike<number>): string {
  let s = '';
  for (const c of Array.from(chars)) {
    if (c === 0x27) s += "$'";
    else if (c === 0x24) s += '$$';
    else if (c >= 0x20 && c <= 0x7e) s += String.fromCharCode(c);
    else s += `$${c.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return `'${s}'`;
}

function durationText(ms: number, units: ('D' | 'H' | 'M' | 'S' | 'MS')[]): string {
  const size = { D: 86_400_000, H: 3_600_000, M: 60_000, S: 1000, MS: 1 };
  let rest = ms;
  let out = '';
  for (const u of units) {
    const n = Math.floor(rest / size[u]);
    rest -= n * size[u];
    if (n > 0) out += `${n}${u}`;
  }
  return out === '' ? '0MS' : out;
}

/** Byte di un valore iniziale (little-endian, mc7 §1.4.6) → letterale AWL; undefined se non rappresentabile. */
export function initialLiteral(type: DataType, b: Uint8Array): string | undefined {
  const le = (n: number): bigint => {
    let v = 0n;
    for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]!);
    return v;
  };
  if (type.kind === 'string') return textOf(b.subarray(2, 2 + b[1]!));
  if (type.kind === 'dateAndTime') {
    const y = bcd(b[0]!);
    const ms = bcd(b[6]!) * 10 + (b[7]! >> 4);
    return `DT#${y >= 90 ? 1900 + y : 2000 + y}-${pad(bcd(b[1]!), 2)}-${pad(bcd(b[2]!), 2)}-${pad(bcd(b[3]!), 2)}:${pad(bcd(b[4]!), 2)}:${pad(bcd(b[5]!), 2)}.${pad(ms, 3)}`;
  }
  if (type.kind !== 'elementary') return undefined;
  switch (type.name) {
    case 'Bool':
      return b[0] ? 'TRUE' : 'FALSE';
    case 'Byte':
      return `16#${hexOf(le(1), 2)}`;
    case 'Word':
      return `16#${hexOf(le(2), 4)}`;
    case 'DWord':
      return `16#${hexOf(le(4), 8)}`;
    case 'Char':
      return textOf([b[0]!]);
    case 'Int':
      return String(BigInt.asIntN(16, le(2)));
    case 'DInt':
      return String(BigInt.asIntN(32, le(4)));
    case 'Real': {
      const v = new DataView(b.buffer, b.byteOffset, 4).getFloat32(0, true);
      return Number.isFinite(v) ? String(v) : undefined;
    }
    case 'S5Time': {
      const w = Number(le(2));
      const d = [(w >> 8) & 15, (w >> 4) & 15, w & 15];
      const ms = (d[0]! * 100 + d[1]! * 10 + d[2]!) * 10 * 10 ** ((w >> 12) & 3);
      return `S5T#${durationText(ms, ['H', 'M', 'S', 'MS'])}`;
    }
    case 'Time': {
      const v = Number(BigInt.asIntN(32, le(4)));
      return `T#${v < 0 ? '-' : ''}${durationText(Math.abs(v), ['D', 'H', 'M', 'S', 'MS'])}`;
    }
    case 'Date': {
      const d = new Date(Date.UTC(1990, 0, 1) + Number(le(2)) * 86_400_000);
      return `D#${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`;
    }
    case 'Time_Of_Day': {
      const v = Number(le(4));
      const h = Math.floor(v / 3_600_000);
      const mi = Math.floor(v / 60_000) % 60;
      const s = Math.floor(v / 1000) % 60;
      return `TOD#${pad(h, 2)}:${pad(mi, 2)}:${pad(s, 2)}.${pad(v % 1000, 3)}`;
    }
  }
}
