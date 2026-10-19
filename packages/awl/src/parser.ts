// Parser AWL: una istruzione per riga (CALL con parametri puo' occupare piu' righe).
import type { CallParam, Operand, ParseError, Statement } from './ast';
import { findInstruction, type InstructionDef, type Mnemonic } from './instructions';
import { LineIndex, isWordChar, isWs, matchLabel } from './lexer';
import {
  badEnd,
  matchStatus,
  parseOperand,
  skipWs,
  type Ctx,
  type MnemonicToken,
} from './operands';

export type * from './ast';

/** Una porzione di righe sorgente: serve a formatNetwork per riscrivere riga per riga. */
export interface Unit {
  kind: 'blank' | 'comment' | 'label' | 'statement' | 'bad';
  startLine: number;
  endLine: number;
  statement?: Statement;
  /** Testo del commento (kind 'comment') o nome dell'etichetta (kind 'label'). */
  text?: string;
  /** La riga o le righe contengono errori: formatNetwork le lascia com'e'. */
  hasError: boolean;
  /** Commenti dentro l'elenco parametri: non rappresentabili nello Statement. */
  innerComments: boolean;
}

export interface ParseResult {
  statements: Statement[];
  errors: ParseError[];
  units: Unit[];
  tokens: MnemonicToken[];
  index: LineIndex;
}

const SPECIAL_NAMES = new Set(['STW', 'DBLG', 'DBNO', 'DILG', 'DINO']);
const LONG_LABEL = /[A-Za-z_][A-Za-z0-9_]*[ \t]*:(?!=)/y;
const LABEL_REF = /[A-Za-z][A-Za-z0-9_]*/y;
const WORD = /[A-Za-z][A-Za-z0-9]*/y;
const PARAM_NAME = /[A-Za-z_][A-Za-z0-9_]*/y;
const MAX_MNEMONIC = 6;

function sticky(re: RegExp, src: string, i: number): RegExpExecArray | null {
  re.lastIndex = i;
  return re.exec(src);
}

export function parseNetwork(
  source: string,
  mnemonic: Mnemonic,
): { statements: Statement[]; errors: ParseError[] } {
  const { statements, errors } = parseDetailed(source, mnemonic);
  return { statements, errors };
}

/** Parte dell'istruzione piu' lunga che il mnemonico scelto riconosce, con confine di parola. */
function matchInstruction(
  src: string,
  i: number,
  mnemonic: Mnemonic,
): { def: InstructionDef; end: number } | null {
  let t = i;
  while (t < src.length && !isWs(src[t]) && src[t] !== '\r' && src[t] !== '\n') {
    if (src[t] === '/' && src[t + 1] === '/') break;
    t++;
  }
  for (let e = Math.min(t, i + MAX_MNEMONIC); e > i; e--) {
    const def = findInstruction(src.slice(i, e), mnemonic);
    if (!def) continue;
    if (isWordChar(src[e - 1]) && isWordChar(src[e])) continue;
    return { def, end: e };
  }
  return null;
}

export function parseDetailed(source: string, mnemonic: Mnemonic): ParseResult {
  const idx = new LineIndex(source);
  const ctx: Ctx = { src: source, mnemonic, idx, errors: [], tokens: [] };
  const statements: Statement[] = [];
  const units: Unit[] = [];
  let pending: { name: string; range: Statement['range'] } | undefined;
  let line = 0;

  while (line < idx.lineCount) {
    const ls = idx.starts[line]!;
    const le = idx.ends[line]!;
    let i = skipWs(source, ls);
    const errBefore = ctx.errors.length;
    const unit = (u: Partial<Unit> & Pick<Unit, 'kind'>, endLine = line): void => {
      units.push({
        startLine: line,
        endLine,
        hasError: ctx.errors.length > errBefore,
        innerComments: false,
        ...u,
      });
    };

    if (i >= le) {
      unit({ kind: 'blank' });
      line++;
      continue;
    }
    if (source.startsWith('//', i)) {
      unit({ kind: 'comment', text: source.slice(i + 2, le).trim() });
      line++;
      continue;
    }

    let label: { name: string; range: Statement['range'] } | undefined;
    const labEnd = matchLabel(source, i);
    let longLabel: RegExpExecArray | null;
    if (labEnd >= 0) {
      const name = sticky(WORD, source, i)![0];
      label = { name, range: idx.range(i, i + name.length) };
      i = skipWs(source, labEnd);
    } else if ((longLabel = sticky(LONG_LABEL, source, i))) {
      const name = longLabel[0].replace(/[ \t]*:$/, '');
      ctx.errors.push({
        code: 'SYNTAX',
        range: idx.range(i, i + name.length),
        params: { reason: 'label' },
      });
      unit({ kind: 'bad' });
      line++;
      continue;
    }

    if (i >= le || source.startsWith('//', i)) {
      // Etichetta da sola: vale per la prossima istruzione.
      pending = label;
      unit({ kind: 'label', text: label?.name });
      line++;
      continue;
    }

    const found = matchInstruction(source, i, mnemonic);
    if (!found) {
      let e = i;
      while (e < le && !isWs(source[e]) && source[e] !== ';' && !source.startsWith('//', e)) e++;
      const text = source.slice(i, Math.max(e, i + 1));
      ctx.errors.push({
        code: 'UNKNOWN_INSTRUCTION',
        range: idx.range(i, Math.max(e, i + 1)),
        params: { text },
      });
      pending = undefined;
      unit({ kind: 'bad' });
      line++;
      continue;
    }

    const { def, end: iEnd } = found;
    if (def.id !== def.german) {
      ctx.tokens.push({ start: i, end: iEnd, international: def.id, german: def.german });
    }
    const stmt: Statement = {
      instruction: { text: source.slice(i, iEnd), def, range: idx.range(i, iEnd) },
      range: idx.range(i, iEnd),
    };
    const lab = label ?? pending;
    pending = undefined;
    if (lab) stmt.label = lab;
    let last = iEnd;
    let innerComments = false;

    // Operando
    let k = skipWs(source, iEnd);
    if (k < le && source[k] !== ';' && !source.startsWith('//', k)) {
      const r = parseStatementOperand(ctx, def, k);
      if (r.operand) stmt.operand = r.operand;
      k = r.end;
      last = r.end;
      if (r.operand === null)
        k = le; // resto della riga ignorato
      else if (def.id === 'CALL') {
        const c = skipWs(source, k);
        if (source[c] === ',') {
          const inst = parseOperand(ctx, skipWs(source, c + 1));
          if (inst.operand) stmt.instanceDb = inst.operand;
          k = inst.end;
          last = inst.end;
          if (inst.operand === null) k = le;
        }
      }
    }

    // Parametri di CALL: '(' sulla stessa riga o sulla prima riga utile successiva
    let endLine = line;
    let closed = false;
    if (def.id === 'CALL' && stmt.operand) {
      let p = skipWs(source, k);
      let pLine = line;
      let skippedComment = false;
      if (p < le && source[p] !== '(' && source[p] !== ';' && !source.startsWith('//', p)) {
        p = -1;
      } else if (p >= le || source.startsWith('//', p)) {
        skippedComment = p < le;
        p = -1;
        for (let l = line + 1; l < idx.lineCount; l++) {
          const q = skipWs(source, idx.starts[l]!);
          if (q >= idx.ends[l]!) continue;
          if (source.startsWith('//', q)) {
            skippedComment = true;
            continue;
          }
          if (source[q] === '(') {
            p = q;
            pLine = l;
          }
          break;
        }
      }
      if (p >= 0 && source[p] === '(') {
        const r = parseParams(ctx, p);
        stmt.params = r.params;
        // i commenti fra CALL e '(' o dentro l'elenco non stanno nello Statement
        innerComments = r.comments > 0 || (pLine > line && skippedComment);
        k = r.end;
        last = r.end;
        closed = r.closed;
        endLine = closed ? idx.lineOf(r.end - 1) : idx.lineCount - 1;
      }
    }

    // Fine istruzione: ';' e commento finali
    const kl = idx.ends[endLine]!;
    if (endLine > line && !closed) {
      k = kl;
    } else {
      k = skipWs(source, k);
      if (source[k] === ';' && k < kl) {
        k++;
        last = k;
        k = skipWs(source, k);
      }
      if (k < kl && !source.startsWith('//', k)) {
        let e = kl;
        while (e > k && isWs(source[e - 1])) e--;
        ctx.errors.push({ code: 'SYNTAX', range: idx.range(k, e) });
        k = kl;
      }
    }
    if (k < kl && source.startsWith('//', k)) stmt.comment = source.slice(k + 2, kl).trim();
    stmt.range = idx.range(stmt.label ? stmt.label.range.from.offset : i, last);

    statements.push(stmt);
    unit({ kind: 'statement', statement: stmt, innerComments }, endLine);
    // una unita' con errori in una riga qualsiasi dell'intervallo e' "con errori"
    const u = units[units.length - 1]!;
    u.hasError = ctx.errors.length > errBefore;
    line = endLine + 1;
  }

  if (pending) {
    ctx.errors.push({ code: 'SYNTAX', range: pending.range, params: { reason: 'label' } });
    for (let n = units.length - 1; n >= 0; n--) {
      const u = units[n]!;
      if (u.kind === 'label' && u.text === pending.name) {
        u.hasError = true;
        break;
      }
    }
  }
  return { statements, errors: ctx.errors, units, tokens: ctx.tokens, index: idx };
}

function parseStatementOperand(
  ctx: Ctx,
  def: InstructionDef,
  k: number,
): { operand: Operand | null; end: number } {
  const { src, idx } = ctx;
  if (def.operands.includes('label')) {
    const m = sticky(LABEL_REF, src, k);
    if (!m) return bad(ctx, k);
    const end = k + m[0].length;
    return {
      operand: { kind: 'labelRef', name: m[0], range: idx.range(k, end) },
      end,
    };
  }
  if (def.id === 'L' || def.id === 'T') {
    const m = sticky(WORD, src, k);
    if (m && SPECIAL_NAMES.has(m[0].toUpperCase()) && !isWordChar(src[k + m[0].length])) {
      const end = k + m[0].length;
      return {
        operand: {
          kind: 'special',
          name: m[0].toUpperCase() as 'STW',
          range: idx.range(k, end),
        },
        end,
      };
    }
  }
  if (def.operands.includes('status')) {
    const st = matchStatus(ctx, k);
    if (st) return st;
  }
  return parseOperand(ctx, k);
}

function bad(ctx: Ctx, k: number): { operand: null; end: number } {
  const end = badEnd(ctx.src, k);
  ctx.errors.push({ code: 'BAD_OPERAND', range: ctx.idx.range(k, end) });
  return { operand: null, end };
}

/** Salta spazi, a capo e commenti; conta i commenti trovati. */
function skipTrivia(src: string, i: number, counter: { n: number }): number {
  for (;;) {
    const c = src[i];
    if (c === undefined) return i;
    if (isWs(c) || c === '\r' || c === '\n') i++;
    else if (c === '/' && src[i + 1] === '/') {
      counter.n++;
      while (i < src.length && src[i] !== '\r' && src[i] !== '\n') i++;
    } else return i;
  }
}

/** Dopo un errore in un parametro: avanza fino alla ',' o ')' dello stesso livello. */
function recover(src: string, i: number): number {
  let depth = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '"' || c === "'") {
      const close = src.indexOf(c, i + 1);
      const nl = src.slice(i).search(/[\r\n]/);
      if (close < 0 || (nl >= 0 && close > i + nl)) return nl >= 0 ? i + nl : src.length;
      i = close + 1;
      continue;
    }
    if (c === '(' || c === '[') depth++;
    else if (c === ']') depth = Math.max(0, depth - 1);
    else if (c === ')') {
      if (depth === 0) return i;
      depth--;
    } else if (c === ',' && depth === 0) return i;
    i++;
  }
  return i;
}

function parseParams(
  ctx: Ctx,
  open: number,
): { params: CallParam[]; end: number; closed: boolean; comments: number } {
  const { src, idx } = ctx;
  const params: CallParam[] = [];
  const counter = { n: 0 };
  let i = open + 1;
  for (;;) {
    i = skipTrivia(src, i, counter);
    if (i >= src.length) {
      ctx.errors.push({ code: 'UNCLOSED_PARAMS', range: idx.range(open, open + 1) });
      return { params, end: src.length, closed: false, comments: counter.n };
    }
    if (src[i] === ')') return { params, end: i + 1, closed: true, comments: counter.n };
    if (src[i] === ',') {
      ctx.errors.push({ code: 'SYNTAX', range: idx.range(i, i + 1) });
      i++;
      continue;
    }

    const nameStart = i;
    let nameEnd: number;
    if (src[i] === '"') {
      const close = src.indexOf('"', i + 1);
      const eol = idx.ends[idx.lineOf(i)]!;
      if (close < 0 || close >= eol) {
        ctx.errors.push({ code: 'UNCLOSED_STRING', range: idx.range(i, eol) });
        i = recover(src, eol);
        if (src[i] === ',') i++;
        continue;
      }
      nameEnd = close + 1;
    } else {
      const m = sticky(PARAM_NAME, src, i);
      nameEnd = m ? i + m[0].length : -1;
    }
    if (nameEnd < 0) {
      ctx.errors.push({ code: 'SYNTAX', range: idx.range(i, badEnd(src, i)) });
      i = recover(src, i);
      if (src[i] === ',') i++;
      continue;
    }
    const name = src.slice(nameStart, nameEnd);
    let j = skipWs(src, nameEnd);
    const arrow = src.startsWith(':=', j) ? ':=' : src.startsWith('=>', j) ? '=>' : null;
    if (!arrow) {
      ctx.errors.push({ code: 'SYNTAX', range: idx.range(j, Math.max(badEnd(src, j), j + 1)) });
      i = recover(src, j);
      if (src[i] === ',') i++;
      continue;
    }
    const afterArrow = j + 2;
    j = skipWs(src, afterArrow);
    let value: Operand | null = null;
    let end = j;
    const c = src[j];
    const empty =
      c === undefined ||
      c === ',' ||
      c === ')' ||
      c === '\r' ||
      c === '\n' ||
      (c === '/' && src[j + 1] === '/');
    if (empty) end = afterArrow;
    else {
      const r = parseOperand(ctx, j);
      value = r.operand;
      end = r.end;
      if (!value) {
        i = recover(src, r.end);
        if (src[i] === ',') i++;
        params.push(param(ctx, name, nameStart, nameEnd, arrow, null, end));
        continue;
      }
    }
    params.push(param(ctx, name, nameStart, nameEnd, arrow, value, end));
    i = skipTrivia(src, end, counter);
    if (src[i] === ',') i++;
    else if (src[i] !== ')' && i < src.length) {
      ctx.errors.push({ code: 'SYNTAX', range: idx.range(i, Math.max(badEnd(src, i), i + 1)) });
      i = recover(src, i);
      if (src[i] === ',') i++;
    }
  }
}

function param(
  ctx: Ctx,
  name: string,
  nameStart: number,
  nameEnd: number,
  arrow: ':=' | '=>',
  value: Operand | null,
  end: number,
): CallParam {
  return {
    name,
    nameRange: ctx.idx.range(nameStart, nameEnd),
    arrow,
    value,
    range: ctx.idx.range(nameStart, end),
  };
}
