/** Helper big-endian e esadecimali. Le letture fuori limite danno RangeError. */

export function readU8(b: Uint8Array, off: number): number {
  if (off < 0 || off + 1 > b.length) throw new RangeError(`readU8 fuori limite: ${off}`);
  return b[off]!;
}

export function readU16(b: Uint8Array, off: number): number {
  if (off < 0 || off + 2 > b.length) throw new RangeError(`readU16 fuori limite: ${off}`);
  return (b[off]! << 8) | b[off + 1]!;
}

export function readU32(b: Uint8Array, off: number): number {
  if (off < 0 || off + 4 > b.length) throw new RangeError(`readU32 fuori limite: ${off}`);
  return ((b[off]! << 24) | (b[off + 1]! << 16) | (b[off + 2]! << 8) | b[off + 3]!) >>> 0;
}

export function writeU8(b: Uint8Array, off: number, v: number): void {
  if (off < 0 || off + 1 > b.length) throw new RangeError(`writeU8 fuori limite: ${off}`);
  b[off] = v & 0xff;
}

export function writeU16(b: Uint8Array, off: number, v: number): void {
  if (off < 0 || off + 2 > b.length) throw new RangeError(`writeU16 fuori limite: ${off}`);
  b[off] = (v >>> 8) & 0xff;
  b[off + 1] = v & 0xff;
}

export function writeU32(b: Uint8Array, off: number, v: number): void {
  if (off < 0 || off + 4 > b.length) throw new RangeError(`writeU32 fuori limite: ${off}`);
  b[off] = (v >>> 24) & 0xff;
  b[off + 1] = (v >>> 16) & 0xff;
  b[off + 2] = (v >>> 8) & 0xff;
  b[off + 3] = v & 0xff;
}

export function hex(bytes: Uint8Array): string {
  let s = '';
  for (const x of bytes) s += x.toString(16).padStart(2, '0');
  return s;
}

/** Accetta spazi (e a-capo) tra i byte. */
export function fromHex(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, '');
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
    throw new RangeError('stringa esadecimale non valida');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
