// Lexer SCL del sottoinsieme in prova: parole chiave senza distinzione di maiuscole, commenti
// `//` e `(* *)` (non annidati), simboli "…", locali #nome, indirizzi assoluti I/Q/M, interi in
// base 2/8/16 (`16#FF`) e tipizzati (`INT#5`, `W#16#FF`, `L#5`), durate e date (`T#5s`, `S5T#2s`,
// `D#2024-01-01`, `TOD#12:00:00`), stringhe e caratteri fra apici.
import { parseLiteral, type ElementaryTypeName } from '@baaportal/s7-types';

export type TokKind =
  | 'id'
  | 'kw'
  | 'local'
  | 'symbol'
  | 'addr'
  | 'int'
  | 'real'
  | 'time'
  | 'op'
  | 'string'
  | 'comment'
  | 'eof';
/** `from`: posizione nel testo (da 0); `col` da 1. */
export type Tok = { kind: TokKind; text: string; line: number; col: number; from: number };
export type LexOptions = {
  /** Gli errori finiscono qui e il lexer prosegue; senza, lancia il primo. */
  errors?: SclError[];
  /** Anche i commenti come token `comment` (per l'evidenziazione). */
  comments?: boolean;
};

export class SclError extends Error {
  constructor(
    readonly line: number,
    readonly col: number,
    message: string,
  ) {
    super(message);
  }
}

export const KEYWORDS = new Set([
  'AND', 'OR', 'XOR', 'NOT', 'MOD', 'TRUE', 'FALSE',
  'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF',
  'CASE', 'OF', 'END_CASE',
  'FOR', 'TO', 'BY', 'DO', 'END_FOR',
  'WHILE', 'END_WHILE', 'REPEAT', 'UNTIL', 'END_REPEAT',
  'RETURN', 'EXIT', 'CONTINUE',
]); // prettier-ignore

/** Indirizzo assoluto internazionale: bit `I0.0`/`IX0.0`, oppure `IB`/`IW`/`ID` con il byte. */
const ADDR = /^%?([IQM])(?:X?(\d+)\.([0-7])|([BWD])(\d+))$/i;
/** Intero: decimale o in base 2/8/16, col tipo davanti se c'è; `_` separa le cifre. */
const INT_LIT =
  /^(?:(?:D?INT|D?WORD|BYTE|DW|W|B|L)#-?)?(?:(?:2|8|16)#[0-9A-Za-z_]+|\d[\d_]*)(?![0-9A-Za-z_#]|\.\d)/i;
/** Durata o data tipizzata: `T#5s`, `TIME#1h2m`, `S5T#2s`, `D#2024-01-01`, `TOD#12:00:00.5`. */
const TIME_LIT =
  /^(?:(?:T|TIME|S5T|S5TIME)#-?[0-9A-Za-z_]+|(?:D|DATE)#[0-9-]+|(?:TOD|TIME_OF_DAY)#[0-9:.]+)(?![0-9A-Za-z_#])/i;
const TIME_TYPES: [RegExp, TimeType, ElementaryTypeName][] = [
  [/^S5T(?:IME)?#/i, 'S5TIME', 'S5Time'],
  [/^T(?:IME)?#/i, 'TIME', 'Time'],
  [/^D(?:ATE)?#/i, 'DATE', 'Date'],
  [/^(?:TOD|TIME_OF_DAY)#/i, 'TOD', 'Time_Of_Day'],
];
export type TimeType = 'TIME' | 'S5TIME' | 'DATE' | 'TOD';

/** Tipo e forma AWL (`T#1H2M`, `D#2024-01-01`) di una durata o data; `undefined` se non è valida. */
export function timeLiteral(text: string): { ty: TimeType; awl: string } | undefined {
  const k = TIME_TYPES.find(([re]) => re.test(text));
  if (!k) return undefined;
  const r = parseLiteral({ kind: 'elementary', name: k[2] }, text);
  return r.ok ? { ty: k[1], awl: r.canonical } : undefined;
}

const LIT_TYPE: Record<string, string> = {
  INT: 'INT',
  DINT: 'DINT',
  L: 'DINT',
  WORD: 'WORD',
  W: 'WORD',
  DWORD: 'DWORD',
  DW: 'DWORD',
  BYTE: 'BYTE',
  B: 'BYTE',
};
const OPS = [
  ':=',
  '=>',
  '<=',
  '>=',
  '<>',
  '**',
  '..',
  '.',
  '[',
  ']',
  '+',
  '-',
  '*',
  '/',
  '=',
  '<',
  '>',
  '(',
  ')',
  ';',
  ':',
  ',',
  '&',
];

export function lex(text: string, opts: LexOptions = {}): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const at = (k = 0) => text[i + k] ?? '';
  const err = (message: string): void => {
    const e = new SclError(line, i - lineStart + 1, message);
    if (!opts.errors) throw e;
    opts.errors.push(e);
  };
  const comment = (from: number, l: number, col: number) => {
    if (opts.comments) out.push({ kind: 'comment', text: text.slice(from, i), line: l, col, from });
  };
  const newline = (pos: number) => {
    line++;
    lineStart = pos + 1;
  };
  while (i < text.length) {
    const c = at();
    if (c === '\n') {
      newline(i);
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const col = i - lineStart + 1;
    if (c === '/' && at(1) === '/') {
      const from = i;
      while (i < text.length && at() !== '\n') i++;
      comment(from, line, col);
      continue;
    }
    if (c === '(' && at(1) === '*') {
      const [from, l] = [i, line];
      let end = text.indexOf('*)', i + 2);
      if (end < 0) {
        err('Commento (* senza *)');
        end = text.length - 2;
      }
      for (let j = i; j < end; j++) if (text[j] === '\n') newline(j);
      i = end + 2;
      comment(from, l, col);
      continue;
    }
    const push = (kind: TokKind, t: string) => {
      out.push({ kind, text: t, line, col, from: i });
      i += t.length;
    };
    // Fino alla chiusura sulla stessa riga; se manca, il resto della riga.
    const quoted = (q: string, message: string): string => {
      const nl = text.indexOf('\n', i);
      const stop = nl < 0 ? text.length : nl;
      const end = text.indexOf(q, i + 1);
      if (end >= 0 && end < stop) return text.slice(i, end + 1);
      err(message);
      return text.slice(i, stop);
    };
    if (c === '"') {
      push('symbol', quoted('"', 'Simbolo senza le virgolette di chiusura'));
      continue;
    }
    if (c === "'") {
      push('string', quoted("'", "Stringa senza l'apice di chiusura"));
      continue;
    }
    const tl = TIME_LIT.exec(text.slice(i))?.[0];
    if (tl) {
      if (!timeLiteral(tl)) err(`Costante non valida: ${tl}`);
      push('time', tl);
      continue;
    }
    const lit = INT_LIT.exec(text.slice(i))?.[0];
    if (lit) {
      let kind: TokKind = 'int';
      try {
        intLiteral(lit);
      } catch {
        err(`Costante non valida: ${lit}`);
        // come nome sconosciuto: la traduzione lo scarta senza leggerne il valore
        kind = 'id';
      }
      push(kind, lit);
      continue;
    }
    const word = /^%?[A-Za-z_][A-Za-z0-9_]*(?:\.[0-7](?![0-9]))?/.exec(text.slice(i))?.[0];
    if (c === '#') {
      const name = /^#[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i))?.[0];
      if (!name) {
        err('Dopo # serve il nome di una variabile');
        i++;
        continue;
      }
      push('local', name);
      continue;
    }
    if (word) {
      if (ADDR.test(word)) {
        push('addr', word);
        continue;
      }
      // un `.n` attaccato a qualcosa che non è un indirizzo non fa parte della parola
      const id = word.replace(/\.\d$/, '');
      if (id.startsWith('%')) err(`Indirizzo non valido: ${word}`);
      push(KEYWORDS.has(id.toUpperCase()) ? 'kw' : 'id', id);
      continue;
    }
    const num = /^\d+(?:\.\d+(?:[eE][+-]?\d+)?|[eE][+-]?\d+)?/.exec(text.slice(i))?.[0];
    if (num) {
      if (/[A-Za-z_#]/.test(text[i + num.length] ?? ''))
        err(
          'Costante non supportata in prova: solo interi, REAL decimali e tipizzati come INT#, W#16#',
        );
      push(/[.eE]/.test(num) ? 'real' : 'int', num);
      continue;
    }
    const op = OPS.find((o) => text.startsWith(o, i));
    if (!op) {
      err(`Carattere non valido: ${c}`);
      i++;
      continue;
    }
    push('op', op);
  }
  out.push({ kind: 'eof', text: '', line, col: i - lineStart + 1, from: i });
  return out;
}

/** Larghezza e posizione di un indirizzo assoluto, nella forma AWL (`I 0.0`, `MW 10`). */
export function parseAddress(text: string): { awl: string; size: 'X' | 'B' | 'W' | 'D' } {
  const m = ADDR.exec(text)!;
  const area = m[1]!.toUpperCase();
  if (m[2] !== undefined) return { awl: `${area} ${Number(m[2])}.${m[3]}`, size: 'X' };
  const size = m[4]!.toUpperCase() as 'B' | 'W' | 'D';
  return { awl: `${area}${size} ${Number(m[5])}`, size };
}

/**
 * Valore e tipo (se scritto) di un letterale intero, anche col meno davanti: `-16#10`, `INT#-5`,
 * `W#16#FF` (WORD), `L#5` (DINT). Lancia un errore se le cifre non sono della base.
 */
export function intLiteral(text: string): { value: bigint; type?: string } {
  const m = /^(-?)(?:([A-Za-z]+)#(-?))?(?:(2|8|16)#)?([0-9A-Za-z_]+)$/.exec(text);
  const digits = m?.[5]?.replace(/_/g, '') ?? '';
  const base = Number(m?.[4] ?? 10);
  const ok = { 2: /^[01]+$/, 8: /^[0-7]+$/, 10: /^\d+$/, 16: /^[0-9A-Fa-f]+$/ }[base];
  const type = m?.[2] && LIT_TYPE[m[2].toUpperCase()];
  if (!m || !ok?.test(digits) || (m[2] && !type)) throw new Error(`Costante non valida: ${text}`);
  const prefix = { 2: '0b', 8: '0o', 10: '', 16: '0x' }[base];
  const v = BigInt(prefix + digits);
  const value = (m[1] === '-') !== (m[3] === '-') ? -v : v;
  return type ? { value, type } : { value };
}
