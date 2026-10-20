/** Sezione ADD (mc7 §1.5), little-endian: tabella delle reti e dei salti. */
export interface Mc7Add {
  /** Lunghezza in byte di ogni rete, nell'ordine. */
  networks: number[];
  /** Offset in parole (byte / 2) di ogni istruzione di salto, nell'ordine del file. */
  jumps: number[];
  /** Byte che seguono la tabella dei salti (di norma nessuno), non interpretati. */
  rest: Uint8Array;
}

export const emptyAdd = (): Mc7Add => ({ networks: [], jumps: [], rest: new Uint8Array(0) });

const u16 = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);

/**
 * Legge la struttura dell'ADD. Se non è leggibile (lunghezze che non entrano, reti più lunghe del
 * codice) restituisce `undefined` e il chiamante tiene i byte grezzi.
 */
export function parseAdd(bytes: Uint8Array, mc7Length: number): Mc7Add | undefined {
  if (bytes.length < 4) return undefined;
  const n = u16(bytes, 0);
  let o = 2;
  if (o + 2 * n + 2 > bytes.length) return undefined;
  const networks: number[] = [];
  let sum = 0;
  for (let i = 0; i < n; i++, o += 2) {
    const len = u16(bytes, o);
    networks.push(len);
    sum += len;
  }
  if (sum > mc7Length) return undefined;
  const j = u16(bytes, o);
  o += 2;
  if (o + 2 * j > bytes.length) return undefined;
  const jumps: number[] = [];
  for (let i = 0; i < j; i++, o += 2) jumps.push(u16(bytes, o));
  return { networks, jumps, rest: bytes.slice(o) };
}

/** Serializza un'ADD strutturata. */
export function serializeAdd(add: Mc7Add): Uint8Array {
  const out = new Uint8Array(4 + 2 * add.networks.length + 2 * add.jumps.length + add.rest.length);
  let o = 0;
  const put = (v: number): void => {
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new RangeError(`valore ADD ${v}`);
    out[o++] = v & 0xff;
    out[o++] = v >> 8;
  };
  put(add.networks.length);
  for (const v of add.networks) put(v);
  put(add.jumps.length);
  for (const v of add.jumps) put(v);
  out.set(add.rest, o);
  return out;
}

export function addEquals(a: Mc7Add, b: Mc7Add): boolean {
  return (
    a.networks.length === b.networks.length &&
    a.jumps.length === b.jumps.length &&
    a.rest.length === b.rest.length &&
    a.networks.every((v, i) => v === b.networks[i]) &&
    a.jumps.every((v, i) => v === b.jumps[i]) &&
    a.rest.every((v, i) => v === b.rest[i])
  );
}
