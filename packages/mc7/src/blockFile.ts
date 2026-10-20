import { addEquals, emptyAdd, parseAdd, serializeAdd, type Mc7Add } from './add';

export type BlockKind = 'OB' | 'DB' | 'SDB' | 'FC' | 'SFC' | 'FB' | 'SFB';

export class Mc7Error extends Error {
  readonly code: string;
  constructor(code: 'FORMAT' | 'UNSUPPORTED' | 'COMPILE', message: string) {
    super(message);
    this.name = 'Mc7Error';
    this.code = code;
  }
}

/** Header di 36 byte, big-endian (mc7 §1.2). `raw` conserva i byte esatti. */
export interface Mc7Header {
  raw: Uint8Array;
  kind: BlockKind | undefined;
  kindCode: number;
  number: number;
  language: number;
  flags: number;
  /** header[15] = 3 (mc7 §1.8). Il byte grezzo resta in `raw`. */
  knowHowProtected: boolean;
  /** Lunghezze lette dal file; scrivendo contano le sezioni, non questi tre campi. */
  mc7Length: number;
  ssbLength: number;
  addLength: number;
  localDataLength: number;
  codeTime: Uint8Array;
  interfaceTime: Uint8Array;
}

/** Footer di 36 byte (mc7 §1.6). `raw` conserva i byte esatti. */
export interface Mc7Footer {
  raw: Uint8Array;
  author: string;
  family: string;
  name: string;
  /** "alto.basso" dei due nibble: byte 0x54 = "5.4". */
  version: string;
  checksum: number;
}

export interface Mc7File {
  header: Mc7Header;
  mc7: Uint8Array;
  /** Sezione SSB grezza (interfaccia e valori iniziali): la interpreta il Task 2. */
  ssb: Uint8Array;
  /** ADD letta; vuota se `addRaw` non si legge. */
  add: Mc7Add;
  /** Byte originali della sezione ADD. */
  addRaw: Uint8Array;
  footer: Mc7Footer;
}

const HEADER = 36;
const FOOTER = 36;

const KIND_CODES: Record<number, BlockKind> = {
  0x08: 'OB',
  0x0a: 'DB',
  0x0b: 'SDB',
  0x0c: 'FC',
  0x0d: 'SFC',
  0x0e: 'FB',
  0x0f: 'SFB',
};
const CODE_OF_KIND = Object.fromEntries(
  Object.entries(KIND_CODES).map(([c, k]) => [k, Number(c)]),
) as Record<BlockKind, number>;

const SDB_CODE = 0x0b;

const be16 = (b: Uint8Array, o: number): number => (b[o]! << 8) | b[o + 1]!;
const be32 = (b: Uint8Array, o: number): number =>
  ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;

export function decodeHeader(raw: Uint8Array): Mc7Header {
  const kindCode = raw[5]!;
  return {
    raw,
    kind: KIND_CODES[kindCode],
    kindCode,
    number: be16(raw, 6),
    language: raw[4]!,
    flags: raw[3]!,
    knowHowProtected: raw[15] === 3,
    mc7Length: be16(raw, 34),
    ssbLength: be16(raw, 28),
    addLength: be16(raw, 30),
    localDataLength: be16(raw, 32),
    codeTime: raw.slice(16, 22),
    interfaceTime: raw.slice(22, 28),
  };
}

function decodeText(raw: Uint8Array, o: number): string {
  let s = '';
  for (let i = o; i < o + 8; i++) {
    const c = raw[i]!;
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.replace(/ +$/, '');
}

export function decodeFooter(raw: Uint8Array): Mc7Footer {
  const v = raw[24]!;
  return {
    raw,
    author: decodeText(raw, 0),
    family: decodeText(raw, 8),
    name: decodeText(raw, 16),
    version: `${v >> 4}.${v & 15}`,
    checksum: be16(raw, 26),
  };
}

export function readBlockFile(bytes: Uint8Array): Mc7File {
  if (bytes.length < HEADER + FOOTER) {
    throw new Mc7Error('FORMAT', `file troppo corto: ${bytes.length} byte`);
  }
  if (bytes[0] !== 0x70 || bytes[1] !== 0x70) {
    throw new Mc7Error('FORMAT', 'firma "pp" (70 70) mancante');
  }
  const header = decodeHeader(bytes.slice(0, HEADER));
  const m = header.mc7Length;
  const s = header.ssbLength;
  const a = header.addLength;
  const total = HEADER + m + s + a + FOOTER;
  if (total !== bytes.length) {
    throw new Mc7Error(
      'FORMAT',
      `lunghezze incoerenti: sezioni ${total} byte, file ${bytes.length}`,
    );
  }
  if (be32(bytes, 8) !== bytes.length) {
    throw new Mc7Error(
      'FORMAT',
      `lunghezza nell'header ${be32(bytes, 8)} diversa dal file (${bytes.length})`,
    );
  }
  const mc7 = bytes.slice(HEADER, HEADER + m);
  const ssb = bytes.slice(HEADER + m, HEADER + m + s);
  const addRaw = bytes.slice(HEADER + m + s, HEADER + m + s + a);
  // Gli SDB sono un contenitore opaco: la loro ADD non ha la forma di §1.5.
  const add = header.kindCode === SDB_CODE ? undefined : a > 0 ? parseAdd(addRaw, m) : undefined;
  return {
    header,
    mc7,
    ssb,
    add: add ?? emptyAdd(),
    addRaw,
    footer: decodeFooter(bytes.slice(total - FOOTER)),
  };
}

const checkInt = (what: string, v: number, max: number): void => {
  if (!Number.isInteger(v) || v < 0 || v > max)
    throw new RangeError(`${what} fuori intervallo: ${v}`);
};

function encodeText(what: string, s: string, raw: Uint8Array, o: number, out: Uint8Array): void {
  if (s.length > 8) throw new RangeError(`${what} più lungo di 8 caratteri`);
  // Come il campo originale: riempimento con spazi se lo usava, altrimenti con 00.
  const pad = raw[o + 7] === 0x20 ? 0x20 : 0;
  for (let i = 0; i < 8; i++) {
    const c = s.charCodeAt(i);
    if (i < s.length && c > 0xff) throw new RangeError(`${what}: carattere non Latin-1`);
    out[o + i] = i < s.length ? c : pad;
  }
}

function patchHeader(h: Mc7Header, m: number, s: number, a: number): Uint8Array {
  const out = Uint8Array.from(h.raw);
  if (out.length !== HEADER) throw new Mc7Error('FORMAT', 'header.raw deve essere di 36 byte');
  const was = decodeHeader(h.raw);
  const put16 = (o: number, v: number): void => {
    out[o] = v >> 8;
    out[o + 1] = v & 0xff;
  };
  if (h.kindCode !== was.kindCode) {
    checkInt('kindCode', h.kindCode, 0xff);
    out[5] = h.kindCode;
  } else if (h.kind !== was.kind && h.kind !== undefined) {
    out[5] = CODE_OF_KIND[h.kind];
  }
  if (h.number !== was.number) {
    checkInt('number', h.number, 0xffff);
    put16(6, h.number);
  }
  if (h.language !== was.language) {
    checkInt('language', h.language, 0xff);
    out[4] = h.language;
  }
  if (h.flags !== was.flags) {
    checkInt('flags', h.flags, 0xff);
    out[3] = h.flags;
  }
  if (h.knowHowProtected !== was.knowHowProtected) out[15] = h.knowHowProtected ? 3 : 0;
  if (h.localDataLength !== was.localDataLength) {
    checkInt('localDataLength', h.localDataLength, 0xffff);
    put16(32, h.localDataLength);
  }
  for (const [name, o, v] of [
    ['codeTime', 16, h.codeTime],
    ['interfaceTime', 22, h.interfaceTime],
  ] as const) {
    if (v.length !== 6) throw new RangeError(`${name} deve essere di 6 byte`);
    for (let i = 0; i < 6; i++) out[o + i] = v[i]!;
  }
  checkInt('lunghezza MC7', m, 0xffff);
  checkInt('lunghezza SSB', s, 0xffff);
  checkInt('lunghezza ADD', a, 0xffff);
  put16(34, m);
  put16(28, s);
  put16(30, a);
  const total = HEADER + m + s + a + FOOTER;
  out[8] = total >>> 24;
  out[9] = (total >>> 16) & 0xff;
  out[10] = (total >>> 8) & 0xff;
  out[11] = total & 0xff;
  return out;
}

function patchFooter(f: Mc7Footer): Uint8Array {
  if (f.raw.length !== FOOTER) throw new Mc7Error('FORMAT', 'footer.raw deve essere di 36 byte');
  const out = Uint8Array.from(f.raw);
  const was = decodeFooter(f.raw);
  if (f.author !== was.author) encodeText('autore', f.author, f.raw, 0, out);
  if (f.family !== was.family) encodeText('famiglia', f.family, f.raw, 8, out);
  if (f.name !== was.name) encodeText('nome', f.name, f.raw, 16, out);
  if (f.version !== was.version) {
    const m = /^(\d{1,2})\.(\d{1,2})$/.exec(f.version);
    if (!m || Number(m[1]) > 15 || Number(m[2]) > 15) {
      throw new RangeError(`versione non valida: ${f.version}`);
    }
    out[24] = (Number(m[1]) << 4) | Number(m[2]);
  }
  if (f.checksum !== was.checksum) {
    checkInt('checksum', f.checksum, 0xffff);
    out[26] = f.checksum >> 8;
    out[27] = f.checksum & 0xff;
  }
  return out;
}

export function writeBlockFile(f: Mc7File): Uint8Array {
  // Un'ADD cambiata si riscrive dalla struttura; altrimenti restano i byte originali.
  const parsed =
    f.header.kindCode === SDB_CODE || f.addRaw.length === 0
      ? undefined
      : parseAdd(f.addRaw, f.mc7.length);
  const add = addEquals(f.add, parsed ?? emptyAdd()) ? f.addRaw : serializeAdd(f.add);
  const header = patchHeader(f.header, f.mc7.length, f.ssb.length, add.length);
  const footer = patchFooter(f.footer);
  const out = new Uint8Array(HEADER + f.mc7.length + f.ssb.length + add.length + FOOTER);
  let o = 0;
  for (const part of [header, f.mc7, f.ssb, add, footer]) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}
