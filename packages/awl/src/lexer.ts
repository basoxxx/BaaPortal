// Lexer AWL: posizioni, token per l'evidenziazione e scansione delle costanti.

export interface Pos {
  /** 0-based */
  line: number;
  /** 0-based */
  col: number;
  /** indice nella stringa originale */
  offset: number;
}
export interface Range {
  from: Pos;
  to: Pos;
}
export type TokenKind =
  | 'word'
  | 'number'
  | 'literal'
  | 'symbol'
  | 'local'
  | 'string'
  | 'comment'
  | 'punct'
  | 'label'
  | 'newline'
  | 'unknown';
export interface Token {
  kind: TokenKind;
  text: string;
  range: Range;
}

/** Tabella delle righe: LF, CRLF e CR isolato contano ciascuno come un solo a capo. */
export class LineIndex {
  readonly starts: number[] = [0];
  readonly ends: number[] = [];
  constructor(readonly src: string) {
    for (let i = 0; i < src.length; i++) {
      const c = src.charCodeAt(i);
      if (c === 10 || c === 13) {
        this.ends.push(i);
        if (c === 13 && src.charCodeAt(i + 1) === 10) i++;
        this.starts.push(i + 1);
      }
    }
    this.ends.push(src.length);
  }

  get lineCount(): number {
    return this.starts.length;
  }

  lineOf(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  pos(offset: number): Pos {
    const line = this.lineOf(offset);
    return { line, col: offset - this.starts[line]!, offset };
  }

  range(from: number, to: number): Range {
    return { from: this.pos(from), to: this.pos(to) };
  }
}

export const isWs = (c: string | undefined): boolean =>
  c === ' ' || c === '\t' || c === '\f' || c === '\v' || c === ' ';
export const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
export const isAlpha = (c: string | undefined): boolean =>
  c !== undefined && ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'));
export const isWordChar = (c: string | undefined): boolean => isAlpha(c) || isDigit(c) || c === '_';

// Espressioni sticky: si impostano lastIndex e si prova a leggere a partire da quell'indice.
const CHAR = /'[^'\r\n]{1,4}'/y;
const POINTER =
  /P#(?:(?:DB|DI)\d+\.)?(?:[A-Za-z]+[ \t]?)?\d+(?:\.\d+)?(?:[ \t]+[A-Za-z]+[ \t]+\d+)?/iy;
const BYTES = /B#\([ \t]*\d+(?:[ \t]*,[ \t]*\d+){1,3}[ \t]*\)/iy;
const PREFIXED = /[A-Za-z0-9]+#[+-]?[0-9A-Za-z_.:#-]+/y;
const NUMBER = /[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?![A-Za-z0-9_.])/y;
const CONST_PREFIX = /[A-Za-z][A-Za-z0-9]*#/y;

function sticky(re: RegExp, src: string, i: number): number {
  re.lastIndex = i;
  const m = re.exec(src);
  return m ? i + m[0].length : -1;
}

/** Fine di una costante che inizia in `i` (mai oltre la riga), oppure -1. */
export function scanConstant(src: string, i: number): number {
  const c = src[i];
  if (c === "'") return sticky(CHAR, src, i);
  if (c === 'P' || c === 'p') {
    const e = sticky(POINTER, src, i);
    if (e >= 0) return e;
  }
  if (c === 'B' || c === 'b') {
    const e = sticky(BYTES, src, i);
    if (e >= 0) return e;
  }
  if (c !== undefined && (isAlpha(c) || isDigit(c))) {
    const e = sticky(PREFIXED, src, i);
    if (e >= 0) return e;
  }
  if (isDigit(c) || c === '+' || c === '-') return sticky(NUMBER, src, i);
  return -1;
}

/** Vero se in `i` inizia una parola seguita da `#` (prefisso di costante tipizzata). */
export function hasConstPrefix(src: string, i: number): boolean {
  return sticky(CONST_PREFIX, src, i) >= 0;
}

const LABEL = /[A-Za-z][A-Za-z0-9]{0,3}[ \t]*:(?!=)/y;
const WORD = /%?[A-Za-z_][A-Za-z0-9_]*/y;
const OPS = /[=<>+\-*/]+/y;

export function matchLabel(src: string, i: number): number {
  return sticky(LABEL, src, i);
}

export function lex(source: string): Token[] {
  const idx = new LineIndex(source);
  const out: Token[] = [];
  const n = source.length;
  let i = 0;
  let lineHasToken = false;
  const push = (kind: TokenKind, from: number, to: number): void => {
    out.push({ kind, text: source.slice(from, to), range: idx.range(from, to) });
    i = to;
    if (kind !== 'comment') lineHasToken = true;
  };
  const eol = (from: number): number => idx.ends[idx.lineOf(from)]!;

  while (i < n) {
    const c = source[i]!;
    if (c === '\r' || c === '\n') {
      const to = c === '\r' && source[i + 1] === '\n' ? i + 2 : i + 1;
      push('newline', i, to);
      lineHasToken = false;
    } else if (isWs(c)) {
      i++;
    } else if (c === '/' && source[i + 1] === '/') {
      push('comment', i, eol(i));
    } else if (c === '"') {
      const close = source.indexOf('"', i + 1);
      const end = eol(i);
      if (close >= 0 && close < end) push('symbol', i, close + 1);
      else push('unknown', i, end);
    } else if (c === '#') {
      if (source[i + 1] === '"') {
        const close = source.indexOf('"', i + 2);
        const end = eol(i);
        if (close >= 0 && close < end) push('local', i, close + 1);
        else push('unknown', i, end);
      } else {
        WORD.lastIndex = i + 1;
        const m = WORD.exec(source);
        if (m && !m[0].startsWith('%')) push('local', i, i + 1 + m[0].length);
        else push('unknown', i, i + 1);
      }
    } else if (c === "'") {
      const e = sticky(CHAR, source, i);
      if (e >= 0) push('literal', i, e);
      else push('unknown', i, i + 1);
    } else if (isDigit(c) || ((c === '+' || c === '-') && isDigit(source[i + 1]) && lineHasToken)) {
      const e = scanConstant(source, i);
      if (e >= 0) {
        const text = source.slice(i, e);
        push(/^[+-]?[\d.]+(?:[eE][+-]?\d+)?$/.test(text) ? 'number' : 'literal', i, e);
      } else {
        let j = i + 1;
        while (isWordChar(source[j]) || source[j] === '.') j++;
        push('unknown', i, j);
      }
    } else if (isAlpha(c) || c === '_' || (c === '%' && isAlpha(source[i + 1]))) {
      const lab = lineHasToken ? -1 : matchLabel(source, i);
      if (lab >= 0) {
        push('label', i, lab);
        continue;
      }
      if (hasConstPrefix(source, i)) {
        const e = scanConstant(source, i);
        if (e >= 0) {
          push('literal', i, e);
          continue;
        }
      }
      WORD.lastIndex = i;
      push('word', i, i + WORD.exec(source)![0].length);
    } else if ((c === ':' && source[i + 1] === '=') || (c === '=' && source[i + 1] === '>')) {
      push('punct', i, i + 2);
    } else if ('=<>+-*/'.includes(c)) {
      OPS.lastIndex = i;
      push('punct', i, i + OPS.exec(source)![0].length);
    } else if ('()[],.:;'.includes(c)) {
      push('punct', i, i + 1);
    } else {
      push('unknown', i, i + 1);
    }
  }
  return out;
}
