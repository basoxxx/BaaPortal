// Parser a discesa ricorsiva del sottoinsieme SCL in prova (istruzioni, senza intestazione del
// blocco: l'interfaccia è quella del blocco). Precedenze dal manuale pubblico SCL, dalla più bassa:
// OR, XOR, AND/&, confronti, + -, * / MOD, NOT e meno unario, **.
import { intLiteral, lex, SclError, type Tok } from './lexer.js';

export type Pos = { line: number; col: number };
/**
 * Membro dopo `.` (nome come scritto, virgolette comprese) con i suoi indici: costanti in `index`,
 * con almeno un indice variabile in `vindex` (uno per dimensione).
 */
export type Seg = { name: string; index?: number[]; vindex?: Expr[] };
export type Operand =
  | (Pos & {
      k: 'local' | 'id' | 'symbol' | 'addr';
      text: string;
      /** Indici costanti dopo il nome: `#a[3]`, `#m[1, 2]`. */
      index?: number[];
      /** Membri dopo il nome: `#s.x`, `"DB".m[2].n`. */
      path?: Seg[];
      /** Indici variabili dopo il nome (`#a[#i]`, `#m[#i, 2].x`); quelli dei membri in `path`. */
      vindex?: Expr[];
    })
  /** Solo dalla traduzione: una TEMP di appoggio già calcolata, di tipo `ty`. */
  | (Pos & { k: 'temp'; text: string; ty: string });
/**
 * Parametro attuale per nome: `p := espressione` oppure `p => variabile` (`out`); per posizione
 * (`"Fc"(1, #x)`) `name` è vuoto.
 */
export type Arg = Pos & { name: string; out: boolean; e: Expr };
/** Chiamata di un blocco: `"Fc"(a := 1, b => #x)`, `"Inst_DB"(…)`, `#multi(…)`. */
export type Call = Pos & { k: 'fcall'; callee: Operand; args: Arg[] };
/** Valore di un ramo del CASE; con `hi` è l'intervallo `text..hi`, estremi compresi. */
export type CaseValue = Pos & { text: string; hi?: string };
export type Expr =
  | Operand
  | Call
  | (Pos & { k: 'int' | 'real'; text: string })
  /** Durata o data (`T#5s`, `D#2024-01-01`), come scritta. */
  | (Pos & { k: 'tlit'; text: string })
  /** Costante fra apici, senza gli apici: un CHAR (`'A'`) o una STRING. */
  | (Pos & { k: 'str'; text: string })
  | (Pos & { k: 'bool'; value: boolean })
  | (Pos & { k: 'neg' | 'not'; e: Expr })
  | (Pos & { k: 'bin'; op: string; l: Expr; r: Expr })
  /** `NOME(x)`: `name` in maiuscolo, `raw` come scritto (può essere una FC chiamata per posizione). */
  | (Pos & { k: 'call'; name: string; raw: string; arg: Expr });
export type Stmt =
  | (Pos & { k: 'assign'; dst: Operand; e: Expr })
  | (Pos & { k: 'call'; c: Call })
  | (Pos & { k: 'if'; arms: { cond: Expr; body: Stmt[] }[]; else?: Stmt[] })
  | (Pos & {
      k: 'case';
      sel: Expr;
      arms: { values: CaseValue[]; body: Stmt[] }[];
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
  | (Pos & { k: 'return' | 'exit' | 'continue' });

const LEVELS: string[][] = [['OR'], ['XOR'], ['AND', '&'], ['=', '<>', '<', '>', '<=', '>=']];
const ADD = ['+', '-'];
const MUL = ['*', '/', 'MOD'];
const ARROWS = [':=', '=>'];

/** Errori riportati al massimo; oltre, il parser si ferma. */
export const MAX_ERRORS = 50;
const BLOCK_ENDS = new Set(['ELSIF', 'ELSE', 'UNTIL']);
/** Fermata del parser al raggiungimento di MAX_ERRORS. */
class TooMany extends Error {}

/**
 * Le istruzioni e tutti gli errori di sintassi (fino a MAX_ERRORS): dopo un errore il parser
 * riparte dopo il `;` dell'istruzione, oppure dalla fine del costrutto che la contiene (END_…).
 * Un errore nell'intestazione di IF, CASE, FOR, WHILE o UNTIL salta il resto della riga e
 * prosegue col corpo. Con errori, le istruzioni sbagliate mancano dal risultato.
 */
export function parse(text: string): { stmts: Stmt[]; errors: SclError[] } {
  const errors: SclError[] = [];
  const toks = lex(text, { errors });
  // Su una riga con un errore del lexer, quelli del parser ne sono di solito la conseguenza.
  const lexLines = new Set(errors.map((e) => e.line));
  const record = (e: unknown) => {
    if (!(e instanceof SclError)) throw e;
    if (!lexLines.has(e.line)) errors.push(e);
    if (errors.length >= MAX_ERRORS) throw new TooMany();
  };
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
  const pos = (t: Pos): Pos => ({ line: t.line, col: t.col });
  /** `nome :=` o `nome =>` a partire dal token `q`: un parametro per nome. */
  const namedAt = (q: number) => toks[q]?.kind === 'id' && ARROWS.includes(toks[q + 1]?.text ?? '');

  function statements(...ends: string[]): Stmt[] {
    const out: Stmt[] = [];
    while (!is(...ends) && peek().kind !== 'eof') guarded(out, ends);
    return out;
  }

  /** Fine di un costrutto (END_…, ELSIF, ELSE, UNTIL): dopo un errore si riparte da lì. */
  const atBlockEnd = () =>
    peek().kind === 'kw' && (up(peek()).startsWith('END_') || BLOCK_ENDS.has(up(peek())));

  /** Un'istruzione in `out`; con un errore lo registra e salta al `;` o alla fine del costrutto. */
  function guarded(out: Stmt[], ends: string[]): void {
    const start = p;
    try {
      out.push(statement());
    } catch (e) {
      record(e);
      while (peek().kind !== 'eof' && !is(';', ...ends) && !atBlockEnd()) p++;
      // un END_… fuori posto: lo si salta, se no il ciclo non avanza
      if (p === start) p++;
      if (is(';')) p++;
    }
  }

  /**
   * Il `;` alla fine di un'istruzione. Se manca e dopo c'è un'altra riga, l'errore va sulla riga
   * dove manca e il parser prosegue; sulla stessa riga è un errore come gli altri.
   */
  function semi(): void {
    if (is(';')) {
      p++;
      return;
    }
    const prev = toks[p - 1]!;
    if (peek().kind !== 'eof' && peek().line === prev.line) expect(';');
    record(new SclError(prev.line, prev.col + prev.text.length, `Manca «;» dopo ${shown(prev)}`));
  }

  /**
   * L'intestazione `head` di un costrutto e la parola `stop` che la chiude (THEN, DO, OF…). Con un
   * errore lo registra, salta fino a `stop` sulla stessa riga e torna `fallback`: il corpo si
   * legge comunque.
   */
  function header<T>(head: () => T, stop: string, fallback: T): T {
    const line = peek().line;
    try {
      const v = head();
      expect(stop);
      return v;
    } catch (e) {
      record(e);
      while (peek().kind !== 'eof' && !is(stop) && peek().line <= line) p++;
      if (is(stop)) p++;
      return fallback;
    }
  }
  const truth = (t: Pos): Expr => ({ k: 'bool', value: true, ...pos(t) });

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
      const cond = header(() => expr(), 'DO', truth(t));
      const body = block(t, 'END_WHILE');
      expect('END_WHILE');
      semi();
      return { k: 'while', cond, body, ...pos(t) };
    }
    if (kw === 'REPEAT') {
      p++;
      const body = block(t, 'END_REPEAT', 'UNTIL');
      const until = expect('UNTIL');
      const cond = header(() => expr(), 'END_REPEAT', truth(until));
      semi();
      return { k: 'repeat', body, cond, ...pos(t) };
    }
    if (kw === 'RETURN' || kw === 'EXIT' || kw === 'CONTINUE') {
      p++;
      semi();
      return { k: kw === 'RETURN' ? 'return' : kw === 'EXIT' ? 'exit' : 'continue', ...pos(t) };
    }
    const dst = operand();
    if (is('(')) {
      const c = call(dst);
      semi();
      return { k: 'call', c, ...pos(t) };
    }
    expect(':=');
    const e = expr();
    semi();
    return { k: 'assign', dst, e, ...pos(t) };
  }

  function ifStmt(): Stmt {
    const open = toks[p++]!;
    const arms: { cond: Expr; body: Stmt[] }[] = [];
    let cond = header(() => expr(), 'THEN', truth(open));
    for (;;) {
      arms.push({ cond, body: block(open, 'END_IF', 'ELSIF', 'ELSE') });
      if (!is('ELSIF')) break;
      const at = toks[p++]!;
      cond = header(() => expr(), 'THEN', truth(at));
    }
    let otherwise: Stmt[] | undefined;
    if (is('ELSE')) {
      p++;
      otherwise = block(open, 'END_IF');
    }
    expect('END_IF');
    semi();
    return { k: 'if', arms, ...(otherwise ? { else: otherwise } : {}), ...pos(open) };
  }

  function caseInt(): string {
    const neg = is('-');
    if (neg) p++;
    const n = peek();
    if (n.kind !== 'int') fail(n, 'Nel CASE servono valori interi');
    p++;
    return neg ? `-${n.text}` : n.text;
  }

  /** Un valore `n` o un intervallo `a..b`. */
  function caseValue(): CaseValue {
    const t = peek();
    const text = caseInt();
    if (!is('..')) return { text, ...pos(t) };
    p++;
    return { text, hi: caseInt(), ...pos(t) };
  }

  function caseStmt(): Stmt {
    const open = toks[p++]!;
    const sel = header(() => expr(), 'OF', { k: 'int', text: '0', ...pos(open) } as Expr);
    const arms: { values: CaseValue[]; body: Stmt[] }[] = [];
    while (!is('ELSE', 'END_CASE') && peek().kind !== 'eof') {
      const values = header(
        () => {
          const vs = [caseValue()];
          while (is(',')) {
            p++;
            vs.push(caseValue());
          }
          return vs;
        },
        ':',
        [],
      );
      // il ramo finisce dove inizia il valore del ramo dopo (`n:`, `n,` o `n..`)
      const body: Stmt[] = [];
      while (!is('ELSE', 'END_CASE') && peek().kind !== 'eof' && !atCaseValue())
        guarded(body, ['ELSE', 'END_CASE']);
      if (values.length) arms.push({ values, body });
    }
    let otherwise: Stmt[] | undefined;
    if (is('ELSE')) {
      p++;
      if (is(':')) p++;
      otherwise = block(open, 'END_CASE');
    }
    if (peek().kind === 'eof') fail(open, `Manca END_CASE per CASE della riga ${open.line}`);
    expect('END_CASE');
    semi();
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
    const head = header(
      () => {
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
        return { v, from, to, ...(by ? { by } : {}) };
      },
      'DO',
      undefined,
    );
    const body = block(open, 'END_FOR');
    expect('END_FOR');
    semi();
    // intestazione sbagliata: il corpo resta un ciclo, per EXIT e CONTINUE
    if (!head) return { k: 'while', cond: truth(open), body, ...pos(open) };
    return { k: 'for', ...head, body, ...pos(open) };
  }

  function operand(): Operand {
    const t = peek();
    if (t.kind === 'local' || t.kind === 'id' || t.kind === 'symbol' || t.kind === 'addr') {
      p++;
      const o: Operand = { k: t.kind, text: t.text, ...pos(t) };
      if (t.kind === 'addr') return o;
      /** Indici tutti costanti come numeri (`index`), altrimenti espressioni (`vindex`). */
      const take = (): { index?: number[]; vindex?: Expr[] } => {
        const at = peek();
        const i = indices();
        if (!i) return {};
        if (i.every((e) => typeof e === 'number')) return { index: i as number[] };
        return {
          vindex: i.map((e) =>
            typeof e === 'number' ? { k: 'int', text: String(e), ...pos(at) } : e,
          ),
        };
      };
      const root = take();
      const path: Seg[] = [];
      while (is('.')) {
        p++;
        const m = peek();
        if (m.kind !== 'id' && m.kind !== 'symbol') fail(m, 'Dopo «.» serve il nome di un membro');
        p++;
        path.push({ name: m.text, ...take() });
      }
      return { ...o, ...root, ...(path.length ? { path } : {}) };
    }
    return fail(t, `Atteso un operando, trovato ${shown(t)}`);
  }

  /** Indici `[1, -2]` (numeri interi) o espressioni `[#i + 1, 2]`. */
  function indices(): (number | Expr)[] | undefined {
    if (!is('[')) return undefined;
    p++;
    const out: (number | Expr)[] = [];
    for (;;) {
      const neg = is('-');
      const n = toks[p + (neg ? 1 : 0)];
      if (n?.kind === 'int' && [']', ','].includes(toks[p + (neg ? 2 : 1)]?.text ?? '')) {
        p += neg ? 2 : 1;
        out.push(Number(intLiteral(`${neg ? '-' : ''}${n.text}`).value));
      } else out.push(expr());
      if (!is(',')) break;
      p++;
    }
    expect(']');
    return out;
  }

  /** I parametri dopo il blocco chiamato: `(a := espressione, b => variabile)`, anche nessuno. */
  function call(callee: Operand): Call {
    expect('(');
    const args: Arg[] = [];
    while (!is(')')) args.push(arg(args));
    expect(')');
    return { k: 'fcall', callee, args, ...pos(callee) };
  }

  /** Un parametro attuale e la `,` dopo; per nome o per posizione come i parametri prima. */
  function arg(args: Arg[]): Arg {
    const n = peek();
    const named = namedAt(p);
    if (args.length && named !== (args[0]!.name !== ''))
      fail(n, 'Parametri per nome e per posizione non si mescolano nella stessa chiamata');
    let a: Arg;
    if (named) {
      p++;
      const out = toks[p++]!.text === '=>';
      a = { name: n.text, out, e: out ? operand() : expr(), ...pos(n) };
    } else a = { name: '', out: false, e: expr(), ...pos(n) };
    if (is(',')) p++;
    else if (!is(')')) expect(')');
    return a;
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
      if ((n.kind === 'int' || n.kind === 'real') && toks[p + 1]?.text !== '**') {
        p++;
        return { k: n.kind, text: `-${n.text}`, ...pos(t) };
      }
      return { k: 'neg', e: unary(), ...pos(t) };
    }
    if (is('+')) {
      p++;
      return unary();
    }
    return power();
  }

  /**
   * `a ** b`, sopra il meno unario (`-2 ** 2` è -4); l'esponente può avere il segno. Le potenze in
   * catena vogliono le parentesi (l'associatività non è verificata con STEP 7).
   */
  function power(): Expr {
    const l = primary();
    if (!is('**')) return l;
    const t = toks[p++]!;
    let r: Expr;
    if (is('-', '+')) {
      const s = toks[p++]!;
      const x = primary();
      r =
        s.text === '+'
          ? x
          : x.k === 'int' || x.k === 'real'
            ? { ...x, text: `-${x.text}` }
            : { k: 'neg', e: x, ...pos(s) };
    } else r = primary();
    if (is('**')) fail(peek(), 'Potenze in catena: servono le parentesi');
    return { k: 'bin', op: '**', l, r, ...pos(t) };
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
    if (t.kind === 'time') {
      p++;
      return { k: 'tlit', text: t.text, ...pos(t) };
    }
    if (t.kind === 'string') {
      p++;
      return { k: 'str', text: t.text.slice(1, -1), ...pos(t) };
    }
    if (is('TRUE', 'FALSE')) {
      p++;
      return { k: 'bool', value: up(t) === 'TRUE', ...pos(t) };
    }
    // conversione `INT_TO_DINT(x)`: un nome con un solo argomento senza nome; con più argomenti
    // è un blocco chiamato per posizione
    if (
      t.kind === 'id' &&
      toks[p + 1]?.text === '(' &&
      !namedAt(p + 2) &&
      toks[p + 2]?.text !== ')'
    ) {
      p += 2;
      const first = expr();
      if (!is(',')) {
        expect(')');
        return { k: 'call', name: up(t), raw: t.text, arg: first, ...pos(t) };
      }
      p++;
      const args: Arg[] = [{ name: '', out: false, e: first, ...pos(first) }];
      while (!is(')')) args.push(arg(args));
      expect(')');
      return { k: 'fcall', callee: { k: 'id', text: t.text, ...pos(t) }, args, ...pos(t) };
    }
    const o = operand();
    return is('(') ? call(o) : o;
  }

  const stmts: Stmt[] = [];
  try {
    while (peek().kind !== 'eof') guarded(stmts, []);
  } catch (e) {
    if (!(e instanceof TooMany)) throw e;
  }
  return { stmts, errors };
}
