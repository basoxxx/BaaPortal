// Analisi degli operandi di una riga AWL (indirizzi, simboli, costanti, indiretti).
import type { AddressSize, AreaId, Operand, ParseError, PathSegment } from './ast';
import { AREA_MNEMONICS, STATUS_CONDITIONS, type Mnemonic } from './instructions';
import { hasConstPrefix, isAlpha, isDigit, isWs, scanConstant, type LineIndex } from './lexer';

/** Un token da convertire tra mnemonico internazionale e tedesco (istruzione, area o stato). */
export interface MnemonicToken {
  start: number;
  end: number;
  international: string;
  german: string;
}

export interface Ctx {
  src: string;
  mnemonic: Mnemonic;
  idx: LineIndex;
  errors: ParseError[];
  tokens: MnemonicToken[];
}

interface Fail {
  code: 'BAD_OPERAND' | 'UNCLOSED_STRING';
  start: number;
  end: number;
}
type Parsed = { operand: Operand; end: number } | Fail;

export const skipWs = (src: string, i: number): number => {
  while (isWs(src[i])) i++;
  return i;
};

/** Fine del token "rotto" che inizia in `i`: fino a spazio, ';', '//' o fine riga. */
export function badEnd(src: string, i: number): number {
  let j = i;
  while (j < src.length) {
    const c = src[j]!;
    if (
      isWs(c) ||
      c === ';' ||
      c === ',' ||
      c === ')' ||
      c === '\r' ||
      c === '\n' ||
      (c === '/' && src[j + 1] === '/')
    )
      break;
    j++;
  }
  return Math.max(j, Math.min(i + 1, src.length));
}

const lineEndOf = (ctx: Ctx, i: number): number => ctx.idx.ends[ctx.idx.lineOf(i)]!;

const BOOLS = new Set(['TRUE', 'FALSE']);
const BLOCKS = new Set(['FB', 'FC', 'SFB', 'SFC']);
const SIZES = new Set<string>(['B', 'W', 'D']);

// Scomposizione del prefisso internazionale in area e dimensione.
const DECOMPOSED = new Map<string, { area: AreaId; size: AddressSize | null }>();
for (const e of new Set(AREA_MNEMONICS.values())) {
  const k = e.international;
  const sized = (area: AreaId, rest: string): void => {
    DECOMPOSED.set(k, { area, size: rest === '' ? 'X' : (rest as AddressSize) });
  };
  if (k === 'T' || k === 'C') DECOMPOSED.set(k, { area: k, size: null });
  else if (k === 'DB' || k === 'DI') DECOMPOSED.set(k, { area: k, size: null });
  else if (k.startsWith('DB') || k.startsWith('DI')) sized(k.slice(0, 2) as AreaId, k.slice(2));
  else if (k.startsWith('PI') || k.startsWith('PQ')) sized(k.slice(0, 2) as AreaId, k.slice(2));
  else sized(k[0] as AreaId, k.slice(1));
}

const POINTER_BIT = /^P#(?:(?:DB|DI)\d+\.)?(?:[A-Za-z]+[ \t]?)?\d+\.(\d+)/i;
/** `P#M0.8`: il numero di bit di un puntatore va da 0 a 7. */
const badPointerBit = (text: string): boolean => Number(POINTER_BIT.exec(text)?.[1] ?? 0) > 7;

const LETTERS = /[A-Za-z]+/y;
const DIGITS = /\d+/y;
const BIT = /(\d+)\.(\d+)/y;
const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;
const INDEX = /\[[ \t]*(\d+(?:[ \t]*,[ \t]*\d+)*)[ \t]*\]/y;
const REGISTER = /AR([12])/iy;

function match(re: RegExp, src: string, i: number): RegExpExecArray | null {
  re.lastIndex = i;
  return re.exec(src);
}

const boundary = (src: string, i: number): boolean => {
  const c = src[i];
  return !(isAlpha(c) || isDigit(c) || c === '_' || c === '.');
};

/** Interpreta un operando; in caso di errore registra l'errore e restituisce null. */
export function parseOperand(ctx: Ctx, i: number): { operand: Operand | null; end: number } {
  const r = tryOperand(ctx, i);
  if ('operand' in r) return r;
  ctx.errors.push({ code: r.code, range: ctx.idx.range(r.start, r.end) });
  return { operand: null, end: r.end };
}

function tryOperand(ctx: Ctx, i: number): Parsed {
  const { src } = ctx;
  const c = src[i];
  const fail = (): Fail => ({ code: 'BAD_OPERAND', start: i, end: badEnd(src, i) });
  if (c === '"' || c === '#') return tryPath(ctx, i);
  if (
    c === "'" ||
    isDigit(c) ||
    c === '+' ||
    c === '-' ||
    (c !== undefined && hasConstPrefix(src, i))
  ) {
    const e = scanConstant(src, i);
    if (e >= 0 && badPointerBit(src.slice(i, e))) return fail();
    if (e >= 0) {
      return {
        operand: { kind: 'constant', text: src.slice(i, e), range: ctx.idx.range(i, e) },
        end: e,
      };
    }
    if (c === "'" && src.indexOf("'", i + 1) < 0) {
      return { code: 'UNCLOSED_STRING', start: i, end: lineEndOf(ctx, i) };
    }
    return fail();
  }
  if (c !== '%' && c !== '[' && !isAlpha(c)) return fail();

  let j = c === '%' ? i + 1 : i;
  let prefix = '';
  if (src[j] !== '[') {
    LETTERS.lastIndex = j;
    const m = LETTERS.exec(src);
    if (!m) return fail();
    prefix = m[0].toUpperCase();
    j += m[0].length;
    if (c !== '%' && BOOLS.has(prefix) && boundary(src, j)) {
      return {
        operand: { kind: 'constant', text: m[0], range: ctx.idx.range(i, j) },
        end: j,
      };
    }
  }
  const prefixStart = j - prefix.length;
  const range = (to: number) => ctx.idx.range(i, to);
  const k = skipWs(src, j);

  // Accesso tra aree: `[AR1, P#0.0]`, `B [AR1, P#0.0]`
  if (prefix === '' || (SIZES.has(prefix) && src[k] === '[')) {
    if (src[k] !== '[') return fail();
    return tryIndirect(ctx, i, k, null, prefix === '' ? 'X' : (prefix as AddressSize));
  }

  if (BLOCKS.has(prefix)) {
    const m = match(DIGITS, src, k);
    if (!m || !boundary(src, k + m[0].length)) return fail();
    const end = k + m[0].length;
    return {
      operand: {
        kind: 'block',
        blockKind: prefix as 'FB',
        number: Number(m[0]),
        range: range(end),
      },
      end,
    };
  }

  if (prefix === 'DB' || prefix === 'DI') {
    if (src[k] === '[') return tryIndirect(ctx, i, k, prefix, null);
    const m = match(DIGITS, src, k);
    if (!m) return fail();
    const numEnd = k + m[0].length;
    const db = Number(m[0]);
    if (src[numEnd] !== '.') {
      if (!boundary(src, numEnd)) return fail();
      return {
        operand: { kind: 'block', blockKind: prefix, number: db, range: range(numEnd) },
        end: numEnd,
      };
    }
    // DB qualificato: DB10.DBX 2.0
    LETTERS.lastIndex = numEnd + 1;
    const q = LETTERS.exec(src);
    const word = q?.[0].toUpperCase() ?? '';
    if (
      !q ||
      word.length !== 3 ||
      !word.startsWith(prefix) ||
      (!SIZES.has(word.slice(2)) && word[2] !== 'X')
    ) {
      return fail();
    }
    const size = word[2] as AddressSize;
    const part = numberPart(src, skipWs(src, numEnd + 1 + 3), size);
    if (!part) return fail();
    return {
      operand: { kind: 'address', area: prefix, size, db, ...part.at, range: range(part.end) },
      end: part.end,
    };
  }

  const entry = AREA_MNEMONICS.get(prefix);
  if (!entry || entry[ctx.mnemonic] !== prefix) return fail();
  const dec = DECOMPOSED.get(entry.international)!;
  if (entry.international !== entry.german) {
    ctx.tokens.push({
      start: prefixStart,
      end: prefixStart + prefix.length,
      international: entry.international,
      german: entry.german,
    });
  }
  if (src[k] === '[') return tryIndirect(ctx, i, k, dec.area, dec.size);

  if (dec.area === 'T' || dec.area === 'C') {
    const m = match(DIGITS, src, k);
    if (!m || !boundary(src, k + m[0].length)) return fail();
    const end = k + m[0].length;
    return {
      operand: { kind: 'timerCounter', area: dec.area, number: Number(m[0]), range: range(end) },
      end,
    };
  }
  if (dec.size === null) return fail();
  const part = numberPart(src, k, dec.size);
  if (!part) return fail();
  return {
    operand: {
      kind: 'address',
      area: dec.area,
      size: dec.size,
      ...part.at,
      range: range(part.end),
    },
    end: part.end,
  };
}

function numberPart(
  src: string,
  k: number,
  size: AddressSize,
): { at: { byte: number; bit?: number }; end: number } | null {
  if (size === 'X') {
    const m = match(BIT, src, k);
    if (!m || !boundary(src, k + m[0].length) || Number(m[2]) > 7) return null;
    return { at: { byte: Number(m[1]), bit: Number(m[2]) }, end: k + m[0].length };
  }
  const m = match(DIGITS, src, k);
  if (!m || !boundary(src, k + m[0].length)) return null;
  return { at: { byte: Number(m[0]) }, end: k + m[0].length };
}

function tryIndirect(
  ctx: Ctx,
  start: number,
  open: number,
  area: AreaId | null,
  size: AddressSize | null,
): Parsed {
  const { src } = ctx;
  const fail = (): Fail => ({ code: 'BAD_OPERAND', start, end: badEnd(src, start) });
  const j = skipWs(src, open + 1);
  const reg = match(REGISTER, src, j);
  if (reg && !isAlpha(src[j + 3]) && !isDigit(src[j + 3])) {
    let k = skipWs(src, j + 3);
    if (src[k] !== ',') return fail();
    k = skipWs(src, k + 1);
    const e = scanConstant(src, k);
    if (e < 0 || badPointerBit(src.slice(k, e))) return fail();
    const close = skipWs(src, e);
    if (src[close] !== ']') return fail();
    return {
      operand: {
        kind: 'indirect',
        area,
        size,
        via: { kind: 'register', ar: Number(reg[1]) as 1 | 2, offset: src.slice(k, e) },
        range: ctx.idx.range(start, close + 1),
      },
      end: close + 1,
    };
  }
  const inner = tryOperand(ctx, j);
  if (!('operand' in inner)) return inner.code === 'UNCLOSED_STRING' ? inner : fail();
  const close = skipWs(src, inner.end);
  if (src[close] !== ']') return fail();
  return {
    operand: {
      kind: 'indirect',
      area,
      size,
      via: { kind: 'memory', location: inner.operand },
      range: ctx.idx.range(start, close + 1),
    },
    end: close + 1,
  };
}

function tryPath(ctx: Ctx, i: number): Parsed {
  const { src } = ctx;
  const kind = src[i] === '#' ? 'local' : 'symbol';
  let j = kind === 'local' ? i + 1 : i;
  const path: PathSegment[] = [];
  for (;;) {
    const from = j;
    let name: string;
    let quoted = false;
    if (src[j] === '"') {
      const close = src.indexOf('"', j + 1);
      if (close < 0 || close >= lineEndOf(ctx, j)) {
        return { code: 'UNCLOSED_STRING', start: j, end: lineEndOf(ctx, j) };
      }
      name = src.slice(j + 1, close);
      quoted = true;
      j = close + 1;
      if (name === '') return { code: 'BAD_OPERAND', start: i, end: j };
    } else {
      const m = match(IDENT, src, j);
      if (!m) return { code: 'BAD_OPERAND', start: i, end: badEnd(src, i) };
      name = m[0];
      j += name.length;
    }
    const seg: PathSegment = { name, quoted, range: ctx.idx.range(from, j) };
    if (src[j] === '[') {
      const m = match(INDEX, src, j);
      if (!m) return { code: 'BAD_OPERAND', start: i, end: badEnd(src, i) };
      seg.index = m[1]!.split(',').map((s) => Number(s.trim()));
      j += m[0].length;
    }
    path.push(seg);
    if (kind === 'symbol' && path.length === 1 && quoted && !seg.index) {
      const abs = trySymbolicDb(ctx, i, j, name, seg.range);
      if (abs) return abs;
    }
    const nx = src[j + 1];
    if (src[j] === '.' && (nx === '"' || nx === '_' || isAlpha(nx))) j++;
    else break;
  }
  return { operand: { kind, path, range: ctx.idx.range(i, j) }, end: j };
}

// Condizioni di stato valide per il mnemonico scelto.
const STATUS_BY_MNEMONIC: Record<Mnemonic, Map<string, (typeof STATUS_CONDITIONS)[number]>> = {
  international: new Map(STATUS_CONDITIONS.map((c) => [c.international.toUpperCase(), c])),
  german: new Map(STATUS_CONDITIONS.map((c) => [c.german.toUpperCase(), c])),
};
const STATUS_WORD = /[=<>]+0|[A-Za-z]+/y;

/** Condizione di stato (`==0`, `OV`, `BR`...) che inizia in `i`, se c'e'. */
export function matchStatus(ctx: Ctx, i: number): { operand: Operand; end: number } | null {
  const m = match(STATUS_WORD, ctx.src, i);
  if (!m) return null;
  const entry = STATUS_BY_MNEMONIC[ctx.mnemonic].get(m[0].toUpperCase());
  const end = i + m[0].length;
  if (!entry || !boundary(ctx.src, end)) return null;
  if (entry.international !== entry.german) {
    ctx.tokens.push({ start: i, end, international: entry.international, german: entry.german });
  }
  return {
    operand: { kind: 'status', condition: m[0].toUpperCase(), range: ctx.idx.range(i, end) },
    end,
  };
}

const ABS_MEMBER = /\.%?DB([XBWD])(?![A-Za-z_])/iy;

// `"Dati".DBW 4`: DB simbolico con indirizzo assoluto; altrimenti e' un membro normale.
function trySymbolicDb(
  ctx: Ctx,
  start: number,
  dot: number,
  name: string,
  nameRange: PathSegment['range'],
): Parsed | null {
  const m = match(ABS_MEMBER, ctx.src, dot);
  if (!m) return null;
  const size = m[1]!.toUpperCase() as AddressSize;
  const part = numberPart(ctx.src, skipWs(ctx.src, dot + m[0].length), size);
  if (!part) return null;
  return {
    operand: {
      kind: 'address',
      area: 'DB',
      size,
      ...part.at,
      dbSymbol: { name, quoted: true, range: nameRange },
      range: ctx.idx.range(start, part.end),
    },
    end: part.end,
  };
}
