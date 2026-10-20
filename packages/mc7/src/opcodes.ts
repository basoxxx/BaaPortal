import type { AreaId, Operand, Statement } from '@baaportal/awl';
import { Mc7Error } from './blockFile';
import { decodeLoadConstant, encodeLoadConstant, parseConstant } from './constants';
import {
  AREA_CODE,
  AREA_OF_CODE,
  address,
  blockRef,
  constant,
  formalName,
  formatOperand,
  indirectMem,
  indirectReg,
  labelRef,
  locationOf,
  locationOperand,
  NO_RANGE,
  offsetText,
  parseOffset,
  parsePointer,
  plainAddress,
  pointerText,
  specialOp,
  statusOp,
  timerCounter,
  type FormalParam,
  type FormalType,
} from './operands';

/**
 * Tabella delle istruzioni MC7 dell'S7-300 (mc7 §2.6): una forma per ogni modo di codificare un
 * `id` di `INSTRUCTIONS`, con codifica e decodifica di una sola istruzione.
 *
 * La tabella è una struttura nostra, scritta dai fatti di mc7 §2: ogni forma ha un modello di byte
 * (`bytes`, `mask`) disgiunto da quello delle altre, e due funzioni (operando → byte e byte →
 * operando) tenute accanto al modello.
 */

/** Una forma di un'istruzione. I byte oltre `bytes` sono dati (indirizzo, numero, costante). */
export interface Mc7Form {
  /** `id` internazionale di `INSTRUCTIONS`. */
  id: string;
  /**
   * Tipo di operando: `address` (A, L, T… su indirizzi assoluti), `indirect` (da memoria o da
   * registro), `constant`, `timerCounter`, `block`, `jump`, `ar` (registri d'indirizzo),
   * `special` (condizioni di stato, STW, parametri formali di FC).
   */
  operand:
    | 'none'
    | 'address'
    | 'indirect'
    | 'constant'
    | 'timerCounter'
    | 'block'
    | 'jump'
    | 'ar'
    | 'special';
  /** Byte fissi iniziali dell'istruzione (la parte che identifica la forma). */
  bytes: number[];
  /** Un byte per ogni byte di `bytes`: i bit a 1 sono fissi. Se manca, tutti i bit sono fissi. */
  mask?: number[];
  /** Lunghezza in byte (mc7 §2.7); per le forme `variable` quella senza i puntatori. */
  length: number;
  /** Vista in un blocco reale (mc7 §2.6, «reale»); falso se viene solo da fonti di terzi. */
  verified: boolean;
  /** UC/CC di FC/SFC: segue `jjjj` (ultimi 2 byte di `length`) e (jjjj − 2)/2 puntatori da 4 byte. */
  variable?: boolean;
}

/**
 * Istruzione decodificata.
 *
 * **Contratto di ricodifica:** i byte originali si riottengono con `encodeDecoded(stmt)`, mai dal
 * solo `text`. Il testo è AWL leggibile ma non basta: non porta la lista dei puntatori di UC/CC
 * FC/SFC (`pointers`), il numero indiretto di `UC FC [mem]` (`indirectBlock`), il parametro
 * formale `#par` (`formal`: nome, offset e tipo originali), il byte di tipo di una costante
 * (`constantType`) né lo spostamento di un salto (`jumpWords`). Per questo i campi che portano
 * questi metadati sono `readonly`: vanno conservati così come sono. Una forma valida ma non
 * canonica (`nonCanonical`) viene riscritta da `encodeDecoded` nella forma di STEP 7, quindi i byte
 * originali vanno conservati a parte.
 */
export interface DecodedStatement {
  /** `id` internazionale dell'istruzione. */
  readonly id: string;
  /**
   * Testo AWL internazionale canonico (la riga di `formatNetwork` senza tabulazione né `;`). Salti:
   * etichetta segnaposto `L_<offset>`.
   */
  readonly text: string;
  /** Salti: byte di destinazione, nella stessa base di `code` passato a `decodeInstruction`. */
  readonly jumpTo?: number;
  /** Salti: `jjjj` con segno (JL: numero di voci della lista), per `encodeJump`. */
  readonly jumpWords?: number;
  /** Byte di tipo di una costante che il testo non riesce a portare (mc7 §2.3, §3.2). */
  readonly constantType?: number;
  /** UC/CC di FC/SFC: i puntatori d'area della lista dei parametri (4 byte ciascuno). */
  readonly pointers?: readonly Uint8Array[];
  /** Accesso a un parametro formale di FC: il nome generato nel testo e il suo significato. */
  readonly formal?: { readonly name: string; readonly offset: number; readonly type: FormalType };
  /** UC/CC FC/FB con numero indiretto: il testo non è AWL del parser; si riscrive con `encodeDecoded`. */
  readonly extended?: true;
  readonly indirectBlock?: { readonly block: 'FC' | 'FB'; readonly location: Operand };
  /** Forma valida ma non quella che STEP 7 genera (mc7 §3.3): il codificatore scrive la canonica. */
  readonly nonCanonical?: true;
  /** L'operando strutturato (per `encodeDecoded`). */
  readonly operand?: Operand;
}

export interface EncodeOptions {
  /** Costante di `L`: byte di tipo da usare al posto di quello implicito nel testo. */
  constantType?: number;
  /** UC/CC di FC/SFC: puntatori d'area (4 byte ciascuno) della lista dei parametri. */
  pointers?: readonly ArrayLike<number>[];
  /** Salti: `jjjj` (spostamento in parole dall'istruzione; JL: numero di voci). */
  jumpWords?: number;
  /** Risolve `#nome` in un parametro formale di FC (mc7 §2.2.6). */
  formal?: (name: string) => FormalParam | undefined;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface Insn {
  id: string;
  operand?: Operand | undefined;
  indirectBlock?: { block: 'FC' | 'FB'; location: Operand } | undefined;
  pointers?: readonly ArrayLike<number>[] | undefined;
  constantType?: number | undefined;
  jumpWords?: number | undefined;
  formal?: { name: string; offset: number; type: FormalType } | undefined;
}
interface Cx {
  formal(op: Operand | undefined): FormalParam | undefined;
}
type Enc = (i: Insn, cx: Cx) => number[] | null;
type Part = Omit<Insn, 'id'> & { length: number };
type Dec = (c: Uint8Array, at: number) => Part | null;

interface Impl {
  form: Mc7Form;
  enc: Enc;
  dec: Dec;
  jump?: 'rel' | 'list';
  extended?: boolean;
}

const IMPLS: Impl[] = [];
const BY_ID = new Map<string, Impl[]>();

interface DefArgs {
  id: string;
  op: Mc7Form['operand'];
  bytes: number[];
  mask?: number[];
  length: number;
  enc: Enc;
  dec: Dec;
  variable?: boolean;
  jump?: 'rel' | 'list';
  extended?: boolean;
}
function def(a: DefArgs): void {
  const form: Mc7Form = {
    id: a.id,
    operand: a.op,
    bytes: a.bytes,
    ...(a.mask ? { mask: a.mask } : {}),
    length: a.length,
    verified: false,
    ...(a.variable ? { variable: true } : {}),
  };
  const impl: Impl = { form, enc: a.enc, dec: a.dec };
  if (a.jump) impl.jump = a.jump;
  if (a.extended) impl.extended = true;
  IMPLS.push(impl);
  const l = BY_ID.get(a.id) ?? [];
  l.push(impl);
  BY_ID.set(a.id, l);
}

// ---------------------------------------------------------------------------------------------
// Aiuti

const rd16 = (c: Uint8Array, i: number): number => (c[i]! << 8) | c[i + 1]!;
const w16 = (n: number): number[] => [(n >> 8) & 255, n & 255];
const isU16 = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 0xffff;
function localOp(name: string): Operand {
  return { kind: 'local', path: [{ name, quoted: false, range: NO_RANGE }], range: NO_RANGE };
}
function formalOf(i: Insn, cx: Cx, ...types: FormalType[]): FormalParam | undefined {
  if (i.operand?.kind !== 'local') return undefined;
  const f = cx.formal(i.operand);
  return f && types.includes(f.type) && isU16(f.offset) ? f : undefined;
}
function formalPart(offset: number, type: FormalType, length: number): Part {
  const name = formalName(offset);
  return { operand: localOp(name), formal: { name, offset, type }, length };
}

/** Intero decimale dell'operando costante, nell'intervallo dato. */
function intOperand(op: Operand | undefined, max: number): number | undefined {
  if (op?.kind !== 'constant' || op.pointerTo || !/^\d+$/.test(op.text.trim())) return undefined;
  const v = Number(op.text);
  return v <= max ? v : undefined;
}

const none =
  (bytes: number[]): Enc =>
  (i) =>
    i.operand === undefined && !i.indirectBlock ? bytes : null;

/** Forme senza operando: `id` → byte. */
const NO_OPERAND: [string, number[]][] = [
  ['O', [0xfb, 0x00]],
  ['A(', [0xba, 0x00]],
  ['AN(', [0xff, 0xf1]],
  ['O(', [0xbb, 0x00]],
  ['ON(', [0xff, 0xf3]],
  ['X(', [0xff, 0xf4]],
  ['XN(', [0xff, 0xf5]],
  [')', [0xbf, 0x00]],
  ['NOT', [0x68, 0x2d]],
  ['SET', [0x68, 0x1d]],
  ['CLR', [0x68, 0x1c]],
  ['SAVE', [0x68, 0x2c]],
  ['BTI', [0x68, 0x0c]],
  ['ITB', [0x68, 0x08]],
  ['BTD', [0x68, 0x0e]],
  ['ITD', [0x68, 0x1e]],
  ['DTB', [0x68, 0x0a]],
  ['DTR', [0x68, 0x06]],
  ['INVI', [0x01, 0x00]],
  ['INVD', [0x68, 0x0d]],
  ['NEGI', [0x09, 0x00]],
  ['NEGD', [0x68, 0x07]],
  ['NEGR', [0x60, 0x06]],
  ['CAW', [0x68, 0x1a]],
  ['CAD', [0x68, 0x1b]],
  ['RND', [0x68, 0x5c]],
  ['TRUNC', [0x68, 0x5f]],
  ['RND+', [0x68, 0x5e]],
  ['RND-', [0x68, 0x5d]],
  ['+I', [0x79, 0x00]],
  ['-I', [0x59, 0x00]],
  ['*I', [0x60, 0x04]],
  ['/I', [0x60, 0x00]],
  ['MOD', [0x60, 0x01]],
  ['+D', [0x60, 0x0d]],
  ['-D', [0x60, 0x09]],
  ['*D', [0x60, 0x0a]],
  ['/D', [0x60, 0x0e]],
  ['+R', [0x60, 0x0f]],
  ['-R', [0x60, 0x0b]],
  ['*R', [0x60, 0x07]],
  ['/R', [0x60, 0x03]],
  ['ABS', [0x60, 0x02]],
  ['SQR', [0x60, 0x1c]],
  ['SQRT', [0x60, 0x14]],
  ['EXP', [0x60, 0x1b]],
  ['LN', [0x60, 0x13]],
  ['SIN', [0x60, 0x10]],
  ['COS', [0x60, 0x11]],
  ['TAN', [0x60, 0x12]],
  ['ASIN', [0x60, 0x18]],
  ['ACOS', [0x60, 0x19]],
  ['ATAN', [0x60, 0x1a]],
  ['CDB', [0xfb, 0x7c]],
  ['BE', [0x65, 0x00]],
  ['BEU', [0x65, 0x01]],
  ['BEC', [0x05, 0x00]],
  ['MCR(', [0x68, 0x3c]],
  [')MCR', [0x68, 0x3d]],
  ['MCRA', [0x68, 0x3a]],
  ['MCRD', [0x68, 0x3b]],
  ['TAK', [0x70, 0x02]],
  ['PUSH', [0x68, 0x2e]],
  ['POP', [0x68, 0x3e]],
  ['ENT', [0x60, 0x08]],
  ['LEAVE', [0x68, 0x4e]],
  ['CAR', [0xfe, 0x08]],
  ['RLDA', [0x68, 0x18]],
  ['RRDA', [0x68, 0x28]],
  ['SSI', [0x68, 0x24]],
  ['SSD', [0x68, 0x25]],
  ['SLW', [0x68, 0x12]],
  ['SRW', [0x68, 0x22]],
  ['SLD', [0x68, 0x13]],
  ['SRD', [0x68, 0x23]],
  ['RLD', [0x68, 0x17]],
  ['RRD', [0x68, 0x27]],
  ['AW', [0x41, 0x00]],
  ['OW', [0x49, 0x00]],
  ['XOW', [0x51, 0x00]],
  ['AD', [0x68, 0x37]],
  ['OD', [0x68, 0x47]],
  ['XOD', [0x68, 0x57]],
  ['LAR1', [0xfe, 0x04]],
  ['LAR2', [0xfe, 0x0c]],
  ['TAR1', [0xfe, 0x05]],
  ['TAR2', [0xfe, 0x0d]],
  ['+AR1', [0xfe, 0x06]],
  ['+AR2', [0xfe, 0x0e]],
];
for (const [id, bytes] of NO_OPERAND) {
  def({ id, op: 'none', bytes, length: 2, enc: none(bytes), dec: () => ({ length: 2 }) });
}

// Confronto (mc7 §2.6.2): `21` interi, `39` doppi, `31` reali; il secondo byte è un insieme di bit.
for (const [t, b0] of [
  ['I', 0x21],
  ['D', 0x39],
  ['R', 0x31],
] as const) {
  for (const [op, b1] of [
    ['==', 0x80],
    ['<>', 0x60],
    ['>', 0x20],
    ['<', 0x40],
    ['>=', 0xa0],
    ['<=', 0xc0],
  ] as const) {
    const bytes = [b0, b1];
    def({ id: op + t, op: 'none', bytes, length: 2, enc: none(bytes), dec: () => ({ length: 2 }) });
  }
}

// ---------------------------------------------------------------------------------------------
// Logica a bit: A AN O ON X XN = S R FP FN (mc7 §2.2.2, §2.2.5, §2.6.1)

interface BitSpec {
  id: string;
  /** 1 = secondo mnemonico della coppia (AN, ON, XN, R, FN). */
  n: 0 | 1;
  longOp: number;
  memOp: number;
  second: 0 | 1;
  /** Scostamento della forma corta (M: 0x80, I/Q: 0xc0); assente se non esiste. */
  short?: number;
  group: 1 | 2;
  /** Codice dell'operazione nelle forme `79` e `fb` e nelle condizioni di stato. */
  ar: number;
}
const BIT_SPECS: BitSpec[] = [
  { id: 'A', n: 0, longOp: 0x00, memOp: 0x51, second: 0, short: 0x00, group: 1, ar: 0 },
  { id: 'AN', n: 1, longOp: 0x00, memOp: 0x51, second: 0, short: 0x20, group: 1, ar: 1 },
  { id: 'O', n: 0, longOp: 0x01, memOp: 0x51, second: 1, short: 0x08, group: 1, ar: 2 },
  { id: 'ON', n: 1, longOp: 0x01, memOp: 0x51, second: 1, short: 0x28, group: 1, ar: 3 },
  { id: 'X', n: 0, longOp: 0x05, memOp: 0x58, second: 0, group: 1, ar: 4 },
  { id: 'XN', n: 1, longOp: 0x05, memOp: 0x58, second: 0, group: 1, ar: 5 },
  { id: '=', n: 0, longOp: 0x41, memOp: 0x59, second: 0, short: 0x18, group: 2, ar: 2 },
  { id: 'S', n: 0, longOp: 0x09, memOp: 0x58, second: 1, short: 0x10, group: 2, ar: 0 },
  { id: 'R', n: 1, longOp: 0x09, memOp: 0x58, second: 1, short: 0x30, group: 2, ar: 1 },
  { id: 'FP', n: 0, longOp: 0x49, memOp: 0x59, second: 1, group: 2, ar: 4 },
  { id: 'FN', n: 1, longOp: 0x49, memOp: 0x59, second: 1, group: 2, ar: 5 },
];

/** Condizioni di stato (mc7 §2.6.1): AWL → `c`. */
const STATUS_CODE: Record<string, number> = {
  '==0': 0x8,
  '<>0': 0x6,
  '>0': 0x2,
  '<0': 0x4,
  '>=0': 0xa,
  '<=0': 0xc,
  OV: 0x1,
  OS: 0x0,
  UO: 0x5,
  BR: 0xe,
};

interface BitAddr {
  area: AreaId;
  z: number;
  bit: number;
  byte: number;
}
function bitAddress(op: Operand | undefined): BitAddr | undefined {
  const a = plainAddress(op);
  if (!a || a.size !== 'X' || a.bit === undefined || !isU16(a.byte) || a.bit > 7) return undefined;
  const z = AREA_CODE[a.area];
  return z === undefined || z === 0 ? undefined : { area: a.area, z, bit: a.bit, byte: a.byte };
}
const shortFits = (a: BitAddr): boolean =>
  (a.area === 'M' && a.byte < 256) || ((a.area === 'I' || a.area === 'Q') && a.byte < 128);

function regOffset(
  op: Extract<Operand, { kind: 'indirect' }>,
): { ar: 1 | 2; off: number } | undefined {
  if (op.via.kind !== 'register') return undefined;
  const off = parseOffset(op.via.offset);
  return off === undefined ? undefined : { ar: op.via.ar, off };
}

for (const s of BIT_SPECS) {
  const n80 = s.n * 0x80;
  if (s.short !== undefined) {
    const off = s.short;
    def({
      id: s.id,
      op: 'address',
      bytes: [0x80 + off],
      mask: [0xf8],
      length: 2,
      enc: (i) => {
        const a = bitAddress(i.operand);
        return a && a.area === 'M' && a.byte < 256 ? [0x80 + off + a.bit, a.byte] : null;
      },
      dec: (c, at) => ({ operand: address('M', 'X', c[at + 1]!, c[at]! & 7), length: 2 }),
    });
    def({
      id: s.id,
      op: 'address',
      bytes: [0xc0 + off],
      mask: [0xf8],
      length: 2,
      enc: (i) => {
        const a = bitAddress(i.operand);
        if (!a || a.byte >= 128) return null;
        if (a.area === 'I') return [0xc0 + off + a.bit, a.byte];
        return a.area === 'Q' ? [0xc0 + off + a.bit, 0x80 + a.byte] : null;
      },
      dec: (c, at) => {
        const nn = c[at + 1]!;
        const bit = c[at]! & 7;
        return {
          operand: nn >= 0x80 ? address('Q', 'X', nn - 0x80, bit) : address('I', 'X', nn, bit),
          length: 2,
        };
      },
    });
  }
  // Forma lunga: `op x aaaa`, x = N·80 + z·10 + bit
  for (let z = 1; z <= 6; z++) {
    def({
      id: s.id,
      op: 'address',
      bytes: [s.longOp, n80 + z * 0x10],
      mask: [0xff, 0xf8],
      length: 4,
      enc: (i) => {
        const a = bitAddress(i.operand);
        if (!a || a.z !== z) return null;
        if (s.short !== undefined && shortFits(a)) return null;
        return [s.longOp, n80 + z * 0x10 + a.bit, ...w16(a.byte)];
      },
      dec: (c, at) => ({
        operand: address(AREA_OF_CODE[z]!, 'X', rd16(c, at + 2), c[at + 1]! & 7),
        length: 4,
      }),
    });
  }
  // Da memoria: `op x aaaa`, x = N·80 + p·10 + (secondo mnemonico)·8 + z
  for (let p = 3; p <= 6; p++) {
    def({
      id: s.id,
      op: 'indirect',
      bytes: [s.memOp, n80 + p * 0x10 + s.second * 8],
      mask: [0xff, 0xf8],
      length: 4,
      enc: (i) => {
        const o = i.operand;
        if (o?.kind !== 'indirect' || o.via.kind !== 'memory' || o.size !== 'X' || !o.area)
          return null;
        const z = AREA_CODE[o.area];
        const loc = locationOf(o.via.location, 'D');
        if (z === undefined || z === 0 || !loc || loc.p !== p) return null;
        return [s.memOp, n80 + p * 0x10 + s.second * 8 + z, ...w16(loc.byte)];
      },
      dec: (c, at) => {
        const z = c[at + 1]! & 7;
        if (z < 1 || z > 6) return null;
        return {
          operand: indirectMem(AREA_OF_CODE[z]!, 'X', locationOperand(p, 'D', rd16(c, at + 2))),
          length: 4,
        };
      },
    });
  }
  // Da registro, interno all'area: `79 x oooo`, x = G·80 + z·10 + AR2·8 + op
  for (let z = 1; z <= 6; z++) {
    const b1 = (s.group === 2 ? 0x80 : 0) + z * 0x10 + s.ar;
    def({
      id: s.id,
      op: 'indirect',
      bytes: [0x79, b1],
      mask: [0xff, 0xf7],
      length: 4,
      enc: (i) => {
        const o = i.operand;
        if (o?.kind !== 'indirect' || o.size !== 'X' || o.area !== AREA_OF_CODE[z]) return null;
        const r = regOffset(o);
        return r ? [0x79, b1 + (r.ar === 2 ? 8 : 0), ...w16(r.off)] : null;
      },
      dec: (c, at) => ({
        operand: indirectReg(
          AREA_OF_CODE[z]!,
          'X',
          c[at + 1]! & 8 ? 2 : 1,
          offsetText(rd16(c, at + 2)),
        ),
        length: 4,
      }),
    });
  }
  // Da registro, tra aree: `fb x oooo`, x = 10/20 + AR2·8 + op
  {
    const b1 = (s.group === 2 ? 0x20 : 0x10) + s.ar;
    def({
      id: s.id,
      op: 'indirect',
      bytes: [0xfb, b1],
      mask: [0xff, 0xf7],
      length: 4,
      enc: (i) => {
        const o = i.operand;
        if (o?.kind !== 'indirect' || o.size !== 'X' || o.area !== null) return null;
        const r = regOffset(o);
        return r ? [0xfb, b1 + (r.ar === 2 ? 8 : 0), ...w16(r.off)] : null;
      },
      dec: (c, at) => ({
        operand: indirectReg(null, 'X', c[at + 1]! & 8 ? 2 : 1, offsetText(rd16(c, at + 2))),
        length: 4,
      }),
    });
  }
  // Parametro formale BOOL di FC: `fb 8x/9x wwww`
  {
    const code = s.group === 1 ? 0x80 + s.ar : s.id === '=' ? 0x92 : 0x90 + s.ar;
    def({
      id: s.id,
      op: 'special',
      bytes: [0xfb, code],
      length: 4,
      enc: (i, cx) => {
        const f = formalOf(i, cx, 'Bool');
        return f ? [0xfb, code, ...w16(f.offset)] : null;
      },
      dec: (c, at) => formalPart(rd16(c, at + 2), 'Bool', 4),
    });
  }
  // Condizioni di stato: `ff x`, x = c·10 + op
  if (s.group === 1) {
    for (const [cond, c4] of Object.entries(STATUS_CODE)) {
      const bytes = [0xff, c4 * 0x10 + s.ar];
      def({
        id: s.id,
        op: 'special',
        bytes,
        length: 2,
        enc: (i) => (i.operand?.kind === 'status' && i.operand.condition === cond ? bytes : null),
        dec: () => ({ operand: statusOp(cond), length: 2 }),
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Temporizzatori e contatori (mc7 §2.6.1, §2.6.4, §2.6.12)

interface TcSpec {
  id: string;
  /** Forma corta e codice dell'operazione (nibble) per T e per C. */
  T?: { short?: number; nib: number };
  C?: { short?: number; nib: number };
}
const TC_SPECS: TcSpec[] = [
  { id: 'A', T: { short: 0xf8, nib: 0 }, C: { short: 0xb8, nib: 0 } },
  { id: 'AN', T: { short: 0xfc, nib: 1 }, C: { short: 0xbc, nib: 1 } },
  { id: 'O', T: { short: 0xf9, nib: 2 }, C: { short: 0xb9, nib: 2 } },
  { id: 'ON', T: { short: 0xfd, nib: 3 }, C: { short: 0xbd, nib: 3 } },
  { id: 'X', T: { nib: 4 }, C: { nib: 4 } },
  { id: 'XN', T: { nib: 5 }, C: { nib: 5 } },
  { id: 'L', T: { short: 0x02, nib: 6 }, C: { short: 0x42, nib: 6 } },
  { id: 'FR', T: { short: 0x04, nib: 8 }, C: { short: 0x44, nib: 8 } },
  { id: 'LC', T: { short: 0x0c, nib: 9 }, C: { short: 0x4c, nib: 9 } },
  { id: 'SF', T: { short: 0x14, nib: 0xa } },
  { id: 'SE', T: { short: 0x1c, nib: 0xb } },
  { id: 'SD', T: { short: 0x24, nib: 0xc } },
  { id: 'SS', T: { short: 0x2c, nib: 0xd } },
  { id: 'SP', T: { short: 0x34, nib: 0xe } },
  { id: 'R', T: { short: 0x3c, nib: 0xf }, C: { short: 0x7c, nib: 0xf } },
  { id: 'S', C: { short: 0x5c, nib: 0xb } },
  { id: 'CD', C: { short: 0x54, nib: 0xa } },
  { id: 'CU', C: { short: 0x6c, nib: 0xd } },
];
for (const s of TC_SPECS) {
  for (const area of ['T', 'C'] as const) {
    const f = s[area];
    if (!f) continue;
    const cOff = area === 'C' ? 0x80 : 0;
    const isTc = (o: Operand | undefined): o is Extract<Operand, { kind: 'timerCounter' }> =>
      o?.kind === 'timerCounter' && o.area === area && isU16(o.number);
    if (f.short !== undefined) {
      const code = f.short;
      def({
        id: s.id,
        op: 'timerCounter',
        bytes: [code],
        length: 2,
        enc: (i) => (isTc(i.operand) && i.operand.number < 256 ? [code, i.operand.number] : null),
        dec: (c, at) => ({ operand: timerCounter(area, c[at + 1]!), length: 2 }),
      });
    }
    const long = (area === 'T' ? 0xe0 : 0xf0) + f.nib;
    def({
      id: s.id,
      op: 'timerCounter',
      bytes: [0xfb, long],
      length: 4,
      enc: (i) =>
        isTc(i.operand) && (f.short === undefined || i.operand.number >= 256)
          ? [0xfb, long, ...w16(i.operand.number)]
          : null,
      dec: (c, at) => ({ operand: timerCounter(area, rd16(c, at + 2)), length: 4 }),
    });
    for (let p = 3; p <= 6; p++) {
      const b1 = cOff + p * 0x10 + f.nib;
      def({
        id: s.id,
        op: 'indirect',
        bytes: [0xbf, b1],
        length: 4,
        enc: (i) => {
          const o = i.operand;
          if (o?.kind !== 'indirect' || o.area !== area || o.via.kind !== 'memory') return null;
          const loc = locationOf(o.via.location, 'W');
          return loc && loc.p === p ? [0xbf, b1, ...w16(loc.byte)] : null;
        },
        dec: (c, at) => ({
          operand: indirectMem(area, null, locationOperand(p, 'W', rd16(c, at + 2))),
          length: 4,
        }),
      });
    }
    const par = (area === 'T' ? 0xa0 : 0xb0) + f.nib;
    const parType: FormalType = area === 'T' ? 'Timer' : 'Counter';
    def({
      id: s.id,
      op: 'special',
      bytes: [0xfb, par],
      length: 4,
      enc: (i, cx) => {
        const fp = formalOf(i, cx, parType);
        return fp ? [0xfb, par, ...w16(fp.offset)] : null;
      },
      dec: (c, at) => formalPart(rd16(c, at + 2), parType, 4),
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Caricamento e trasferimento: L e T (mc7 §2.6.8, §2.6.9)

const SIZE_LETTER = [undefined, 'B', 'W', 'D'] as const;
const SHORT_LT: Record<'L' | 'T', { M: number[]; IQ: number[] }> = {
  L: { M: [0x0a, 0x12, 0x1a], IQ: [0x4a, 0x52, 0x5a] },
  T: { M: [0x0b, 0x13, 0x1b], IQ: [0x4b, 0x53, 0x5b] },
};

function sized(op: Operand | undefined): Extract<Operand, { kind: 'address' }> | undefined {
  const a = plainAddress(op);
  return a &&
    (a.size === 'B' || a.size === 'W' || a.size === 'D') &&
    a.bit === undefined &&
    isU16(a.byte)
    ? a
    : undefined;
}
const sizeCode = (s: string): number => ('BWD'.indexOf(s) + 1) as number;

for (const id of ['L', 'T'] as const) {
  const t = id === 'T' ? 4 : 0;
  // Area di z = 0: PI in lettura, PQ in scrittura
  const z0: AreaId = id === 'L' ? 'PI' : 'PQ';
  const areaOf = (z: number): AreaId => (z === 0 ? z0 : AREA_OF_CODE[z]!);
  const codeOf = (area: AreaId): number | undefined =>
    area === 'PI' || area === 'PQ' ? (area === z0 ? 0 : undefined) : AREA_CODE[area];
  for (let s = 1; s <= 3; s++) {
    const letter = SIZE_LETTER[s]!;
    const mCode = SHORT_LT[id].M[s - 1]!;
    const iqCode = SHORT_LT[id].IQ[s - 1]!;
    def({
      id,
      op: 'address',
      bytes: [mCode],
      length: 2,
      enc: (i) => {
        const a = sized(i.operand);
        return a && a.area === 'M' && a.size === letter && a.byte < 256 ? [mCode, a.byte] : null;
      },
      dec: (c, at) => ({ operand: address('M', letter, c[at + 1]!), length: 2 }),
    });
    def({
      id,
      op: 'address',
      bytes: [iqCode],
      length: 2,
      enc: (i) => {
        const a = sized(i.operand);
        if (!a || a.size !== letter || a.byte >= 128) return null;
        if (a.area === 'I') return [iqCode, a.byte];
        return a.area === 'Q' ? [iqCode, 0x80 + a.byte] : null;
      },
      dec: (c, at) => {
        const nn = c[at + 1]!;
        return {
          operand: nn >= 0x80 ? address('Q', letter, nn - 0x80) : address('I', letter, nn),
          length: 2,
        };
      },
    });
    // Forma lunga: `7e (z·10 + s) aaaa`
    for (let z = 0; z <= 6; z++) {
      def({
        id,
        op: 'address',
        bytes: [0x7e, z * 0x10 + t + s],
        length: 4,
        enc: (i) => {
          const a = sized(i.operand);
          if (!a || a.size !== letter || codeOf(a.area) !== z) return null;
          if (
            (a.area === 'M' && a.byte < 256) ||
            ((a.area === 'I' || a.area === 'Q') && a.byte < 128)
          ) {
            return null;
          }
          return [0x7e, z * 0x10 + t + s, ...w16(a.byte)];
        },
        dec: (c, at) => ({ operand: address(areaOf(z), letter, rd16(c, at + 2)), length: 4 }),
      });
    }
    // Registro d'indirizzo, tra aree: `fb (AR2·8 + t + s) oooo`
    def({
      id,
      op: 'indirect',
      bytes: [0xfb, t + s],
      mask: [0xff, 0xf7],
      length: 4,
      enc: (i) => {
        const o = i.operand;
        if (o?.kind !== 'indirect' || o.area !== null || o.size !== letter) return null;
        const r = regOffset(o);
        return r ? [0xfb, (r.ar === 2 ? 8 : 0) + t + s, ...w16(r.off)] : null;
      },
      dec: (c, at) => ({
        operand: indirectReg(null, letter, c[at + 1]! & 8 ? 2 : 1, offsetText(rd16(c, at + 2))),
        length: 4,
      }),
    });
    // Da memoria: `ba` byte, `bb` parola e doppia (bit 8 in x)
    for (let p = 3; p <= 6; p++) {
      const dbl = s === 3 ? 8 : 0;
      const b1 = (id === 'T' ? 0x80 : 0) + p * 0x10 + dbl;
      const b0 = s === 1 ? 0xba : 0xbb;
      def({
        id,
        op: 'indirect',
        bytes: [b0, b1],
        mask: [0xff, 0xf8],
        length: 4,
        enc: (i) => {
          const o = i.operand;
          if (o?.kind !== 'indirect' || !o.area || o.size !== letter || o.via.kind !== 'memory')
            return null;
          const z = codeOf(o.area);
          const loc = locationOf(o.via.location, 'D');
          if (z === undefined || !loc || loc.p !== p) return null;
          return [b0, b1 + z, ...w16(loc.byte)];
        },
        dec: (c, at) => {
          const z = c[at + 1]! & 7;
          if (z > 6) return null;
          return {
            operand: indirectMem(areaOf(z), letter, locationOperand(p, 'D', rd16(c, at + 2))),
            length: 4,
          };
        },
      });
    }
    // Parametro formale: `fb c1/c2/c3` (L) e `fb c5/c6/c7` (T)
    const type: FormalType = s === 1 ? 'Byte' : s === 2 ? 'Word' : 'DWord';
    def({
      id,
      op: 'special',
      bytes: [0xfb, 0xc0 + t + s],
      length: 4,
      enc: (i, cx) => {
        const f = formalOf(i, cx, type);
        return f ? [0xfb, 0xc0 + t + s, ...w16(f.offset)] : null;
      },
      dec: (c, at) => formalPart(rd16(c, at + 2), type, 4),
    });
  }
  // Registro d'indirizzo, interno all'area: `be (z·10 + AR2·8 + t + s) oooo`
  for (let z = 0; z <= 6; z++) {
    def({
      id,
      op: 'indirect',
      bytes: [0xbe, z * 0x10 + t],
      mask: [0xff, 0xf4],
      length: 4,
      enc: (i) => {
        const o = i.operand;
        if (o?.kind !== 'indirect' || !o.area || codeOf(o.area) !== z) return null;
        if (o.size !== 'B' && o.size !== 'W' && o.size !== 'D') return null;
        const r = regOffset(o);
        return r
          ? [0xbe, z * 0x10 + (r.ar === 2 ? 8 : 0) + t + sizeCode(o.size), ...w16(r.off)]
          : null;
      },
      dec: (c, at) => {
        const letter = SIZE_LETTER[c[at + 1]! & 3];
        if (!letter) return null;
        return {
          operand: indirectReg(
            areaOf(z),
            letter,
            c[at + 1]! & 8 ? 2 : 1,
            offsetText(rd16(c, at + 2)),
          ),
          length: 4,
        };
      },
    });
  }
}

// Costanti: `28 nn`, `30 tt vvvv`, `38 tt dddddddd` (mc7 §2.3)
for (const [op, length] of [
  [0x28, 2],
  [0x30, 4],
  [0x38, 6],
] as const) {
  def({
    id: 'L',
    op: 'constant',
    bytes: [op],
    length,
    enc: (i) => {
      const o = i.operand;
      if (o?.kind !== 'constant' || o.pointerTo) return null;
      const c = parseConstant(o.text);
      if (!c || c.op !== op) return null;
      return encodeLoadConstant(o.text, i.constantType) ?? null;
    },
    dec: (c, at) => {
      const data = Array.from(c.subarray(at + (op === 0x28 ? 1 : 2), at + length));
      const d = decodeLoadConstant({ op, type: op === 0x28 ? 0 : c[at + 1]!, data });
      return {
        operand: constant(d.text),
        ...(d.constantType !== undefined ? { constantType: d.constantType } : {}),
        length,
      };
    },
  });
}

// STW, DBLG, DILG, DBNO, DINO
for (const [id, name, bytes] of [
  ['L', 'STW', [0x70, 0x06]],
  ['T', 'STW', [0x70, 0x07]],
  ['L', 'DBLG', [0xfb, 0x3c]],
  ['L', 'DILG', [0xfb, 0x3d]],
  ['L', 'DBNO', [0xfb, 0x4c]],
  ['L', 'DINO', [0xfb, 0x4d]],
] as const) {
  def({
    id,
    op: 'special',
    bytes: [...bytes],
    length: 2,
    enc: (i) => (i.operand?.kind === 'special' && i.operand.name === name ? [...bytes] : null),
    dec: () => ({ operand: specialOp(name), length: 2 }),
  });
}

// ---------------------------------------------------------------------------------------------
// Blocchi dati e chiamate (mc7 §2.5, §2.6.4)

const blockNumber = (
  o: Operand | undefined,
  kinds: string[],
): { kind: string; number: number } | undefined =>
  o?.kind === 'block' && kinds.includes(o.blockKind) && isU16(o.number)
    ? { kind: o.blockKind, number: o.number }
    : undefined;

// OPN
def({
  id: 'OPN',
  op: 'block',
  bytes: [0x20],
  length: 2,
  enc: (i) => {
    const b = blockNumber(i.operand, ['DB']);
    return b && b.number < 256 ? [0x20, b.number] : null;
  },
  dec: (c, at) => ({ operand: blockRef('DB', c[at + 1]!), length: 2 }),
});
for (const [kind, code] of [
  ['DB', 0x78],
  ['DI', 0x79],
] as const) {
  def({
    id: 'OPN',
    op: 'block',
    bytes: [0xfb, code],
    length: 4,
    enc: (i) => {
      const b = blockNumber(i.operand, [kind]);
      return b && (kind === 'DI' || b.number >= 256) ? [0xfb, code, ...w16(b.number)] : null;
    },
    dec: (c, at) => ({ operand: blockRef(kind, rd16(c, at + 2)), length: 4 }),
  });
}
for (const area of ['DB', 'DI'] as const) {
  for (let p = 3; p <= 6; p++) {
    const b1 = p * 0x10 + (area === 'DB' ? 8 : 9);
    def({
      id: 'OPN',
      op: 'indirect',
      bytes: [0xfb, b1],
      length: 4,
      enc: (i) => {
        const o = i.operand;
        if (o?.kind !== 'indirect' || o.area !== area || o.size !== null || o.via.kind !== 'memory')
          return null;
        const loc = locationOf(o.via.location, 'W');
        return loc && loc.p === p ? [0xfb, b1, ...w16(loc.byte)] : null;
      },
      dec: (c, at) => ({
        operand: indirectMem(area, null, locationOperand(p, 'W', rd16(c, at + 2))),
        length: 4,
      }),
    });
  }
}
def({
  id: 'OPN',
  op: 'special',
  bytes: [0xfb, 0xd8],
  length: 4,
  enc: (i, cx) => {
    const f = formalOf(i, cx, 'Block_DB');
    return f ? [0xfb, 0xd8, ...w16(f.offset)] : null;
  },
  dec: (c, at) => formalPart(rd16(c, at + 2), 'Block_DB', 4),
});

/** `70 0b jjjj` dopo l'opcode di UC/CC: i puntatori che seguono (mc7 §2.5). */
function junction(c: Uint8Array, p: number): number | undefined {
  if (c[p] !== 0x70 || c[p + 1] !== 0x0b || p + 4 > c.length) return undefined;
  const j = rd16(c, p + 2);
  return j >= 2 && j % 2 === 0 ? (j - 2) / 2 : undefined;
}
function pointersOf(i: Insn): number[] | null {
  const out: number[] = [];
  for (const p of i.pointers ?? []) {
    if (p.length !== 4) throw new Mc7Error('COMPILE', 'un puntatore della lista ha 4 byte');
    for (let k = 0; k < 4; k++) out.push(p[k]! & 255);
  }
  return out.length / 4 <= 0x7fff ? out : null;
}
const juBytes = (i: Insn): number[] | null => {
  const ptrs = pointersOf(i);
  return ptrs ? [0x70, 0x0b, ...w16(2 + ptrs.length / 2), ...ptrs] : null;
};
/** Decodifica la coda `70 0b jjjj` + puntatori che comincia a `p`. */
function tail(c: Uint8Array, p: number): { pointers: Uint8Array[]; end: number } | null {
  const k = junction(c, p);
  if (k === undefined || p + 4 + 4 * k > c.length) return null;
  return {
    pointers: Array.from({ length: k }, (_, n) => c.slice(p + 4 + 4 * n, p + 8 + 4 * n)),
    end: p + 4 + 4 * k,
  };
}

for (const id of ['UC', 'CC'] as const) {
  const uc = id === 'UC';
  // FC: forma corta (n < 256) e lunga; SFC: sempre lunga. Tutte con JU e puntatori.
  def({
    id,
    op: 'block',
    bytes: [uc ? 0x3d : 0x1d, 0, 0x70, 0x0b],
    mask: [0xff, 0, 0xff, 0xff],
    length: 6,
    variable: true,
    enc: (i) => {
      const b = blockNumber(i.operand, ['FC']);
      const ju = juBytes(i);
      return b && b.number < 256 && ju ? [uc ? 0x3d : 0x1d, b.number, ...ju] : null;
    },
    dec: (c, at) => {
      const t = tail(c, at + 2);
      return t
        ? { operand: blockRef('FC', c[at + 1]!), pointers: t.pointers, length: t.end - at }
        : null;
    },
  });
  for (const [kind, code, minNumber] of [
    ['FC', uc ? 0x70 : 0x71, 256],
    ['SFC', uc ? 0x74 : 0x75, 0],
  ] as const) {
    def({
      id,
      op: 'block',
      bytes: [0xfb, code, 0, 0, 0x70, 0x0b],
      mask: [0xff, 0xff, 0, 0, 0xff, 0xff],
      length: 8,
      variable: true,
      enc: (i) => {
        const b = blockNumber(i.operand, [kind]);
        const ju = juBytes(i);
        return b && b.number >= minNumber && ju ? [0xfb, code, ...w16(b.number), ...ju] : null;
      },
      dec: (c, at) => {
        const t = tail(c, at + 4);
        return t
          ? { operand: blockRef(kind, rd16(c, at + 2)), pointers: t.pointers, length: t.end - at }
          : null;
      },
    });
  }
  // FB / SFB
  def({
    id,
    op: 'block',
    bytes: [uc ? 0x75 : 0x55],
    length: 2,
    enc: (i) => {
      const b = blockNumber(i.operand, ['FB']);
      return b && b.number < 256 ? [uc ? 0x75 : 0x55, b.number] : null;
    },
    dec: (c, at) => ({ operand: blockRef('FB', c[at + 1]!), length: 2 }),
  });
  for (const [kind, code, minNumber] of [
    ['FB', uc ? 0x72 : 0x73, 256],
    ['SFB', uc ? 0x76 : 0x77, 0],
  ] as const) {
    def({
      id,
      op: 'block',
      bytes: [0xfb, code],
      length: 4,
      enc: (i) => {
        const b = blockNumber(i.operand, [kind]);
        return b && b.number >= minNumber ? [0xfb, code, ...w16(b.number)] : null;
      },
      dec: (c, at) => ({ operand: blockRef(kind, rd16(c, at + 2)), length: 4 }),
    });
  }
  // Numero in memoria: `fb (p·10 + 0/1) aaaa` + JU (FC); `fb (p·10 + 2/3) aaaa` (FB). Testo esteso.
  for (let p = 3; p <= 6; p++) {
    for (const block of ['FC', 'FB'] as const) {
      const b1 = p * 0x10 + (block === 'FC' ? 0 : 2) + (uc ? 0 : 1);
      def({
        id,
        op: 'indirect',
        bytes: block === 'FC' ? [0xfb, b1, 0, 0, 0x70, 0x0b] : [0xfb, b1],
        ...(block === 'FC' ? { mask: [0xff, 0xff, 0, 0, 0xff, 0xff] } : {}),
        length: block === 'FC' ? 8 : 4,
        ...(block === 'FC' ? { variable: true } : {}),
        extended: true,
        enc: (i) => {
          if (i.indirectBlock?.block !== block) return null;
          const loc = locationOf(i.indirectBlock.location, 'W');
          if (!loc || loc.p !== p) return null;
          const head = [0xfb, b1, ...w16(loc.byte)];
          if (block === 'FB') return head;
          const ju = juBytes(i);
          return ju ? [...head, ...ju] : null;
        },
        dec: (c, at) => {
          const location = locationOperand(p, 'W', rd16(c, at + 2));
          if (block === 'FB') return { indirectBlock: { block, location }, length: 4 };
          const t = tail(c, at + 4);
          return t
            ? { indirectBlock: { block, location }, pointers: t.pointers, length: t.end - at }
            : null;
        },
      });
    }
  }
  // Parametro formale BLOCK_FC / BLOCK_FB: `fb d0/d1 wwww` + JU, `fb d2/d3 wwww`
  for (const [block, code] of [
    ['Block_FC', uc ? 0xd0 : 0xd1],
    ['Block_FB', uc ? 0xd2 : 0xd3],
  ] as const) {
    const withJu = block === 'Block_FC';
    def({
      id,
      op: 'special',
      bytes: withJu ? [0xfb, code, 0, 0, 0x70, 0x0b] : [0xfb, code],
      ...(withJu ? { mask: [0xff, 0xff, 0, 0, 0xff, 0xff] } : {}),
      length: withJu ? 8 : 4,
      ...(withJu ? { variable: true } : {}),
      enc: (i, cx) => {
        const f = formalOf(i, cx, block);
        if (!f) return null;
        const head = [0xfb, code, ...w16(f.offset)];
        if (!withJu) return head;
        const ju = juBytes(i);
        return ju ? [...head, ...ju] : null;
      },
      dec: (c, at) => {
        const offset = rd16(c, at + 2);
        if (!withJu) return formalPart(offset, block, 4);
        const t = tail(c, at + 4);
        return t ? { ...formalPart(offset, block, t.end - at), pointers: t.pointers } : null;
      },
    });
  }
}

// CALL non è un'istruzione MC7: il compilatore la espande in una macro (mc7 §2.5, Task 7).
def({
  id: 'CALL',
  op: 'block',
  bytes: [],
  length: 0,
  enc: () => {
    throw new Mc7Error('UNSUPPORTED', "CALL è una macro del compilatore, non un'istruzione MC7");
  },
  dec: () => null,
});

// ---------------------------------------------------------------------------------------------
// Salti (mc7 §2.4, §2.6.5)

const JUMPS: [string, number, number][] = [
  ['JU', 0x70, 0x0b],
  ['JL', 0x70, 0x09],
  ['LOOP', 0x70, 0x08],
  ['JC', 0xff, 0xf8],
  ['JCN', 0xff, 0xb8],
  ['JCB', 0xff, 0xd8],
  ['JNB', 0xff, 0x98],
  ['JBI', 0xff, 0xe8],
  ['JNBI', 0xff, 0x78],
  ['JO', 0xff, 0x18],
  ['JOS', 0xff, 0x08],
  ['JZ', 0xff, 0x88],
  ['JN', 0xff, 0x68],
  ['JP', 0xff, 0x28],
  ['JM', 0xff, 0x48],
  ['JPZ', 0xff, 0xa8],
  ['JMZ', 0xff, 0xc8],
  ['JUO', 0xff, 0x58],
];
for (const [id, b0, b1] of JUMPS) {
  const list = id === 'JL';
  def({
    id,
    op: 'jump',
    bytes: [b0, b1],
    length: 4,
    jump: list ? 'list' : 'rel',
    enc: (i) => {
      const w = i.jumpWords;
      if (w === undefined || (i.operand && i.operand.kind !== 'labelRef')) return null;
      return [b0, b1, ...w16(w & 0xffff)];
    },
    dec: (c, at) => {
      const raw = rd16(c, at + 2);
      return { jumpWords: list || raw < 0x8000 ? raw : raw - 0x10000, length: 4 };
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Aritmetica, registri d'indirizzo, scorrimenti, varie con operando

def({
  id: '+',
  op: 'constant',
  bytes: [0x58, 0x00],
  length: 4,
  enc: (i) => {
    const c = i.operand?.kind === 'constant' ? parseConstant(i.operand.text) : undefined;
    return c && c.op === 0x30 && c.type === 3 ? [0x58, 0x00, ...c.data] : null;
  },
  dec: (c, at) => {
    const v = rd16(c, at + 2);
    return { operand: constant(String(v >= 0x8000 ? v - 0x10000 : v)), length: 4 };
  },
});
def({
  id: '+',
  op: 'constant',
  bytes: [0x60, 0x05],
  length: 6,
  enc: (i) => {
    const c = i.operand?.kind === 'constant' ? parseConstant(i.operand.text) : undefined;
    return c && c.op === 0x38 && c.type === 3 ? [0x60, 0x05, ...c.data] : null;
  },
  dec: (c, at) => {
    const v = (c[at + 2]! << 24) | (c[at + 3]! << 16) | (c[at + 4]! << 8) | c[at + 5]! | 0;
    return { operand: constant(`L#${v}`), length: 6 };
  },
});

// AW OW XOW (W#16#) e AD OD XOD (DW#16#) con costante
for (const [id, b1, wide] of [
  ['AW', 0x34, false],
  ['OW', 0x44, false],
  ['XOW', 0x54, false],
  ['AD', 0x36, true],
  ['OD', 0x46, true],
  ['XOD', 0x56, true],
] as const) {
  def({
    id,
    op: 'constant',
    bytes: [0x68, b1],
    length: wide ? 6 : 4,
    enc: (i) => {
      const c = i.operand?.kind === 'constant' ? parseConstant(i.operand.text) : undefined;
      return c && c.type === 7 && c.op === (wide ? 0x38 : 0x30) ? [0x68, b1, ...c.data] : null;
    },
    dec: (c, at) => {
      const v = wide
        ? ((c[at + 2]! << 24) | (c[at + 3]! << 16) | (c[at + 4]! << 8) | c[at + 5]!) >>> 0
        : rd16(c, at + 2);
      return {
        operand: constant(`${wide ? 'DW' : 'W'}#16#${v.toString(16).toUpperCase()}`),
        length: wide ? 6 : 4,
      };
    },
  });
}

// INC DEC BLD: un byte
for (const [id, code] of [
  ['INC', 0x11],
  ['DEC', 0x19],
  ['BLD', 0x10],
] as const) {
  def({
    id,
    op: 'constant',
    bytes: [code],
    length: 2,
    enc: (i) => {
      const v = intOperand(i.operand, 255);
      return v === undefined ? null : [code, v];
    },
    dec: (c, at) => ({ operand: constant(String(c[at + 1]!)), length: 2 }),
  });
}
// NOP 0 / NOP 1
for (const [v, bytes] of [
  [0, [0x00, 0x00]],
  [1, [0xff, 0xff]],
] as const) {
  def({
    id: 'NOP',
    op: 'constant',
    bytes: [...bytes],
    length: 2,
    enc: (i) => (intOperand(i.operand, 1) === v ? [...bytes] : null),
    dec: () => ({ operand: constant(String(v)), length: 2 }),
  });
}

// Scorrimenti e rotazioni con conteggio (mc7 §2.6.11)
function shiftForm(
  id: string,
  bytes: number[],
  mask: number[] | undefined,
  max: number,
  count: (c: Uint8Array, at: number) => number,
  code: (n: number) => number[],
): void {
  def({
    id,
    op: 'constant',
    bytes,
    ...(mask ? { mask } : {}),
    length: 2,
    enc: (i) => {
      const n = intOperand(i.operand, max);
      return n === undefined ? null : code(n);
    },
    dec: (c, at) => {
      const n = count(c, at);
      return n > max ? null : { operand: constant(String(n)), length: 2 };
    },
  });
}
shiftForm(
  'SSI',
  [0x68, 0x01],
  [0xff, 0x0f],
  15,
  (c, at) => c[at + 1]! >> 4,
  (n) => [0x68, n * 0x10 + 1],
);
shiftForm(
  'SSD',
  [0x71],
  undefined,
  32,
  (c, at) => c[at + 1]!,
  (n) => [0x71, n],
);
shiftForm(
  'SLW',
  [0x61],
  undefined,
  15,
  (c, at) => c[at + 1]!,
  (n) => [0x61, n],
);
shiftForm(
  'SRW',
  [0x69],
  undefined,
  15,
  (c, at) => c[at + 1]!,
  (n) => [0x69, n],
);
shiftForm(
  'SLD',
  [0x29],
  undefined,
  32,
  (c, at) => c[at + 1]!,
  (n) => [0x29, n],
);
shiftForm(
  'RLD',
  [0x64],
  undefined,
  32,
  (c, at) => c[at + 1]!,
  (n) => [0x64, n],
);
shiftForm(
  'RRD',
  [0x74],
  undefined,
  32,
  (c, at) => c[at + 1]!,
  (n) => [0x74, n],
);
shiftForm(
  'SRD',
  [0xfe, 0xc0],
  [0xff, 0xe0],
  31,
  (c, at) => c[at + 1]! - 0xc0,
  (n) => [0xfe, 0xc0 + n],
);
shiftForm(
  'SRD',
  [0xfe, 0xe0],
  undefined,
  32,
  () => 32,
  () => [0xfe, 0xe0],
);

// Registri d'indirizzo (mc7 §2.6.9, §2.6.14)
for (const [id, p, mem, ar] of [
  ['LAR1', 0x03, 0x03, 0x01],
  ['LAR2', 0x0b, 0x0b, undefined],
  ['TAR1', undefined, 0x07, 0x09],
  ['TAR2', undefined, 0x0f, undefined],
] as const) {
  if (p !== undefined) {
    def({
      id,
      op: 'constant',
      bytes: [0xfe, p],
      length: 6,
      enc: (i) => {
        const ptr = i.operand?.kind === 'constant' ? parsePointer(i.operand.text) : undefined;
        return ptr ? [0xfe, p, ...ptr] : null;
      },
      dec: (c, at) => {
        const t = pointerText(c.subarray(at + 2, at + 6));
        return t ? { operand: constant(t), length: 6 } : null;
      },
    });
  }
  if (ar !== undefined) {
    def({
      id,
      op: 'ar',
      bytes: [0xfe, ar],
      length: 2,
      enc: (i) => (i.operand?.kind === 'special' && i.operand.name === 'AR2' ? [0xfe, ar] : null),
      dec: () => ({ operand: specialOp('AR2'), length: 2 }),
    });
  }
  for (let q = 3; q <= 6; q++) {
    const b1 = q * 0x10 + mem;
    def({
      id,
      op: 'address',
      bytes: [0xfe, b1],
      length: 4,
      enc: (i) => {
        const loc = locationOf(i.operand, 'D');
        return loc && loc.p === q ? [0xfe, b1, ...w16(loc.byte)] : null;
      },
      dec: (c, at) => ({ operand: locationOperand(q, 'D', rd16(c, at + 2)), length: 4 }),
    });
  }
}
for (const [id, b1] of [
  ['+AR1', 0x02],
  ['+AR2', 0x0a],
] as const) {
  def({
    id,
    op: 'constant',
    bytes: [0xfe, b1],
    length: 4,
    enc: (i) => {
      const off = i.operand?.kind === 'constant' ? parseOffset(i.operand.text) : undefined;
      return off === undefined ? null : [0xfe, b1, ...w16(off)];
    },
    dec: (c, at) => ({ operand: constant(offsetText(rd16(c, at + 2))), length: 4 }),
  });
}

// ---------------------------------------------------------------------------------------------
// Tabella, verifica sui blocchi reali, indici

/**
 * Forme viste in un blocco reale (mc7 §2.6, «reale»; 12 blocchi di codice, 2011 istruzioni):
 * per ogni `id` i primi byte di un'istruzione vista, in esadecimale.
 */
const SEEN_IN_REAL_BLOCKS: Record<string, string[]> = {
  ')': ['bf00'],
  '*D': ['600a'],
  '*I': ['6004'],
  '*R': ['6007'],
  '+': ['5800'],
  '+D': ['600d'],
  '+I': ['7900'],
  '+R': ['600f'],
  '-D': ['6009'],
  '-R': ['600b'],
  '/D': ['600e'],
  '/R': ['6003'],
  '<=D': ['39c0'],
  '<=I': ['21c0'],
  '<=R': ['31c0'],
  '<>D': ['3960'],
  '<D': ['3940'],
  '<I': ['2140'],
  '<R': ['3140'],
  '=': [
    '4135',
    '4136',
    '4140',
    '4141',
    '4142',
    '4143',
    '4144',
    '4145',
    '4146',
    '4147',
    '4150',
    '4160',
    '4161',
    '4162',
    '4163',
    '4166',
    '5965',
    '79da',
    '9807',
    '9905',
    '9907',
    '9a05',
    '9a07',
    '9b05',
    '9c05',
    '9d05',
    '9e05',
  ],
  '==D': ['3980'],
  '==I': ['2180'],
  '>=D': ['39a0'],
  '>=I': ['21a0'],
  '>=R': ['31a0'],
  '>D': ['3920'],
  '>I': ['2120'],
  '>R': ['3120'],
  A: [
    '0030',
    '0031',
    '0032',
    '0040',
    '0041',
    '0043',
    '0044',
    '0045',
    '0046',
    '0047',
    '0060',
    '0061',
    '0062',
    '0063',
    '0064',
    '0065',
    '0067',
    '7958',
    '8000',
    '8001',
    '8004',
    '8078',
    '8100',
    '8101',
    '8103',
    '8162',
    '8178',
    '8204',
    '8205',
    '8264',
    '8301',
    '8302',
    '8403',
    '8404',
    '8502',
    '8704',
    'c100',
    'c200',
    'c300',
    'fbe0',
    'ffe0',
  ],
  'A(': ['ba00'],
  AN: [
    '00c0',
    '00c2',
    '00c3',
    '00c4',
    '00c5',
    '00c6',
    '00c7',
    '00e0',
    '00e1',
    '00e2',
    '00e4',
    '00e5',
    '00e6',
    '7959',
    'a302',
    'a403',
    'a5d1',
    'a605',
  ],
  BE: ['6500'],
  BEC: ['0500'],
  BEU: ['6501'],
  BLD: ['1001', '1002', '1003', '1004', '1007', '1008', '1009', '100a', '1067'],
  CC: ['1d06', '1d57'],
  CD: ['5400'],
  CDB: ['fb7c'],
  CLR: ['681c'],
  CU: ['6c00'],
  DTR: ['6806'],
  FN: ['49b1'],
  FP: ['4930'],
  ITB: ['6808'],
  ITD: ['681e'],
  JC: ['fff8'],
  JCN: ['ffb8'],
  JNB: ['ff98'],
  JU: ['700b'],
  L: [
    '0a01',
    '0a09',
    '0a0a',
    '1202',
    '12d0',
    '12d2',
    '12d4',
    '1a04',
    '1a08',
    '1a0c',
    '1a1c',
    '1a20',
    '1a24',
    '1a28',
    '2802',
    '2810',
    '3000',
    '3003',
    '3007',
    '300c',
    '3801',
    '3803',
    '3804',
    '3807',
    '7e33',
    '7e41',
    '7e42',
    '7e43',
    '7e52',
    '7e53',
    '7e62',
    '7e63',
    'be43',
    'be53',
    'be59',
    'be5a',
    'be5b',
    'fb3c',
    'fbc2',
  ],
  LAR1: ['fe03', 'fe04'],
  LAR2: ['fe0b', 'fe0c', 'fe6b'],
  LC: ['4c00'],
  MOD: ['6001'],
  NEGD: ['6807'],
  NEGR: ['6006'],
  NOP: ['0000'],
  NOT: ['682d'],
  O: [
    '0137',
    '0140',
    '0143',
    '0144',
    '0147',
    '0161',
    '0162',
    '0167',
    '795a',
    '8904',
    '8962',
    '8b04',
    '8c01',
    '8c02',
    '8d01',
    '8e01',
    '8e02',
  ],
  ON: ['01c1', '01c3', '01c5', 'a828', 'a865', 'a928', 'ae61'],
  OPN: [
    '2002',
    '201e',
    '2021',
    '2028',
    '202d',
    '204f',
    '205a',
    '205b',
    '2063',
    '2064',
    'fb38',
    'fb68',
    'fb69',
    'fb79',
  ],
  R: [
    '09c0',
    '09c1',
    '09c3',
    '09c4',
    '09c5',
    '09c6',
    '09c7',
    '09e0',
    '09e1',
    '09e2',
    '09e3',
    '09e4',
    '09e5',
    '09e6',
    '09e7',
    'b000',
    'b001',
    'b028',
    'b101',
    'b128',
    'b201',
    'b301',
    'b401',
    'b4d1',
    'b501',
    'b5d1',
    'b601',
    'b605',
    'b701',
    'b704',
    'f080',
  ],
  RND: ['685c'],
  S: [
    '0937',
    '0940',
    '0941',
    '0943',
    '0944',
    '0945',
    '0946',
    '0947',
    '0960',
    '0961',
    '0962',
    '0963',
    '0964',
    '0965',
    '0967',
    '9004',
    '9006',
    '9101',
    '9106',
    '9128',
    '9201',
    '9206',
    '9262',
    '9278',
    '9306',
    '9406',
    '9462',
    '9506',
    '9701',
    '9705',
    'd080',
  ],
  SAVE: ['682c'],
  SD: ['fbec'],
  SET: ['681d'],
  SLD: ['2903'],
  SLW: ['6103'],
  T: [
    '0b06',
    '0b07',
    '0b09',
    '0b0a',
    '0b0b',
    '0b0c',
    '1302',
    '1304',
    '13d0',
    '13d2',
    '13d4',
    '13da',
    '1b00',
    '1b04',
    '1b08',
    '1b10',
    '1b14',
    '1b1c',
    '1b20',
    '1b24',
    '1b28',
    '4b80',
    '5382',
    '7e36',
    '7e37',
    '7e45',
    '7e46',
    '7e47',
    '7e56',
    '7e57',
    '7e66',
    '7e67',
    'be47',
    'be57',
    'be5d',
    'be5e',
    'be5f',
    'fb05',
    'fb06',
    'fb07',
  ],
  TAK: ['7002'],
  TAR2: ['fe6f'],
  UC: [
    '3d06',
    '3d07',
    '3d0d',
    '3d10',
    '3d13',
    '3d14',
    '3d15',
    '3d16',
    '3d17',
    '3d2d',
    '3d32',
    '3d56',
    '3d5b',
    '3d5c',
    '3d5e',
    '3d5f',
    '3d60',
    '3d61',
    '3d63',
    '3d64',
    '7501',
    'fb60',
    'fb70',
    'fb74',
    'fb76',
    'fbd0',
    'fbd2',
  ],
};

function patternMatches(f: Mc7Form, c: ArrayLike<number>, at: number): boolean {
  for (let k = 0; k < f.bytes.length; k++) {
    const v = c[at + k];
    if (v === undefined || (v & (f.mask?.[k] ?? 0xff)) !== f.bytes[k]) return false;
  }
  return true;
}

for (const impl of IMPLS) {
  const seen = SEEN_IN_REAL_BLOCKS[impl.form.id];
  // Il campione sono i primi 2 byte: si confrontano solo i byte del modello che il campione ha.
  impl.form.verified =
    seen?.some((h) => {
      const b = h.match(/../g)!.map((x) => parseInt(x, 16));
      const f = impl.form;
      return (
        f.bytes.length > 0 &&
        b.every((v, k) => k >= f.bytes.length || (v & (f.mask?.[k] ?? 0xff)) === f.bytes[k])
      );
    }) ?? false;
}

export const MC7_FORMS: readonly Mc7Form[] = IMPLS.map((i) => i.form);

const BY_B0: Impl[][] = Array.from({ length: 256 }, () => []);
for (const impl of IMPLS) {
  const f = impl.form;
  if (f.bytes.length === 0) continue;
  for (let b0 = 0; b0 < 256; b0++) {
    if ((b0 & (f.mask?.[0] ?? 0xff)) === f.bytes[0]) BY_B0[b0]!.push(impl);
  }
}

function lookup(code: Uint8Array, at: number): Impl | undefined {
  const list = BY_B0[code[at] ?? -1];
  return list?.find((i) => at + i.form.length <= code.length && patternMatches(i.form, code, at));
}

/** La forma i cui byte iniziali sono quelli di `code` a `at` (se c'è abbastanza codice). */
export function matchForm(code: Uint8Array, at: number): Mc7Form | undefined {
  return lookup(code, at)?.form;
}

// ---------------------------------------------------------------------------------------------
// Codifica

function symbolic(o: Operand | undefined): boolean {
  if (!o) return false;
  switch (o.kind) {
    case 'symbol':
      return true;
    case 'address':
      return !!o.dbSymbol;
    case 'constant':
      return !!o.pointerTo;
    case 'indirect':
      return o.via.kind === 'memory' && symbolic(o.via.location);
    default:
      return false;
  }
}

function encodeInsn(insn: Insn, opts: EncodeOptions): number[] {
  if (insn.id === 'CALL') {
    throw new Mc7Error('UNSUPPORTED', "CALL è una macro del compilatore, non un'istruzione MC7");
  }
  const o = insn.operand;
  const cx: Cx = {
    formal: (op) => {
      if (op?.kind !== 'local' || op.path.length !== 1) return undefined;
      const name = op.path[0]!.name;
      return opts.formal?.(name) ?? (insn.formal?.name === name ? insn.formal : undefined);
    },
  };
  if (symbolic(o) || (o?.kind === 'local' && !cx.formal(o))) {
    throw new Mc7Error('UNSUPPORTED', 'operando simbolico non risolto');
  }
  // Accesso qualificato a un DB: `DB10.DBW4` = OPN DB10 + accesso (STEP 7 ripete l'OPN, mc7 §3.2)
  if (o?.kind === 'address' && o.db !== undefined) {
    const { db, ...rest } = o;
    const open = encodeInsn(
      { id: 'OPN', operand: blockRef(o.area === 'DI' ? 'DI' : 'DB', db) },
      opts,
    );
    return [...open, ...encodeInsn({ ...insn, operand: rest as Operand }, opts)];
  }
  if (o?.kind === 'labelRef' && insn.jumpWords === undefined) {
    throw new Mc7Error('UNSUPPORTED', 'salto: gli spostamenti si risolvono con encodeJump');
  }
  for (const impl of BY_ID.get(insn.id) ?? []) {
    const bytes = impl.enc(insn, cx);
    if (bytes) return bytes;
  }
  const what = o ? ` ${formatOperand(o)}` : insn.indirectBlock ? ' (numero indiretto)' : '';
  throw new Mc7Error('UNSUPPORTED', `nessuna forma MC7 per ${insn.id}${what}`);
}

/**
 * Codifica un'istruzione AWL già analizzata. Gli operandi devono essere **risolti**: indirizzi
 * assoluti, costanti, numeri di blocco. Un operando simbolico (`"Tag"`, `#locale`, `"DB".x`,
 * `P##x`) dà `Mc7Error('UNSUPPORTED', 'operando simbolico non risolto')`: lo risolve il compilatore
 * prima di chiamare qui (fa eccezione `#nome` quando `opts.formal` lo risolve in un parametro
 * formale di FC). Un indirizzo qualificato (`DB10.DBW4`) dà `OPN` seguito dall'accesso.
 *
 * I salti non si codificano qui: lo spostamento lo risolve il Task 5 con `encodeJump` (o con
 * `opts.jumpWords`). `CALL` è una macro e dà `UNSUPPORTED`. `opts.pointers` porta la lista dei
 * parametri di UC/CC FC/SFC e `opts.constantType` il byte di tipo di una costante.
 */
export function encodeInstruction(stmt: Statement, opts: EncodeOptions = {}): Uint8Array {
  const def = stmt.instruction.def;
  if (!def) {
    throw new Mc7Error('UNSUPPORTED', `istruzione sconosciuta: ${stmt.instruction.text}`);
  }
  return Uint8Array.from(
    encodeInsn(
      {
        id: def.id,
        operand: stmt.operand,
        pointers: opts.pointers,
        constantType: opts.constantType,
        jumpWords: opts.jumpWords,
      },
      opts,
    ),
  );
}

/** Codifica un salto: `displacementWords` è `jjjj` (spostamento in parole; JL: numero di voci). */
export function encodeJump(id: string, displacementWords: number): Uint8Array {
  const impl = (BY_ID.get(id) ?? []).find((i) => i.jump);
  if (!impl) throw new Mc7Error('UNSUPPORTED', `${id} non è un salto`);
  const [lo, hi] = impl.jump === 'list' ? [0, 0xffff] : [-0x8000, 0x7fff];
  if (!Number.isInteger(displacementWords) || displacementWords < lo || displacementWords > hi) {
    throw new RangeError(`spostamento del salto ${id} fuori intervallo: ${displacementWords}`);
  }
  return Uint8Array.from([...impl.form.bytes, ...w16(displacementWords & 0xffff)]);
}

/** Ricodifica un'istruzione decodificata, anche quando il suo testo non è AWL del parser. */
export function encodeDecoded(d: DecodedStatement): Uint8Array {
  if (d.jumpWords !== undefined) return encodeJump(d.id, d.jumpWords);
  return Uint8Array.from(
    encodeInsn(
      {
        id: d.id,
        operand: d.operand,
        indirectBlock: d.indirectBlock,
        pointers: d.pointers,
        constantType: d.constantType,
        formal: d.formal,
      },
      {},
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// Decodifica

function textOf(insn: Insn, jumpTo: number | undefined): string {
  if (jumpTo !== undefined) return `${insn.id} L_${jumpTo >= 0 ? jumpTo : `N${-jumpTo}`}`;
  if (insn.indirectBlock) {
    const loc = formatOperand(insn.indirectBlock.location).replace(/^%/, '');
    return `${insn.id} %${insn.indirectBlock.block}[${loc}]`;
  }
  return insn.operand ? `${insn.id} ${formatOperand(insn.operand)}` : insn.id;
}

const LONG_B1_NONZERO = new Set([
  0x00, 0x01, 0x05, 0x09, 0x41, 0x49, 0x51, 0x58, 0x59, 0x79, 0x7e, 0xba, 0xbb, 0xbe, 0xbf,
]);

/**
 * Lunghezza minima dei byte grezzi per un opcode non in tabella (mc7 §2.7): quella che la famiglia
 * dell'opcode implica, così che la parola d'operando non venga mai decodificata come istruzione a
 * sé. Famiglie lunghe: `30` (4), `38` (6), `fb` (4, salvo `fb 00/3c/3d/4c/4d/7c`), `fe` (4 per
 * `02/0a/33…6f`, 6 per `03/0b`), `ff x8` (4), `70 08/09/0b` (4), `68 34/44/54` (4) e
 * `68 36/46/56` (6), `60 05` (6) e le forme lunghe di `00 01 05 09 41 49 51 58 59 79 7e ba bb be bf`
 * con `b1 ≠ 0` (4). Per `3d`/`1d` senza un JU valido sono i 2 byte dell'opcode. Una finestra
 * troncata dà quanto resta.
 */
function rawLength(code: Uint8Array, at: number): number {
  const b0 = code[at]!;
  const b1 = code[at + 1] ?? 0;
  let l = 2;
  if (b0 === 0x30) l = 4;
  else if (b0 === 0x38) l = 6;
  else if (b0 === 0xfb) l = [0x00, 0x3c, 0x3d, 0x4c, 0x4d, 0x7c].includes(b1) ? 2 : 4;
  else if (b0 === 0xfe) {
    if (b1 === 0x03 || b1 === 0x0b) l = 6;
    else if (b1 === 0x02 || b1 === 0x0a || (b1 >= 0x33 && b1 <= 0x6f)) l = 4;
  } else if (b0 === 0xff) l = (b1 & 0x0f) === 8 ? 4 : 2;
  else if (b0 === 0x70) l = b1 === 0x08 || b1 === 0x09 || b1 === 0x0b ? 4 : 2;
  else if (b0 === 0x68)
    l = [0x34, 0x44, 0x54].includes(b1) ? 4 : [0x36, 0x46, 0x56].includes(b1) ? 6 : 2;
  else if (b0 === 0x60) l = b1 === 0x05 ? 6 : 2;
  else if (LONG_B1_NONZERO.has(b0) && b1 !== 0) l = 4;
  return Math.max(1, Math.min(l, code.length - at));
}

/**
 * Decodifica l'istruzione che comincia a `at`. Un opcode che non è in tabella, o una finestra
 * troncata, dà `{ raw }` (la lunghezza minima della famiglia, vedi `rawLength`) e non solleva mai un errore.
 * A fine codice dà `{ raw }` vuoto con `length` 0.
 */
export function decodeInstruction(
  code: Uint8Array,
  at: number,
): { stmt: DecodedStatement; length: number } | { raw: Uint8Array; length: number } {
  if (!(at >= 0 && at < code.length)) return { raw: new Uint8Array(0), length: 0 };
  const impl = lookup(code, at);
  const part = impl?.dec(code, at);
  if (!impl || !part) {
    const length = rawLength(code, at);
    return { raw: code.slice(at, at + length), length };
  }
  const { length, ...rest } = part;
  const insn: Insn = { id: impl.form.id, ...rest };
  let jumpTo: number | undefined;
  if (impl.jump && insn.jumpWords !== undefined) {
    jumpTo = impl.jump === 'list' ? at + 4 + 4 * insn.jumpWords : at + 2 * insn.jumpWords;
    insn.operand = labelRef(textOf({ id: insn.id }, jumpTo).split(' ')[1]!);
  }
  const stmt: Mutable<DecodedStatement> = { id: insn.id, text: textOf(insn, jumpTo) };
  if (jumpTo !== undefined) {
    stmt.jumpTo = jumpTo;
    stmt.jumpWords = insn.jumpWords!;
  }
  if (insn.constantType !== undefined) stmt.constantType = insn.constantType;
  if (insn.pointers) stmt.pointers = insn.pointers as Uint8Array[];
  if (insn.formal) stmt.formal = insn.formal;
  if (insn.indirectBlock) stmt.indirectBlock = insn.indirectBlock;
  if (insn.operand) stmt.operand = insn.operand;
  if (impl.extended) stmt.extended = true;
  // Canonica se STEP 7 scriverebbe gli stessi byte (mc7 §3.3)
  let again: number[] | undefined;
  try {
    again = encodeInsn(insn, {});
  } catch {
    again = undefined;
  }
  const same =
    again !== undefined && again.length === length && again.every((b, k) => b === code[at + k]);
  if (!same) stmt.nonCanonical = true;
  return { stmt, length };
}
