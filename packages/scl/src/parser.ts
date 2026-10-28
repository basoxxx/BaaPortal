// Parser a discesa ricorsiva del sottoinsieme SCL in prova (istruzioni, senza intestazione del
// blocco: l'interfaccia è quella del blocco). Precedenze dal manuale pubblico SCL, dalla più bassa:
// OR, XOR, AND/&, confronti, + -, * / MOD, NOT e meno unario.
import { lex, SclError, type Tok } from './lexer.js';

export type Pos = { line: number; col: number };
export type Operand = Pos & { k: 'local' | 'id' | 'symbol' | 'addr'; text: string };
export type Expr =
  | Operand
  | (Pos & { k: 'int' | 'real'; text: string })
  | (Pos & { k: 'bool'; value: boolean })
  | (Pos & { k: 'neg' | 'not'; e: Expr })
  | (Pos & { k: 'bin'; op: string; l: Expr; r: Expr })
  | (Pos & { k: 'call'; name: string; arg: Expr });
export type Stmt =
  | (Pos & { k: 'assign'; dst: Operand; e: Expr })
  | (Pos & { k: 'if'; arms: { cond: Expr; body: Stmt[] }[]; else?: Stmt[] })
  | (Pos & {
      k: 'case';
      sel: Expr;
      arms: { values: (Pos & { text: string })[]; body: Stmt[] }[];
      else?: Stmt[];
    })
  | (Pos & {
      k: 'for';
      v: Operand;
      from: Expr;
      to: Expr;
      by?: Pos & { text: string };
      body: Stmt[];
    })
  | (Pos & { k: 'while'; cond: Expr; body: Stmt[] })
  | (Pos & { k: 'repeat'; body: Stmt[]; cond: Expr })
  | (Pos & { k: 'return' });

const LEVELS: string[][] = [['OR'], ['XOR'], ['AND', '&'], ['=', '<>', '<', '>', '<=', '>=']];
const ADD = ['+', '-'];
const MUL = ['*', '/', 'MOD'];

export function parse(text: string): Stmt[] {
  const toks = lex(text);
  let p = 0;
  const peek = () => toks[p]!;
  const up = (t: Tok) => t.text.toUpperCase();
  const is = (...words: string[]) => {
    const t = peek();
    return (t.kind === 'kw' || t.kind === 'op') && words.includes(up(t));
  };
  const fail = (t: Tok, message: string): never => {
    throw new SclError(t.line, t.col, message);
  };
  const shown = (t: Tok) => (t.kind === 'eof' ? 'la fine del testo' : `«${t.text}»`);
  const expect = (word: string): Tok => {
    if (!is(word)) fail(peek(), `Atteso «${word}», trovato ${shown(peek())}`);
    return toks[p++]!;
  };
  const pos = (t: Tok): Pos => ({ line: t.line, col: t.col });

  function statements(...ends: string[]): Stmt[] {
    const out: Stmt[] = [];
    while (!is(...ends) && peek().kind !== 'eof') out.push(statement());
    return out;
  }

  /** Corpo di un costrutto che finisce con `end`: se manca, l'errore cade sulla riga di `open`. */
  function block(open: Tok, end: string, ...stops: string[]): Stmt[] {
    const body = statements(end, ...stops);
    if (peek().kind === 'eof') fail(open, `Manca ${end} per ${up(open)} della riga ${open.line}`);
    return body;
  }

  function statement(): Stmt {
    const t = peek();
    const kw = t.kind === 'kw' ? up(t) : '';
    if (kw === 'IF') return ifStmt();
    if (kw === 'CASE') return caseStmt();
    if (kw === 'FOR') return forStmt();
    if (kw === 'WHILE') {
      p++;
      const cond = expr();
      expect('DO');
      const body = block(t, 'END_WHILE');
      expect('END_WHILE');
      expect(';');
      return { k: 'while', cond, body, ...pos(t) };
    }
    if (kw === 'REPEAT') {
      p++;
      const body = block(t, 'END_REPEAT', 'UNTIL');
      expect('UNTIL');
      const cond = expr();
      expect('END_REPEAT');
      expect(';');
      return { k: 'repeat', body, cond, ...pos(t) };
    }
    if (kw === 'RETURN') {
      p++;
      expect(';');
      return { k: 'return', ...pos(t) };
    }
    if (kw === 'EXIT' || kw === 'CONTINUE') fail(t, `${kw} non è supportato in SCL in prova`);
    const dst = operand();
    if (is('(')) fail(t, `Chiamate di blocchi non supportate in SCL in prova: ${t.text}`);
    expect(':=');
    const e = expr();
    expect(';');
    return { k: 'assign', dst, e, ...pos(t) };
  }

  function ifStmt(): Stmt {
    const open = toks[p++]!;
    const arms: { cond: Expr; body: Stmt[] }[] = [];
    let cond = expr();
    for (;;) {
      expect('THEN');
      arms.push({ cond, body: block(open, 'END_IF', 'ELSIF', 'ELSE') });
      if (!is('ELSIF')) break;
      p++;
      cond = expr();
    }
    let otherwise: Stmt[] | undefined;
    if (is('ELSE')) {
      p++;
      otherwise = block(open, 'END_IF');
    }
    expect('END_IF');
    expect(';');
    return { k: 'if', arms, ...(otherwise ? { else: otherwise } : {}), ...pos(open) };
  }

  function caseValue(): Pos & { text: string } {
    const t = peek();
    const neg = is('-');
    if (neg) p++;
    const n = peek();
    if (n.kind !== 'int') fail(n, 'Nel CASE servono valori interi');
    p++;
    if (is('..')) fail(peek(), 'Gli intervalli nel CASE (a..b) non sono supportati in prova');
    return { text: neg ? `-${n.text}` : n.text, ...pos(t) };
  }

  function caseStmt(): Stmt {
    const open = toks[p++]!;
    const sel = expr();
    expect('OF');
    const arms: { values: (Pos & { text: string })[]; body: Stmt[] }[] = [];
    while (!is('ELSE', 'END_CASE') && peek().kind !== 'eof') {
      const values = [caseValue()];
      while (is(',')) {
        p++;
        values.push(caseValue());
      }
      expect(':');
      // il ramo finisce dove inizia il valore del ramo dopo (`n:` o `n,`)
      const body: Stmt[] = [];
      while (!is('ELSE', 'END_CASE') && peek().kind !== 'eof' && !atCaseValue())
        body.push(statement());
      arms.push({ values, body });
    }
    let otherwise: Stmt[] | undefined;
    if (is('ELSE')) {
      p++;
      if (is(':')) p++;
      otherwise = block(open, 'END_CASE');
    }
    if (peek().kind === 'eof') fail(open, `Manca END_CASE per CASE della riga ${open.line}`);
    expect('END_CASE');
    expect(';');
    return { k: 'case', sel, arms, ...(otherwise ? { else: otherwise } : {}), ...pos(open) };
  }

  function atCaseValue(): boolean {
    let q = p;
    if (toks[q]?.text === '-') q++;
    const n = toks[q + 1];
    return toks[q]?.kind === 'int' && n?.kind === 'op' && [':', ',', '..'].includes(n.text);
  }

  function forStmt(): Stmt {
    const open = toks[p++]!;
    const v = operand();
    expect(':=');
    const from = expr();
    expect('TO');
    const to = expr();
    let by: (Pos & { text: string }) | undefined;
    if (is('BY')) {
      p++;
      const t = peek();
      const neg = is('-');
      if (neg) p++;
      if (peek().kind !== 'int') fail(t, 'In prova BY accetta solo un numero intero costante');
      by = { text: (neg ? '-' : '') + toks[p++]!.text, ...pos(t) };
    }
    expect('DO');
    const body = block(open, 'END_FOR');
    expect('END_FOR');
    expect(';');
    return { k: 'for', v, from, to, ...(by ? { by } : {}), body, ...pos(open) };
  }

  function operand(): Operand {
    const t = peek();
    if (t.kind === 'local' || t.kind === 'id' || t.kind === 'symbol' || t.kind === 'addr') {
      p++;
      return { k: t.kind, text: t.text, ...pos(t) };
    }
    return fail(t, `Atteso un operando, trovato ${shown(t)}`);
  }

  function expr(level = 0): Expr {
    if (level === LEVELS.length) return additive();
    let l = expr(level + 1);
    while (is(...LEVELS[level]!)) {
      const t = toks[p++]!;
      const op = up(t) === '&' ? 'AND' : up(t);
      const r = expr(level + 1);
      if (level === 3 && is(...LEVELS[3]!))
        fail(peek(), 'Confronti in catena: servono le parentesi');
      l = { k: 'bin', op, l, r, ...pos(t) };
    }
    return l;
  }

  function additive(): Expr {
    let l = term();
    while (is(...ADD)) {
      const t = toks[p++]!;
      l = { k: 'bin', op: t.text, l, r: term(), ...pos(t) };
    }
    return l;
  }

  function term(): Expr {
    let l = unary();
    while (is(...MUL)) {
      const t = toks[p++]!;
      l = { k: 'bin', op: up(t), l, r: unary(), ...pos(t) };
    }
    if (is('**')) fail(peek(), 'La potenza ** non è supportata in prova');
    return l;
  }

  function unary(): Expr {
    const t = peek();
    if (is('NOT')) {
      p++;
      return { k: 'not', e: unary(), ...pos(t) };
    }
    if (is('-')) {
      p++;
      const n = peek();
      // -123 è un letterale (serve per -32768 e per il tipo del letterale)
      if (n.kind === 'int' || n.kind === 'real') {
        p++;
        return { k: n.kind, text: `-${n.text}`, ...pos(t) };
      }
      return { k: 'neg', e: unary(), ...pos(t) };
    }
    if (is('+')) {
      p++;
      return unary();
    }
    return primary();
  }

  function primary(): Expr {
    const t = peek();
    if (is('(')) {
      p++;
      const e = expr();
      expect(')');
      return e;
    }
    if (t.kind === 'int' || t.kind === 'real') {
      p++;
      return { k: t.kind, text: t.text, ...pos(t) };
    }
    if (is('TRUE', 'FALSE')) {
      p++;
      return { k: 'bool', value: up(t) === 'TRUE', ...pos(t) };
    }
    if (t.kind === 'id' && toks[p + 1]?.text === '(') {
      p += 2;
      const arg = expr();
      expect(')');
      return { k: 'call', name: up(t), arg, ...pos(t) };
    }
    return operand();
  }

  const out = statements();
  if (peek().kind !== 'eof') fail(peek(), `Inatteso ${shown(peek())}`);
  return out;
}
