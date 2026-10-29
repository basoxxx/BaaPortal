// Lexer SCL del sottoinsieme in prova: parole chiave senza distinzione di maiuscole, commenti
// `//` e `(* *)` (non annidati), simboli "…", locali #nome, indirizzi assoluti I/Q/M, interi in
// base 2/8/16 (`16#FF`) e tipizzati (`INT#5`, `W#16#FF`, `L#5`).

export type TokKind = 'id' | 'kw' | 'local' | 'symbol' | 'addr' | 'int' | 'real' | 'op' | 'eof';
export type Tok = { kind: TokKind; text: string; line: number; col: number };

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

export function lex(text: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const at = (k = 0) => text[i + k] ?? '';
  const err = (message: string): never => {
    throw new SclError(line, i - lineStart + 1, message);
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
    if (c === '/' && at(1) === '/') {
      while (i < text.length && at() !== '\n') i++;
      continue;
    }
    if (c === '(' && at(1) === '*') {
      const end = text.indexOf('*)', i + 2);
      if (end < 0) err('Commento (* senza *)');
      for (let j = i; j < end; j++) if (text[j] === '\n') newline(j);
      i = end + 2;
      continue;
    }
    const col = i - lineStart + 1;
    const push = (kind: TokKind, t: string) => {
      out.push({ kind, text: t, line, col });
      i += t.length;
    };
    if (c === '"') {
      const end = text.indexOf('"', i + 1);
      const nl = text.indexOf('\n', i);
      if (end < 0 || (nl >= 0 && nl < end)) err('Simbolo senza le virgolette di chiusura');
      push('symbol', text.slice(i, end + 1));
      continue;
    }
    const lit = INT_LIT.exec(text.slice(i))?.[0];
    if (lit) {
      try {
        intLiteral(lit);
      } catch {
        err(`Costante non valida: ${lit}`);
      }
      push('int', lit);
      continue;
    }
    const word = /^%?[A-Za-z_][A-Za-z0-9_]*(?:\.[0-7](?![0-9]))?/.exec(text.slice(i))?.[0];
    if (c === '#') {
      const name = /^#[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i))?.[0];
      if (!name) err('Dopo # serve il nome di una variabile');
      push('local', name!);
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
    if (!op) err(`Carattere non valido: ${c}`);
    push('op', op!);
  }
  out.push({ kind: 'eof', text: '', line, col: i - lineStart + 1 });
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
