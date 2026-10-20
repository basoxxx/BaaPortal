import {
  parseLiteral,
  type ArrayDim,
  type DataType,
  type ElementaryTypeName,
  type ParameterTypeName,
  type TypeResolver,
  type TypedMember,
} from '@baaportal/s7-types';
import { Mc7Error, type BlockKind } from './blockFile';
import { DAY0, s5TimeWord, unitsToMs } from './constants';

/**
 * Interfaccia del blocco (sezione SSB, mc7 §1.4): righe di dichiarazione e valori iniziali.
 * Interi in little-endian. L'MC7 non contiene nomi (mc7 §4): `name` resta indefinito.
 */
export type SsbSection = 'in' | 'out' | 'inOut' | 'stat' | 'temp' | 'ret';

/** Codice di tipo senza `DataType` (mc7 §1.4.2): si conserva il codice grezzo. */
export interface RawType {
  kind: 'raw';
  code: number;
}
/**
 * Tipo di una riga. Le multi-istanze (`15`/`1b`) sono `{ kind: 'named', name: 'FB<n>' | 'SFB<n>' }`.
 * I membri di una `struct` letta dall'SSB hanno `name: ''`; i figli autorevoli sono in `children`.
 */
export type SsbType = DataType | RawType;

export interface SsbElement {
  name?: string;
  section: SsbSection;
  type: SsbType;
  /** Byte dei valori iniziali di questa riga (mc7 §1.4.6); presente se la riga ha il flag 08. */
  initial?: Uint8Array;
  /** STRUCT: i membri. ARRAY: un solo figlio (la riga dell'elemento). Multi-istanza: la STRUCT dell'FB. */
  children?: SsbElement[];
  /** Byte esatti della riga (senza figli). Vuoto: la riga si codifica dai campi. */
  raw: Uint8Array;
}

export interface SsbInterface {
  /** 7 byte (mc7 §1.4.1). Le lunghezze I e V si ricalcolano scrivendo. */
  header: Uint8Array;
  elements: SsbElement[];
  /** Byte di riempimento finale (mc7 §1.4.7). */
  tail: Uint8Array;
}

const SECTIONS: SsbSection[] = ['in', 'out', 'inOut', 'stat', 'temp', 'ret'];
const SECTION_CODE: Record<SsbSection, number> = {
  in: 1,
  out: 2,
  inOut: 3,
  stat: 4,
  temp: 5,
  ret: 6,
};

const HEADER = 7;
const MAX_DEPTH = 48;
const MULTI_FB = 0x15;
const MULTI_SFB = 0x1b;
const T_ARRAY = 0x10;
const T_STRUCT = 0x11;
const T_STRING = 0x13;
const T_DT = 0x0e;

const ELEMENTARY_CODE: Record<ElementaryTypeName, number> = {
  Bool: 0x01,
  Byte: 0x02,
  Char: 0x03,
  Word: 0x04,
  Int: 0x05,
  DWord: 0x06,
  DInt: 0x07,
  Real: 0x08,
  Date: 0x09,
  Time_Of_Day: 0x0a,
  Time: 0x0b,
  S5Time: 0x0c,
};
const PARAMETER_CODE: Record<ParameterTypeName, number> = {
  Pointer: 0x14,
  Any: 0x16,
  Block_FB: 0x17,
  Block_FC: 0x18,
  Block_DB: 0x19,
  Block_SDB: 0x1a,
  Counter: 0x1c,
  Timer: 0x1d,
};
const SIMPLE_TYPE = new Map<number, DataType>();
for (const [name, code] of Object.entries(ELEMENTARY_CODE)) {
  SIMPLE_TYPE.set(code, { kind: 'elementary', name: name as ElementaryTypeName });
}
for (const [name, code] of Object.entries(PARAMETER_CODE)) {
  SIMPLE_TYPE.set(code, { kind: 'parameter', name: name as ParameterTypeName });
}
SIMPLE_TYPE.set(T_DT, { kind: 'dateAndTime' });

/** Byte di valore iniziale per i tipi a lunghezza fissa. */
const INITIAL_SIZE: Record<ElementaryTypeName, number> = {
  Bool: 1,
  Byte: 1,
  Char: 1,
  Word: 2,
  Int: 2,
  Date: 2,
  S5Time: 2,
  DWord: 4,
  DInt: 4,
  Real: 4,
  Time: 4,
  Time_Of_Day: 4,
};

// ---------------------------------------------------------------------------------------------
// Testa di una riga (senza figli)
// ---------------------------------------------------------------------------------------------

/** Campi significativi di una riga. Il resto (bit alti di `pt`, byte esteso) sta solo in `raw`. */
interface Head {
  code: number;
  /** Assente nelle multi-istanze (`15`/`1b`), che non hanno `pt`. */
  section?: number;
  flag: boolean;
  number?: number;
  len?: number;
  dims?: ArrayDim[];
  count?: number;
}
interface ParsedHead {
  head: Head;
  ext: number | undefined;
  /** Bit 5-7 di `pt`, sconosciuti: si conservano. */
  hi: number;
  length: number;
}

const i16 = (b: Uint8Array, o: number): number => {
  const v = b[o]! | (b[o + 1]! << 8);
  return v >= 0x8000 ? v - 0x10000 : v;
};

function parseHead(b: Uint8Array, pos: number, end: number): ParsedHead {
  const need = (n: number): void => {
    if (pos + n > end) throw new Mc7Error('FORMAT', `SSB: riga troncata a ${pos}`);
  };
  need(1);
  const code = b[pos]!;
  if (code === MULTI_FB || code === MULTI_SFB) {
    need(3);
    return {
      head: { code, flag: false, number: b[pos + 1]! | (b[pos + 2]! << 8) },
      ext: undefined,
      hi: 0,
      length: 3,
    };
  }
  need(2);
  const pt = b[pos + 1]!;
  const section = pt & 7;
  if (section < 1 || section > 6) {
    throw new Mc7Error('FORMAT', `SSB: sezione ${section} non valida alla riga ${pos}`);
  }
  const head: Head = { code, section, flag: (pt & 0x08) !== 0 };
  let p = pos + 2;
  let ext: number | undefined;
  if (pt & 0x10) {
    need(p - pos + 1);
    ext = b[p++];
  }
  if (code === T_STRING) {
    need(p - pos + 1);
    head.len = b[p++];
  } else if (code === T_ARRAY) {
    need(p - pos + 1);
    const dd = b[p++]!;
    if (dd === 0) throw new Mc7Error('FORMAT', `SSB: ARRAY senza dimensioni alla riga ${pos}`);
    need(p - pos + 4 * dd);
    head.dims = [];
    for (let k = 0; k < dd; k++) {
      head.dims.push({ lo: i16(b, p), hi: i16(b, p + 2) });
      p += 4;
    }
  } else if (code === T_STRUCT) {
    need(p - pos + 1);
    let count = b[p++]!;
    if (count === 0xff) {
      need(p - pos + 2);
      count = b[p]! | (b[p + 1]! << 8);
      p += 2;
    }
    head.count = count;
  }
  return { head, ext, hi: pt & 0xe0, length: p - pos };
}

function encodeHead(h: Head, ext: number | undefined, hi: number): number[] {
  const out: number[] = [h.code];
  if (h.number !== undefined) {
    out.push(h.number & 0xff, h.number >> 8);
    return out;
  }
  out.push(h.section! | (h.flag ? 0x08 : 0) | (ext !== undefined ? 0x10 : 0) | hi);
  if (ext !== undefined) out.push(ext);
  if (h.len !== undefined) out.push(h.len);
  if (h.dims) {
    out.push(h.dims.length);
    for (const d of h.dims)
      out.push(d.lo & 0xff, (d.lo >> 8) & 0xff, d.hi & 0xff, (d.hi >> 8) & 0xff);
  }
  if (h.count !== undefined) {
    if (h.count < 0xff) out.push(h.count);
    else out.push(0xff, h.count & 0xff, h.count >> 8);
  }
  return out;
}

const sameHead = (a: Head, b: Head): boolean =>
  a.code === b.code &&
  a.section === b.section &&
  a.flag === b.flag &&
  a.number === b.number &&
  a.len === b.len &&
  a.count === b.count &&
  JSON.stringify(a.dims) === JSON.stringify(b.dims);

// ---------------------------------------------------------------------------------------------
// Lettura
// ---------------------------------------------------------------------------------------------

const isMultiCode = (c: number): boolean => c === MULTI_FB || c === MULTI_SFB;

function typeOf(h: Head, children: SsbElement[] | undefined): SsbType {
  const simple = SIMPLE_TYPE.get(h.code);
  if (simple) return simple;
  switch (h.code) {
    case T_STRING:
      return { kind: 'string', length: h.len! };
    case T_ARRAY:
      return { kind: 'array', dims: h.dims!, element: children![0]!.type as DataType };
    case T_STRUCT:
      return {
        kind: 'struct',
        members: children!.map((c) => ({ name: '', type: c.type as DataType })),
      };
    case MULTI_FB:
      return { kind: 'named', name: `FB${h.number}` };
    case MULTI_SFB:
      return { kind: 'named', name: `SFB${h.number}` };
    default:
      return { kind: 'raw', code: h.code };
  }
}

function readRow(b: Uint8Array, pos: number, end: number, depth: number): [SsbElement, number] {
  if (depth > MAX_DEPTH) throw new Mc7Error('FORMAT', 'SSB: annidamento troppo profondo');
  const ph = parseHead(b, pos, end);
  const h = ph.head;
  let next = pos + ph.length;
  let children: SsbElement[] | undefined;
  if (h.code === T_ARRAY || isMultiCode(h.code)) {
    const [child, n] = readRow(b, next, end, depth + 1);
    if (isMultiCode(h.code) && child.raw[0] !== T_STRUCT) {
      throw new Mc7Error('FORMAT', `SSB: dopo la multi-istanza alla riga ${pos} manca la STRUCT`);
    }
    children = [child];
    next = n;
  } else if (h.code === T_STRUCT) {
    // Ogni riga occupa almeno 2 byte: un conteggio impossibile si scarta prima di ciclare.
    if (h.count! * 2 > end - next) throw new Mc7Error('FORMAT', `SSB: STRUCT troncata a ${pos}`);
    children = [];
    for (let k = 0; k < h.count!; k++) {
      const [child, n] = readRow(b, next, end, depth + 1);
      children.push(child);
      next = n;
    }
  }
  const el: SsbElement = {
    section: isMultiCode(h.code) ? 'stat' : SECTIONS[h.section! - 1]!,
    type: typeOf(h, children),
    raw: b.slice(pos, pos + ph.length),
  };
  if (children) el.children = children;
  return [el, next];
}

const hasFlag = (e: SsbElement): boolean => !isMultiCode(e.raw[0]!) && (e.raw[1]! & 0x08) !== 0;

function fixedInitialSize(t: SsbType): number | undefined {
  if (t.kind === 'elementary') return INITIAL_SIZE[t.name];
  if (t.kind === 'dateAndTime') return 8;
  return undefined;
}

/** Assegna i valori iniziali alle righe con il flag 08, in ordine di riga (mc7 §1.4.6). */
function assignInitials(els: SsbElement[], v: Uint8Array, state: { pos: number }): void {
  for (const e of els) {
    if (hasFlag(e)) {
      const t = e.type;
      let size: number | undefined;
      if (t.kind === 'string') {
        if (state.pos + 2 > v.length) throw new Mc7Error('FORMAT', 'SSB: valori iniziali troncati');
        size = 2 + v[state.pos + 1]!;
      } else if (t.kind === 'array') {
        // Flag sulla riga ARRAY: 6 byte non decodificati + valore dell'elemento (mc7 §1.4.6).
        const elSize = fixedInitialSize(t.element);
        if (elSize === undefined) {
          throw new Mc7Error('UNSUPPORTED', 'SSB: valore iniziale su ARRAY di elementi non fissi');
        }
        size = 6 + elSize;
      } else {
        size = fixedInitialSize(t);
        if (size === undefined) {
          throw new Mc7Error('UNSUPPORTED', `SSB: valore iniziale su una riga di tipo ${t.kind}`);
        }
      }
      if (state.pos + size > v.length)
        throw new Mc7Error('FORMAT', 'SSB: valori iniziali troncati');
      e.initial = v.slice(state.pos, state.pos + size);
      state.pos += size;
    }
    if (e.children) assignInitials(e.children, v, state);
  }
}

export function readSsb(ssb: Uint8Array, kind: BlockKind): SsbInterface {
  if (ssb.length === 0) {
    return { header: new Uint8Array(0), elements: [], tail: new Uint8Array(0) };
  }
  if (kind === 'SDB') throw new Mc7Error('UNSUPPORTED', 'SSB: gli SDB non hanno interfaccia');
  if (ssb.length < HEADER) throw new Mc7Error('FORMAT', `SSB troppo corto: ${ssb.length} byte`);
  const genre = ssb[0]!;
  if (kind === 'DB' ? genre !== 0x05 && genre !== 0x0a && genre !== 0x10 : genre !== 0x01) {
    throw new Mc7Error('FORMAT', `SSB: genere ${genre.toString(16)} non valido per ${kind}`);
  }
  const rowsLen = ssb[3]! | (ssb[4]! << 8);
  const initLen = ssb[5]! | (ssb[6]! << 8);
  const rowsEnd = HEADER + rowsLen;
  const initEnd = rowsEnd + initLen;
  if (initEnd > ssb.length) {
    throw new Mc7Error(
      'FORMAT',
      `SSB: righe e valori (${initEnd} byte) oltre la sezione (${ssb.length})`,
    );
  }
  // La sezione ha lunghezza pari: 0 o 1 byte di riempimento (mc7 §1.4.7).
  if (ssb.length - initEnd !== (initEnd & 1)) {
    throw new Mc7Error('FORMAT', `SSB: ${ssb.length - initEnd} byte dopo i valori iniziali`);
  }
  const elements: SsbElement[] = [];
  let pos = HEADER;
  while (pos < rowsEnd) {
    const [el, next] = readRow(ssb, pos, rowsEnd, 0);
    elements.push(el);
    pos = next;
  }
  const state = { pos: 0 };
  const values = ssb.slice(rowsEnd, initEnd);
  assignInitials(elements, values, state);
  if (state.pos !== values.length) {
    throw new Mc7Error(
      'FORMAT',
      `SSB: valori iniziali non consumati (${state.pos} di ${values.length} byte)`,
    );
  }
  return { header: ssb.slice(0, HEADER), elements, tail: ssb.slice(initEnd) };
}

// ---------------------------------------------------------------------------------------------
// Scrittura
// ---------------------------------------------------------------------------------------------

const MULTI_NAME = /^(FB|SFB)(\d+)$/;

function desiredHead(e: SsbElement, path: string): Head {
  const t = e.type;
  const flag = e.initial !== undefined;
  const section = SECTION_CODE[e.section];
  switch (t.kind) {
    case 'raw':
      if (!Number.isInteger(t.code) || t.code < 0 || t.code > 0xff) {
        throw new RangeError(`${path}: codice di tipo ${t.code} non valido`);
      }
      return { code: t.code, section, flag };
    case 'elementary':
      return { code: ELEMENTARY_CODE[t.name], section, flag };
    case 'parameter':
      return { code: PARAMETER_CODE[t.name], section, flag };
    case 'dateAndTime':
      return { code: T_DT, section, flag };
    case 'string':
      if (!Number.isInteger(t.length) || t.length < 1 || t.length > 254) {
        throw new RangeError(`${path}: lunghezza STRING ${t.length} fuori da 1..254`);
      }
      return { code: T_STRING, section, flag, len: t.length };
    case 'array': {
      if (t.dims.length < 1 || t.dims.length > 255) {
        throw new RangeError(`${path}: un ARRAY ha da 1 a 255 dimensioni`);
      }
      for (const d of t.dims) {
        for (const x of [d.lo, d.hi]) {
          if (!Number.isInteger(x) || x < -32768 || x > 32767) {
            throw new RangeError(`${path}: limite ARRAY ${x} fuori da -32768..32767`);
          }
        }
        if (d.lo > d.hi) throw new RangeError(`${path}: limiti ARRAY invertiti (${d.lo}..${d.hi})`);
      }
      if (e.children?.length !== 1) {
        throw new RangeError(`${path}: un ARRAY ha esattamente un figlio (il tipo dell'elemento)`);
      }
      return { code: T_ARRAY, section, flag, dims: t.dims };
    }
    case 'struct': {
      const count = e.children?.length;
      if (count === undefined) throw new RangeError(`${path}: la STRUCT non ha figli`);
      if (count > 0xffff) throw new RangeError(`${path}: troppi membri (${count})`);
      return { code: T_STRUCT, section, flag, count };
    }
    case 'named': {
      const m = MULTI_NAME.exec(t.name);
      if (!m) {
        throw new RangeError(
          `${path}: il tipo ${t.name} non è una multi-istanza (FB<n> o SFB<n>) e non è espanso`,
        );
      }
      const number = Number(m[2]);
      if (number > 0xffff) throw new RangeError(`${path}: numero di blocco ${number} oltre 65535`);
      if (flag) throw new RangeError(`${path}: una multi-istanza non ha valore iniziale`);
      if (e.children?.length !== 1 || e.children[0]!.type.kind !== 'struct') {
        throw new RangeError(`${path}: la multi-istanza ha come figlio la STRUCT dell'FB`);
      }
      return { code: m[1] === 'FB' ? MULTI_FB : MULTI_SFB, flag: false, number };
    }
    case 'void':
      throw new RangeError(`${path}: il tipo void non ha riga SSB`);
  }
}

function encodeRow(e: SsbElement, path: string): Uint8Array {
  const want = desiredHead(e, path);
  if (
    want.code !== T_ARRAY &&
    want.code !== T_STRUCT &&
    !isMultiCode(want.code) &&
    e.children?.length
  ) {
    throw new RangeError(`${path}: un tipo semplice non ha figli`);
  }
  let ext: number | undefined;
  let hi = 0;
  if (e.raw.length > 0) {
    try {
      const old = parseHead(e.raw, 0, e.raw.length);
      if (old.length === e.raw.length && sameHead(old.head, want)) return e.raw;
      ext = old.ext;
      hi = old.hi;
    } catch (err) {
      if (!(err instanceof Mc7Error)) throw err;
    }
  }
  return Uint8Array.from(encodeHead(want, ext, hi));
}

function emit(
  els: SsbElement[],
  rows: Uint8Array[],
  inits: Uint8Array[],
  prefix: string,
  depth: number,
): void {
  if (depth > MAX_DEPTH) throw new RangeError(`${prefix || 'SSB'}: annidamento troppo profondo`);
  els.forEach((e, i) => {
    const path = e.name ?? `${prefix}${prefix ? '.' : ''}#${i}`;
    rows.push(encodeRow(e, path));
    if (e.initial) inits.push(e.initial);
    if (e.children) emit(e.children, rows, inits, path, depth + 1);
  });
}

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};

export function writeSsb(i: SsbInterface): Uint8Array {
  if (i.header.length === 0) {
    if (i.elements.length > 0) throw new RangeError('SSB: intestazione mancante');
    return new Uint8Array(0);
  }
  if (i.header.length !== HEADER) throw new RangeError('SSB: header di 7 byte richiesto');
  const rows: Uint8Array[] = [];
  const inits: Uint8Array[] = [];
  emit(i.elements, rows, inits, '', 0);
  const r = concat(rows);
  const v = concat(inits);
  if (r.length > 0xffff) throw new RangeError(`SSB: righe oltre 65535 byte (${r.length})`);
  if (v.length > 0xffff)
    throw new RangeError(`SSB: valori iniziali oltre 65535 byte (${v.length})`);
  const need = (HEADER + r.length + v.length) & 1;
  const tail = i.tail.length === need ? i.tail : new Uint8Array(need);
  const head = Uint8Array.from(i.header);
  head[3] = r.length & 0xff;
  head[4] = r.length >> 8;
  head[5] = v.length & 0xff;
  head[6] = v.length >> 8;
  return concat([head, r, v, tail]);
}

// ---------------------------------------------------------------------------------------------
// Costruzione per il compilatore
// ---------------------------------------------------------------------------------------------

export interface BuildSsbOptions {
  /** Numero scritto nell'intestazione (DB: numero del DB; blocchi di codice: 0 se omesso). */
  number?: number;
  /** Genere dell'intestazione; predefinito 05 per `DB` (globale) e 01 per gli altri. */
  genre?: number;
  /** Risolve i tipi `named`: UDT (espansi in STRUCT) e FB (multi-istanza). */
  resolve?: TypeResolver;
  /** Numero e tipo di blocco di un FB risolto; predefinito: dal nome `FB<n>` / `SFB<n>`. */
  blockNumber?: (name: string) => { block: 'FB' | 'SFB'; number: number } | undefined;
}

const SECTION_ORDER: SsbSection[] = ['in', 'out', 'inOut', 'stat', 'temp', 'ret'];

const BCD = (n: number): number => ((Math.floor(n / 10) % 10) << 4) | (n % 10);

function unescapeText(text: string): number[] {
  const inner = Array.from(text.slice(1, -1));
  const out: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (c !== '$') {
      out.push(c.codePointAt(0)!);
      continue;
    }
    const n = inner[i + 1]!;
    const hexPair = n + (inner[i + 2] ?? '');
    if (/^[0-9a-fA-F]{2}$/.test(hexPair)) {
      out.push(parseInt(hexPair, 16));
      i += 2;
      continue;
    }
    i++;
    switch (n.toUpperCase()) {
      case "'":
      case '$':
        out.push(n.charCodeAt(0));
        break;
      case 'L':
      case 'N':
        out.push(0x0a);
        break;
      case 'P':
        out.push(0x0c);
        break;
      case 'R':
        out.push(0x0d);
        break;
      default: // T
        out.push(0x09);
    }
  }
  return out;
}

/** Codifica un letterale canonico (uscita di `parseLiteral`) come in mc7 §1.4.6. */
function encodeCanonical(type: DataType, canon: string): number[] {
  const le = (n: bigint, bytes: number): number[] => {
    const out: number[] = [];
    let v = BigInt.asUintN(bytes * 8, n);
    for (let k = 0; k < bytes; k++) {
      out.push(Number(v & 0xffn));
      v >>= 8n;
    }
    return out;
  };
  if (type.kind === 'string') {
    const chars = unescapeText(canon);
    return [type.length, chars.length, ...chars];
  }
  if (type.kind === 'dateAndTime') {
    const m = /^DT#(\d{4})-(\d\d)-(\d\d)-(\d\d):(\d\d):(\d\d)\.(\d{3})$/.exec(canon)!;
    const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map((k) => Number(m[k]));
    const ms = m[7]!;
    const weekday = new Date(Date.UTC(y!, mo! - 1, d!)).getUTCDay() + 1; // domenica = 1
    return [
      BCD(y! % 100),
      BCD(mo!),
      BCD(d!),
      BCD(h!),
      BCD(mi!),
      BCD(s!),
      (Number(ms[0]) << 4) | Number(ms[1]),
      (Number(ms[2]) << 4) | weekday,
    ];
  }
  if (type.kind !== 'elementary') throw new Error('tipo senza valore iniziale');
  switch (type.name) {
    case 'Bool':
      return [canon === 'true' ? 1 : 0];
    case 'Byte':
    case 'Word':
    case 'DWord':
      return le(BigInt(`0x${canon.slice(3)}`), INITIAL_SIZE[type.name]);
    case 'Int':
      return le(BigInt(canon), 2);
    case 'DInt':
      return le(BigInt(canon), 4);
    case 'Real': {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setFloat32(0, Number(canon), true);
      return [...b];
    }
    case 'S5Time': {
      // Stessa regola dell'istruzione `L S5T#…` (mc7 §2.3): una funzione sola.
      return le(BigInt(s5TimeWord(unitsToMs(canon.slice(4)))), 2);
    }
    case 'Time': {
      const neg = canon.startsWith('T#-');
      const ms = unitsToMs(canon.slice(neg ? 3 : 2));
      return le(BigInt(neg ? -ms : ms), 4);
    }
    case 'Date': {
      const m = /^D#(\d{4})-(\d\d)-(\d\d)$/.exec(canon)!;
      const days = (Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - DAY0) / 86_400_000;
      return le(BigInt(days), 2);
    }
    case 'Time_Of_Day': {
      const m = /^TOD#(\d\d):(\d\d):(\d\d)\.(\d{3})$/.exec(canon)!;
      const ms = ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]);
      return le(BigInt(ms), 4);
    }
    case 'Char':
      return [unescapeText(canon)[0]!];
  }
}

class Builder {
  readonly used = new Set<string>();
  constructor(
    readonly initials: Record<string, string>,
    readonly opts: BuildSsbOptions,
  ) {}

  private blockOf(name: string): { block: 'FB' | 'SFB'; number: number } | undefined {
    if (this.opts.blockNumber) return this.opts.blockNumber(name);
    const m = MULTI_NAME.exec(name);
    return m ? { block: m[1] as 'FB' | 'SFB', number: Number(m[2]) } : undefined;
  }

  member(m: TypedMember, section: SsbSection, prefix: string): SsbElement {
    const path = prefix ? `${prefix}.${m.name}` : m.name;
    return this.typed(m.type, section, path);
  }

  private initialOf(type: DataType, path: string): Uint8Array | undefined {
    const text = this.initials[path];
    if (text === undefined) return undefined;
    this.used.add(path);
    if (type.kind === 'array') {
      throw new Mc7Error(
        'UNSUPPORTED',
        `${path}: il valore iniziale di un ARRAY non è codificabile (formato non decodificato, mc7 §1.4.6)`,
      );
    }
    const r = parseLiteral(type, text);
    if (!r.ok) throw new RangeError(`${path}: valore iniziale "${text}" non valido (${r.error})`);
    return Uint8Array.from(encodeCanonical(type, r.canonical));
  }

  typed(type: DataType, section: SsbSection, path: string): SsbElement {
    const raw = new Uint8Array(0);
    switch (type.kind) {
      case 'array': {
        this.initialOf(type, path); // un valore iniziale di ARRAY dà errore prima di scendere
        return { section, type, children: [this.typed(type.element, section, path)], raw };
      }
      case 'struct': {
        const children = type.members.map((m) => this.member(m, section, path));
        return { section, type, children, raw };
      }
      case 'named': {
        const found = this.opts.resolve?.(type.name);
        if (!found) throw new RangeError(`${path}: tipo ${type.name} sconosciuto`);
        if (found.kind === 'udt') {
          return this.typed({ kind: 'struct', members: found.members }, section, path);
        }
        const blk = this.blockOf(type.name);
        if (!blk) throw new RangeError(`${path}: numero di blocco di ${type.name} sconosciuto`);
        const s = found.sections;
        const members: [SsbSection, TypedMember[]][] = [
          ['in', s.input],
          ['out', s.output],
          ['inOut', s.inOut],
          ['stat', s.static],
        ];
        const children: SsbElement[] = [];
        const structMembers: TypedMember[] = [];
        for (const [sec, list] of members) {
          for (const m of list) {
            children.push(this.member(m, sec, path));
            structMembers.push(m);
          }
        }
        const inner: SsbElement = {
          section: 'stat',
          type: { kind: 'struct', members: structMembers },
          children,
          raw,
        };
        return {
          section: 'stat',
          type: { kind: 'named', name: `${blk.block}${blk.number}` },
          children: [inner],
          raw,
        };
      }
      default: {
        const initial = this.initialOf(type, path);
        const out: SsbElement = { section, type, raw };
        if (initial) out.initial = initial;
        return out;
      }
    }
  }
}

/**
 * Costruisce un SSB da sezioni tipizzate e valori iniziali in testo AWL, chiavi = percorsi con
 * punto (`membro.sottomembro`; per un ARRAY OF STRUCT i membri dell'elemento, scritti una volta,
 * mc7 §1.4.6). Un letterale non valido o una chiave sconosciuta danno `RangeError` col percorso.
 */
export function buildSsb(
  sections: Record<SsbSection, TypedMember[]>,
  initials: Record<string, string>,
  kind: BlockKind,
  opts: BuildSsbOptions = {},
): Uint8Array {
  const b = new Builder(initials, opts);
  let elements: SsbElement[];
  if (kind === 'DB') {
    for (const sec of SECTION_ORDER) {
      if (sec !== 'stat' && sections[sec].length > 0) {
        throw new RangeError(`un DB globale ha solo variabili STAT (sezione ${sec})`);
      }
    }
    const structType: DataType = { kind: 'struct', members: sections.stat };
    elements = [b.typed(structType, 'stat', '')];
  } else {
    elements = [];
    for (const sec of SECTION_ORDER) {
      if (kind === 'FC' && sec === 'stat' && sections.stat.length > 0) {
        throw new RangeError('un FC non ha variabili STAT');
      }
      for (const m of sections[sec]) elements.push(b.member(m, sec, ''));
    }
  }
  for (const key of Object.keys(initials)) {
    if (!b.used.has(key)) throw new RangeError(`${key}: nessuna variabile con questo percorso`);
  }
  const number = opts.number ?? 0;
  if (!Number.isInteger(number) || number < 0 || number > 0xffff) {
    throw new RangeError(`numero ${number} fuori intervallo`);
  }
  const genre = opts.genre ?? (kind === 'DB' ? 0x05 : 0x01);
  const header = Uint8Array.of(genre, number & 0xff, number >> 8, 0, 0, 0, 0);
  return writeSsb({ header, elements, tail: new Uint8Array(0) });
}
