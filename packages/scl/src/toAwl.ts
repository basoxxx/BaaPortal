// Traduzione SCL → AWL (mnemonici internazionali) del sottoinsieme in prova, piano rc-1.0 task 4.
// Numeri in ACCU1 (S7-300: `L` sposta ACCU1 in ACCU2; `-I` e `/I` fanno ACCU2 op ACCU1), logica
// nell'RLO con al massimo 7 parentesi aperte, TEMP di appoggio dopo `tempEnd` allocate a pila,
// etichette `_001`… su `NOP 0`. Nessun AWL se c'è anche un solo errore.
import { formatNetwork, type AwlContext } from '@baaportal/awl';
import { sameName, type DataType } from '@baaportal/s7-types';
import { parseAddress, SclError } from './lexer.js';
import { parse, type Expr, type Operand, type Pos, type Stmt } from './parser.js';

export type SclDiag = { line: number; col: number; message: string }; // line 1-based
export type SclAwl = {
  source: string;
  /** Riga 0-based dell'AWL generato → riga 1-based del testo SCL. */
  lines: { line: number; sclLine: number }[];
  diagnostics: SclDiag[];
};

type Ty = 'BOOL' | 'INT' | 'DINT' | 'REAL';
type Num = Exclude<Ty, 'BOOL'>;
type Conn = 'A' | 'O' | 'X';

const MAX_BRACKETS = 7;
const MAX_LABEL = 999;
const ELEMENTARY: Record<string, Ty> = { Bool: 'BOOL', Int: 'INT', DInt: 'DINT', Real: 'REAL' };
const SUFFIX: Record<Num, string> = { INT: 'I', DINT: 'D', REAL: 'R' };
const SIZE: Record<Num, number> = { INT: 2, DINT: 4, REAL: 4 };
const CMP: Record<string, string> = {
  '=': '==',
  '<>': '<>',
  '<': '<',
  '>': '>',
  '<=': '<=',
  '>=': '>=',
};
const BOOL_OP: Record<string, Conn> = { AND: 'A', OR: 'O', XOR: 'X' };
/** Conversioni ammesse: tipo dell'argomento, tipo del risultato, istruzioni. */
const CONV: Record<string, [Num, Num, string[]]> = {
  INT_TO_DINT: ['INT', 'DINT', ['ITD']],
  INT_TO_REAL: ['INT', 'REAL', ['ITD', 'DTR']],
  DINT_TO_REAL: ['DINT', 'REAL', ['DTR']],
  ROUND: ['REAL', 'DINT', ['RND']],
  TRUNC: ['REAL', 'DINT', ['TRUNC']],
};
const HINT: Partial<Record<string, string>> = {
  'INT→DINT': 'INT_TO_DINT',
  'INT→REAL': 'INT_TO_REAL',
  'DINT→REAL': 'DINT_TO_REAL',
  'REAL→DINT': 'ROUND o TRUNC',
};

const fail = (at: Pos, message: string): never => {
  throw new SclError(at.line, at.col, message);
};

function mismatch(at: Pos, want: Ty, got: Ty): never {
  const fn = HINT[`${got}→${want}`];
  const tail = fn
    ? `: usa ${fn}`
    : want !== 'BOOL' && got !== 'BOOL'
      ? ` (${got}_TO_${want} non è supportata in prova)`
      : '';
  return fail(at, `Tipi diversi: serve ${want}, c'è ${got}${tail}`);
}

const isLiteral = (e: Expr) => e.k === 'int' || e.k === 'real';
/** Operando che si carica con un solo `L` (variabile o letterale). */
const isSimple = (e: Expr) =>
  isLiteral(e) || e.k === 'local' || e.k === 'id' || e.k === 'symbol' || e.k === 'addr';

class Gen {
  readonly out: { text: string; sclLine: number }[] = [];
  private sclLine = 1;
  private labelNo = 1;
  private tempTop: number;
  private depth = 0;

  constructor(
    private readonly ctx: AwlContext,
    tempEnd: number,
  ) {
    this.tempTop = tempEnd;
  }

  private emit(...texts: string[]): void {
    for (const text of texts) this.out.push({ text, sclLine: this.sclLine });
  }

  private label(at: Pos): string {
    const n = this.labelNo++;
    if (n > MAX_LABEL) fail(at, 'Troppe etichette automatiche (oltre _999)');
    return `_${String(n).padStart(3, '0')}`;
  }

  private place(label: string): void {
    this.emit(`${label}: NOP 0`);
  }

  /** TEMP di appoggio a pila: `use` riceve l'indirizzo, poi la TEMP torna libera. */
  private withTemp<T>(ty: Num, use: (addr: string) => T): T {
    const at = this.tempTop;
    this.tempTop += SIZE[ty];
    try {
      return use(`${ty === 'INT' ? 'LW' : 'LD'} ${at}`);
    } finally {
      this.tempTop = at;
    }
  }

  // ---- operandi e tipi ----

  private resolve(o: Operand): { awl: string; ty: Ty; constant: boolean } {
    const typed = (t: DataType | null) =>
      t?.kind === 'elementary' ? ELEMENTARY[t.name] : undefined;
    if (o.k === 'addr') {
      const a = parseAddress(o.text);
      if (a.size === 'B') fail(o, `Indirizzi BYTE non supportati in SCL in prova: ${o.text}`);
      return {
        awl: a.awl,
        ty: a.size === 'X' ? 'BOOL' : a.size === 'W' ? 'INT' : 'DINT',
        constant: false,
      };
    }
    if (o.k === 'symbol') {
      const name = o.text.slice(1, -1);
      const s = this.ctx.symbol(name);
      if (!s) fail(o, `Operando sconosciuto: ${o.text}`);
      const ty = typed(s!.type);
      if (!ty)
        fail(o, `Tipo di ${o.text} non supportato in SCL in prova (solo BOOL, INT, DINT, REAL)`);
      return { awl: o.text, ty: ty!, constant: s!.kind === 'constant' };
    }
    const name = o.k === 'local' ? o.text.slice(1) : o.text;
    const i = this.ctx.owner.iface;
    const m = [...i.input, ...i.output, ...i.inOut, ...i.static, ...i.temp].find((x) =>
      sameName(x.name, name),
    );
    if (!m) fail(o, `Operando sconosciuto: ${name}`);
    const ty = typed(m!.type);
    if (!ty) fail(o, `Tipo di ${name} non supportato in SCL in prova (solo BOOL, INT, DINT, REAL)`);
    return { awl: `#${m!.name}`, ty: ty!, constant: false };
  }

  /** Tipo di un'espressione; un letterale prende `hint` se ci sta (vedi `literal`). */
  typeOf(e: Expr, hint?: Ty): Ty {
    switch (e.k) {
      case 'int':
      case 'real':
        return this.literal(e, hint).ty;
      case 'bool':
        return 'BOOL';
      case 'local':
      case 'id':
      case 'symbol':
      case 'addr':
        return this.resolve(e).ty;
      case 'not':
        this.want(e.e, 'BOOL');
        return 'BOOL';
      case 'neg': {
        const t = this.typeOf(e.e, hint);
        if (t === 'BOOL') fail(e, 'Il meno si usa solo con i numeri');
        return t;
      }
      case 'call': {
        const c = CONV[e.name];
        if (!c) fail(e, `Funzione non supportata in SCL in prova: ${e.name}`);
        this.want(e.arg, c![0]);
        return c![1];
      }
      case 'bin': {
        if (e.op in BOOL_OP) {
          this.want(e.l, 'BOOL');
          this.want(e.r, 'BOOL');
          return 'BOOL';
        }
        const t = this.pair(e, e.op in CMP ? undefined : hint);
        if (t === 'BOOL') fail(e, `L'operatore ${e.op} non si usa con BOOL: usa AND, OR, XOR, NOT`);
        if (e.op === 'MOD' && t !== 'DINT')
          fail(
            e,
            t === 'INT' ? 'MOD in prova solo su DINT: usa INT_TO_DINT' : 'MOD non si usa con REAL',
          );
        return e.op in CMP ? 'BOOL' : t;
      }
    }
  }

  /** Tipo comune dei due lati: il letterale prende il tipo dell'altro lato. */
  private pair(e: Extract<Expr, { k: 'bin' }>, hint?: Ty): Ty {
    const [first, second] = isLiteral(e.l) && !isLiteral(e.r) ? [e.r, e.l] : [e.l, e.r];
    const t = this.typeOf(first, hint);
    const u = this.typeOf(second, t);
    if (t === u) return t;
    // due letterali (o un letterale che non ci sta): il più largo, se ci sta
    if (isLiteral(second) && this.typeOf(first, u) === u) return u;
    return mismatch(second, t, u);
  }

  private want(e: Expr, ty: Ty): void {
    const t = this.typeOf(e, ty);
    if (t !== ty) mismatch(e, ty, t);
  }

  /** Letterale nel tipo `hint` se ci sta, altrimenti nel suo tipo naturale; testo per `L`. */
  private literal(e: Expr & { text: string }, hint?: Ty): { ty: Num; awl: string } {
    if (e.k === 'real') {
      const v = Number(e.text);
      if (!Number.isFinite(Math.fround(v))) fail(e, `Costante REAL fuori intervallo: ${e.text}`);
      return { ty: 'REAL', awl: e.text.includes('.') ? e.text : e.text.replace(/[eE]/, '.0e') };
    }
    const v = BigInt(e.text);
    if (hint === 'REAL') return { ty: 'REAL', awl: `${v}.0` };
    if (hint !== 'DINT' && v >= -32768n && v <= 32767n) return { ty: 'INT', awl: String(v) };
    if (v < -(2n ** 31n) || v >= 2n ** 31n) fail(e, `Costante fuori intervallo DINT: ${e.text}`);
    return { ty: 'DINT', awl: `L#${v}` };
  }

  // ---- espressioni numeriche: risultato in ACCU1 ----

  private load(e: Expr, ty: Ty): string {
    return isLiteral(e)
      ? this.literal(e as Expr & { text: string }, ty).awl
      : this.resolve(e as Operand).awl;
  }

  num(e: Expr, ty: Num): void {
    if (isSimple(e)) return this.emit(`L ${this.load(e, ty)}`);
    if (e.k === 'neg') {
      this.num(e.e, ty);
      return this.emit(`NEG${SUFFIX[ty]}`);
    }
    if (e.k === 'call') {
      const [from, , code] = CONV[e.name]!;
      this.num(e.arg, from);
      return this.emit(...code);
    }
    if (e.k !== 'bin') return fail(e, 'Espressione numerica non valida');
    this.operands(e, ty);
    this.emit(e.op === 'MOD' ? 'MOD' : `${e.op}${SUFFIX[ty]}`);
  }

  /** `l` in ACCU2 e `r` in ACCU1; una destra complessa passa da una TEMP di appoggio. */
  private operands(e: Extract<Expr, { k: 'bin' }>, ty: Num): void {
    if (isSimple(e.r)) {
      this.num(e.l, ty);
      return this.emit(`L ${this.load(e.r, ty)}`);
    }
    this.num(e.r, ty);
    this.withTemp(ty, (tmp) => {
      this.emit(`T ${tmp}`);
      this.num(e.l, ty);
      this.emit(`L ${tmp}`);
    });
  }

  private compare(e: Extract<Expr, { k: 'bin' }>): void {
    const ty = this.pair(e) as Num;
    this.operands(e, ty);
    this.emit(`${CMP[e.op]}${SUFFIX[ty]}`);
  }

  // ---- espressioni booleane: risultato nell'RLO ----

  /**
   * Una catena è omogenea: tutti i suoi elementi si combinano con lo stesso `conn` (A, O o X), così
   * non conta la precedenza di AWL fra A e O. Un'operazione diversa da `conn`, un confronto o un
   * NOT di un'espressione vanno fra parentesi, tranne il primo elemento della catena, che non
   * combina con niente (primo controllo).
   */
  private chain(e: Expr, conn: Conn, first: boolean, at: Pos): void {
    if (e.k === 'bin' && BOOL_OP[e.op] === conn) {
      this.chain(e.l, conn, first, at);
      this.chain(e.r, conn, false, at);
      return;
    }
    const c = first ? 'A' : conn;
    if (e.k === 'not' && isSimple(e.e))
      return this.emit(`${c}N ${this.resolve(e.e as Operand).awl}`);
    if (isSimple(e)) return this.emit(`${c} ${this.resolve(e as Operand).awl}`);
    if (first && e.k === 'bin' && e.op in CMP) return this.compare(e);
    const neg = e.k === 'not';
    this.bracket(`${c}${neg ? 'N' : ''}(`, at, () => this.cond(neg ? e.e : e, at));
  }

  private bracket(open: string, at: Pos, body: () => void): void {
    if (++this.depth > MAX_BRACKETS)
      fail(
        at,
        `Espressione troppo annidata: AWL ammette al massimo ${MAX_BRACKETS} parentesi aperte`,
      );
    this.emit(open);
    body();
    this.emit(')');
    this.depth--;
  }

  /** L'RLO di un'espressione BOOL, da capo. */
  cond(e: Expr, at: Pos): void {
    if (e.k === 'bool') return this.emit(e.value ? 'SET' : 'CLR');
    if (e.k === 'bin' && e.op in BOOL_OP) return this.chain(e, BOOL_OP[e.op]!, true, at);
    if (e.k === 'bin' && e.op in CMP) return this.compare(e);
    this.chain(e, 'A', true, at);
  }

  private boolExpr(e: Expr, at: Pos): void {
    this.want(e, 'BOOL');
    this.cond(e, at);
  }

  // ---- istruzioni ----

  stmts(list: Stmt[]): void {
    for (const s of list) this.stmt(s);
  }

  private stmt(s: Stmt): void {
    this.sclLine = s.line;
    switch (s.k) {
      case 'assign': {
        const dst = this.resolve(s.dst);
        if (dst.constant) fail(s.dst, `Non si può scrivere in una costante: ${s.dst.text}`);
        this.want(s.e, dst.ty);
        if (dst.ty === 'BOOL') {
          this.cond(s.e, s);
          return this.emit(`= ${dst.awl}`);
        }
        this.num(s.e, dst.ty);
        return this.emit(`T ${dst.awl}`);
      }
      case 'if': {
        const end = this.label(s);
        s.arms.forEach((arm, i) => {
          this.sclLine = arm.cond.line;
          const last = i === s.arms.length - 1 && !s.else;
          const next = last ? end : this.label(s);
          this.boolExpr(arm.cond, arm.cond);
          this.emit(`JCN ${next}`);
          this.stmts(arm.body);
          if (!last) {
            this.emit(`JU ${end}`);
            this.place(next);
          }
        });
        if (s.else) this.stmts(s.else);
        this.sclLine = s.line;
        return this.place(end);
      }
      case 'case':
        return this.caseStmt(s);
      case 'for':
        return this.forStmt(s);
      case 'while': {
        const [top, end] = [this.label(s), this.label(s)];
        this.place(top);
        this.boolExpr(s.cond, s.cond);
        this.emit(`JCN ${end}`);
        this.stmts(s.body);
        this.sclLine = s.line;
        this.emit(`JU ${top}`);
        return this.place(end);
      }
      case 'repeat': {
        const top = this.label(s);
        this.place(top);
        this.stmts(s.body);
        this.sclLine = s.cond.line;
        this.boolExpr(s.cond, s.cond);
        return this.emit(`JCN ${top}`);
      }
      case 'return':
        return this.emit('BEU');
    }
  }

  /** Selettore letto una volta sola (TEMP se è un'espressione); `==` e `JC` per ogni valore. */
  private caseStmt(s: Extract<Stmt, { k: 'case' }>): void {
    const ty = this.typeOf(s.sel);
    if (ty !== 'INT' && ty !== 'DINT')
      fail(s.sel, `Il selettore del CASE dev'essere INT o DINT, c'è ${ty}`);
    const n = ty as 'INT' | 'DINT';
    const seen = new Set<bigint>();
    const run = (sel: string) => {
      const end = this.label(s);
      const targets = s.arms.map((arm) => {
        const lab = this.label(s);
        for (const v of arm.values) {
          const lit = this.literal({ k: 'int', ...v }, n);
          if (lit.ty !== n) fail(v, `Valore ${v.text} fuori intervallo ${n}`);
          if (seen.has(BigInt(v.text))) fail(v, `Valore ${v.text} ripetuto nel CASE`);
          seen.add(BigInt(v.text));
          this.emit(`L ${sel}`, `L ${lit.awl}`, `==${SUFFIX[n]}`, `JC ${lab}`);
        }
        return lab;
      });
      const otherwise = s.else ? this.label(s) : end;
      this.emit(`JU ${otherwise}`);
      s.arms.forEach((arm, i) => {
        this.sclLine = arm.values[0]!.line;
        this.place(targets[i]!);
        this.stmts(arm.body);
        // ogni ramo esce dal CASE: mai nel ramo dopo
        if (i < s.arms.length - 1 || s.else) this.emit(`JU ${end}`);
      });
      if (s.else) {
        this.place(otherwise);
        this.stmts(s.else);
      }
      this.sclLine = s.line;
      this.place(end);
    };
    if (isSimple(s.sel)) return run(this.load(s.sel, n));
    this.num(s.sel, n);
    this.withTemp(n, (tmp) => {
      this.emit(`T ${tmp}`);
      run(tmp);
    });
  }

  /**
   * FOR su INT o DINT: il valore finale si calcola una volta sola (in una TEMP); l'uscita è `>` con
   * BY positivo e `<` con BY negativo. L'incremento che va oltre i limiti del tipo (OV) esce dal
   * ciclo senza scrivere la variabile, così `TO 32767` non gira all'infinito: dopo il ciclo la
   * variabile vale l'ultimo valore eseguito.
   */
  private forStmt(s: Extract<Stmt, { k: 'for' }>): void {
    const v = this.resolve(s.v);
    if (v.ty !== 'INT' && v.ty !== 'DINT')
      fail(s.v, `La variabile del FOR dev'essere INT o DINT, c'è ${v.ty}`);
    if (v.constant) fail(s.v, `Non si può scrivere in una costante: ${s.v.text}`);
    const ty = v.ty as 'INT' | 'DINT';
    const step = BigInt(s.by?.text ?? '1');
    if (step === 0n) fail(s.by!, 'BY 0 non termina mai');
    const at = s.by ?? s;
    const by = this.literal({ k: 'int', text: String(step), line: at.line, col: at.col }, ty);
    if (by.ty !== ty) fail(s.by!, `BY ${step} fuori intervallo ${ty}`);
    this.want(s.from, ty);
    this.want(s.to, ty);
    const t = SUFFIX[ty];
    this.num(s.from, ty);
    this.emit(`T ${v.awl}`);
    const loop = (end: string) => {
      const [top, exit] = [this.label(s), this.label(s)];
      this.place(top);
      this.emit(`L ${v.awl}`, `L ${end}`, `${step > 0n ? '>' : '<'}${t}`, `JC ${exit}`);
      this.stmts(s.body);
      this.sclLine = s.line;
      this.emit(`L ${v.awl}`, `L ${by.awl}`, `+${t}`, `JO ${exit}`, `T ${v.awl}`, `JU ${top}`);
      this.place(exit);
    };
    if (isLiteral(s.to)) return loop(this.load(s.to, ty));
    this.num(s.to, ty);
    this.withTemp(ty, (tmp) => {
      this.emit(`T ${tmp}`);
      loop(tmp);
    });
  }
}

export function sclToAwl(text: string, ctx: AwlContext, tempEnd: number): SclAwl {
  const gen = new Gen(ctx, tempEnd);
  try {
    gen.stmts(parse(text));
  } catch (e) {
    if (!(e instanceof SclError)) throw e;
    return {
      source: '',
      lines: [],
      diagnostics: [{ line: e.line, col: e.col, message: e.message }],
    };
  }
  const plain = gen.out.map((l) => l.text).join('\n');
  // forma canonica come nel KOP; se cambia il numero di righe resta il testo grezzo
  const formatted = formatNetwork(plain, 'international');
  return {
    source: formatted.split('\n').length === gen.out.length ? formatted : plain,
    lines: gen.out.map((l, line) => ({ line, sclLine: l.sclLine })),
    diagnostics: [],
  };
}
