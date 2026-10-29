// Traduzione SCL → AWL (mnemonici internazionali) del sottoinsieme in prova, piano rc-1.0 task 4
// e versione 1.1. Numeri e stringhe di bit in ACCU1 (S7-300: `L` sposta ACCU1 in ACCU2; `-I` e
// `/I` fanno ACCU2 op ACCU1), logica nell'RLO con al massimo 7 parentesi aperte, TEMP di appoggio
// dopo `tempEnd` allocate a pila, etichette `_001`… su `NOP 0`. Nessun AWL se c'è anche un solo
// errore.
import { formatNetwork, type AwlContext, type AwlInterface } from '@baaportal/awl';
import { callLines } from '@baaportal/ladfbd';
import { formatType, sameName, type DataType, type TypedMember } from '@baaportal/s7-types';
import { intLiteral, parseAddress, SclError } from './lexer.js';
import {
  parse,
  type Call,
  type Expr,
  type Operand,
  type Pos,
  type Seg,
  type Stmt,
} from './parser.js';

export type SclDiag = { line: number; col: number; message: string }; // line 1-based
export type SclAwl = {
  source: string;
  /** Riga 0-based dell'AWL generato → riga 1-based del testo SCL. */
  lines: { line: number; sclLine: number }[];
  diagnostics: SclDiag[];
};

type Ty = 'BOOL' | 'BYTE' | 'WORD' | 'DWORD' | 'INT' | 'DINT' | 'REAL';
type Num = Exclude<Ty, 'BOOL'>;
type Bits = 'BYTE' | 'WORD' | 'DWORD';
type Conn = 'A' | 'O' | 'X';

const MAX_BRACKETS = 7;
const MAX_LABEL = 999;
const SUPPORTED = 'solo BOOL, BYTE, WORD, DWORD, INT, DINT, REAL';
const ELEMENTARY: Record<string, Ty> = {
  Bool: 'BOOL',
  Byte: 'BYTE',
  Word: 'WORD',
  DWord: 'DWORD',
  Int: 'INT',
  DInt: 'DINT',
  Real: 'REAL',
};
const isBits = (t: Ty): t is Bits => t === 'BYTE' || t === 'WORD' || t === 'DWORD';
const SUFFIX: Record<Num, string> = {
  BYTE: 'I',
  WORD: 'I',
  DWORD: 'D',
  INT: 'I',
  DINT: 'D',
  REAL: 'R',
};
const SIZE: Record<Num, number> = { BYTE: 1, WORD: 2, DWORD: 4, INT: 2, DINT: 4, REAL: 4 };
/** Intervallo dei valori interi di ogni tipo. */
const RANGE: Partial<Record<Ty, [bigint, bigint]>> = {
  INT: [-32768n, 32767n],
  DINT: [-(2n ** 31n), 2n ** 31n - 1n],
  BYTE: [0n, 255n],
  WORD: [0n, 65535n],
  DWORD: [0n, 2n ** 32n - 1n],
};
const HEX: Partial<Record<Ty, string>> = { BYTE: 'B#16#', WORD: 'W#16#', DWORD: 'DW#16#' };
const CMP: Record<string, string> = {
  '=': '==',
  '<>': '<>',
  '<': '<',
  '>': '>',
  '<=': '<=',
  '>=': '>=',
};
const BOOL_OP: Record<string, Conn> = { AND: 'A', OR: 'O', XOR: 'X' };
/** AND/OR/XOR a parola: `AW`, `OD`, `XOW`… (BYTE si fa a parola: i bit alti restano 0). */
const WORD_OP: Record<string, string> = { AND: 'A', OR: 'O', XOR: 'XO' };
/** NOT di una stringa di bit; un BYTE inverte solo i suoi 8 bit, così resta fra 0 e 255. */
const INVERT: Record<Bits, string> = { BYTE: 'XOW W#16#FF', WORD: 'INVI', DWORD: 'INVD' };
/**
 * Conversioni ammesse: tipo dell'argomento, tipo del risultato, istruzioni. Le conversioni verso
 * un tipo più stretto (DINT_TO_INT, DWORD_TO_WORD, INT_TO_WORD…) non scrivono niente: le
 * istruzioni a 16 bit (`T` di una parola, `==I`, `+I`, `ITD`) leggono solo la parola bassa di
 * ACCU1, quindi si tengono i 16 bit bassi. Un DINT fuori da -32768..32767 dà il suo resto
 * modulo 65536 (70000 → 4464, 32768 → -32768) senza segnalare l'errore (STEP 7 mette OK a 0, qui
 * no). Le conversioni verso un tipo più largo azzerano i bit che la parola bassa non ha.
 */
const CONV: Record<string, [Num, Num, string[]]> = {
  INT_TO_DINT: ['INT', 'DINT', ['ITD']],
  INT_TO_REAL: ['INT', 'REAL', ['ITD', 'DTR']],
  DINT_TO_REAL: ['DINT', 'REAL', ['DTR']],
  ROUND: ['REAL', 'DINT', ['RND']],
  TRUNC: ['REAL', 'DINT', ['TRUNC']],
  DINT_TO_INT: ['DINT', 'INT', []],
  INT_TO_WORD: ['INT', 'WORD', []],
  WORD_TO_INT: ['WORD', 'INT', []],
  DINT_TO_DWORD: ['DINT', 'DWORD', []],
  DWORD_TO_REAL: ['DWORD', 'REAL', []],
  REAL_TO_DWORD: ['REAL', 'DWORD', []],
  DWORD_TO_DINT: ['DWORD', 'DINT', []],
  DWORD_TO_WORD: ['DWORD', 'WORD', []],
  WORD_TO_BYTE: ['WORD', 'BYTE', ['AW W#16#FF']],
  BYTE_TO_WORD: ['BYTE', 'WORD', []],
  WORD_TO_DWORD: ['WORD', 'DWORD', ['AD DW#16#FFFF']],
  BYTE_TO_DWORD: ['BYTE', 'DWORD', ['AD DW#16#FF']],
};
const HINT: Partial<Record<string, string>> = {
  'DINT→REAL': 'DINT_TO_REAL (valore) o DWORD_TO_REAL (bit)',
  'REAL→DINT': 'ROUND o TRUNC',
  'REAL→INT': 'DINT_TO_INT(ROUND(…)) o DINT_TO_INT(TRUNC(…))',
};

const fail = (at: Pos, message: string): never => {
  throw new SclError(at.line, at.col, message);
};

function mismatch(at: Pos, want: Ty, got: Ty): never {
  const conv = `${got}_TO_${want}`;
  const fn = HINT[`${got}→${want}`] ?? (conv in CONV ? conv : undefined);
  const tail = fn
    ? `: usa ${fn}`
    : want !== 'BOOL' && got !== 'BOOL'
      ? ` (${conv} non è supportata in prova)`
      : '';
  return fail(at, `Tipi diversi: serve ${want}, c'è ${got}${tail}`);
}

const typed = (t: DataType | null | undefined) =>
  t?.kind === 'elementary' ? ELEMENTARY[t.name] : undefined;
const unquote = (s: string) => s.replace(/^"|"$/g, '');
const isLiteral = (e: Expr) => e.k === 'int' || e.k === 'real';
/** Operando che si carica con un solo `L` (variabile, TEMP di appoggio o letterale). */
const isSimple = (e: Expr) =>
  isLiteral(e) ||
  e.k === 'local' ||
  e.k === 'id' ||
  e.k === 'symbol' ||
  e.k === 'addr' ||
  e.k === 'temp';
const isOperand = (e: Expr): e is Operand => isSimple(e) && !isLiteral(e);

/** Un ciclo aperto: le etichette di EXIT e CONTINUE nascono solo se servono. */
type Loop = { at: Pos; exit?: string; cont?: string };

class Gen {
  readonly out: { text: string; sclLine: number }[] = [];
  private sclLine = 1;
  private labelNo = 1;
  private tempTop: number;
  private depth = 0;
  private readonly loops: Loop[] = [];

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

  /** Le TEMP allocate da `use` tornano libere alla fine. */
  private scoped<T>(use: () => T): T {
    const at = this.tempTop;
    try {
      return use();
    } finally {
      this.tempTop = at;
    }
  }

  /** Una TEMP di appoggio (un byte intero per un BOOL), libera alla fine dello `scoped` attorno. */
  private temp(ty: Ty): string {
    const at = this.tempTop;
    if (ty === 'BOOL') {
      this.tempTop += 1;
      return `L ${at}.0`;
    }
    if (ty === 'BYTE') {
      this.tempTop += 1;
      return `LB ${at}`;
    }
    // parole e doppie parole stanno su indirizzi pari
    const even = at + (at % 2);
    this.tempTop = even + SIZE[ty];
    return `${SIZE[ty] === 2 ? 'LW' : 'LD'} ${even}`;
  }

  private withTemp<T>(ty: Num, use: (addr: string) => T): T {
    return this.scoped(() => use(this.temp(ty)));
  }

  // ---- operandi e tipi ----

  /** `hint` sceglie il tipo di un indirizzo che ne ammette più d'uno (MW: INT o WORD). */
  private resolve(o: Operand, hint?: Ty, dest = false): { awl: string; ty: Ty; constant: boolean } {
    if (o.k === 'temp') return { awl: o.text, ty: o.ty as Ty, constant: false };
    if (o.k === 'addr') {
      const a = parseAddress(o.text);
      const ty: Ty =
        a.size === 'X'
          ? 'BOOL'
          : a.size === 'B'
            ? 'BYTE'
            : a.size === 'W'
              ? hint === 'WORD'
                ? 'WORD'
                : 'INT'
              : hint === 'DWORD' || (dest && hint === 'REAL')
                ? hint
                : 'DINT';
      return { awl: a.awl, ty, constant: false };
    }
    const shown = o.k === 'local' ? o.text.slice(1) : o.text;
    const elem = (t: DataType | null, awl: string, constant: boolean) => {
      const ty = typed(t);
      if (!ty) fail(o, `Tipo di ${shown}${tail(o)} non supportato in SCL in prova (${SUPPORTED})`);
      return { awl, ty: ty!, constant };
    };
    if (o.k === 'symbol') {
      const name = unquote(o.text);
      const s = this.ctx.symbol(name);
      if (s)
        return elem(this.walk(o, s.type, o.index, o.path), o.text + tail(o), s.kind === 'constant');
      const db = this.ctx.block({ name });
      const members = db ? this.dbMembers(db) : undefined;
      if (!members) fail(o, `Operando sconosciuto: ${o.text}`);
      const [first, ...rest] = o.path ?? [];
      if (!first || o.index) fail(o, `Di un DB si usa un membro: ${o.text}.nome`);
      const m = this.member(o, members!, first!);
      return elem(this.walk(o, m.type, first!.index, rest), o.text + tail(o), false);
    }
    const name = o.k === 'local' ? o.text.slice(1) : o.text;
    const own = this.ctx.owner;
    const i = own.iface;
    const formal = [...i.input, ...i.output, ...i.inOut].find((x) => sameName(x.name, name));
    const m =
      formal ??
      [...i.static, ...i.temp].find((x) => sameName(x.name, name)) ??
      (own.kind === 'FC' &&
      i.returnType?.kind !== 'void' &&
      (sameName(name, 'RET_VAL') || (own.name !== undefined && sameName(name, own.name)))
        ? { name: 'RET_VAL', type: i.returnType }
        : undefined);
    if (!m || !m.type) fail(o, `Operando sconosciuto: ${name}`);
    const deep = o.index || o.path;
    if (deep && formal && (own.kind === 'FC' || i.inOut.includes(formal)))
      fail(
        o,
        `Membri ed elementi di un parametro ${own.kind === 'FC' ? 'di FC' : 'IN_OUT'} (#${m!.name}) non sono supportati in prova: il parametro è un puntatore`,
      );
    return elem(this.walk(o, m!.type, o.index, o.path), `#${m!.name}${tail(o)}`, false);
  }

  /** I membri di un DB globale o di istanza (le sezioni dell'FB, senza TEMP). */
  private dbMembers(db: NonNullable<ReturnType<AwlContext['block']>>): TypedMember[] | undefined {
    if (db.kind === 'DB') return db.dbMembers;
    if (db.kind !== 'IDB' || !db.instanceOf) return undefined;
    const fb = this.ctx.block({ name: db.instanceOf })?.iface;
    return fb && [...fb.input, ...fb.output, ...fb.inOut, ...fb.static];
  }

  private member(o: Operand, list: TypedMember[], seg: Seg): TypedMember {
    const m = list.find((x) => sameName(x.name, unquote(seg.name)));
    return m ?? fail(o, `Membro sconosciuto: ${seg.name}`);
  }

  /** Il tipo dopo gli indici e i membri, con gli indici nei limiti dell'ARRAY. */
  private walk(
    o: Operand,
    t: DataType | null,
    index: number[] | undefined,
    path: Seg[] | undefined,
  ): DataType | null {
    const at = (t: DataType | null, index: number[] | undefined): DataType | null => {
      if (!index || !t) return t;
      if (t.kind !== 'array') return fail(o, `${o.text} non è un ARRAY: niente indici [ ]`);
      if (t.dims.length !== index.length)
        fail(o, `L'ARRAY ha ${t.dims.length} dimensioni, gli indici sono ${index.length}`);
      t.dims.forEach((d, j) => {
        if (index[j]! < d.lo || index[j]! > d.hi)
          fail(o, `Indice ${index[j]} fuori da [${d.lo}..${d.hi}]`);
      });
      return t.element;
    };
    let cur = at(t, index);
    for (const seg of path ?? []) {
      let members: TypedMember[] | undefined;
      if (cur?.kind === 'struct') members = cur.members;
      else if (cur?.kind === 'named') {
        const r = this.ctx.resolve(cur.name);
        const s = r?.kind === 'fb' ? r.sections : undefined;
        members =
          r?.kind === 'udt' ? r.members : s && [...s.input, ...s.output, ...s.inOut, ...s.static];
      }
      if (!members) return fail(o, `${seg.name}: ${o.text} non ha membri`);
      const m = this.member(o, members, seg);
      cur = at(m.type, seg.index);
    }
    return cur;
  }

  /** Tipo di un'espressione; un letterale o un indirizzo prende `hint` se ci sta. */
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
      case 'temp':
        return this.resolve(e, hint).ty;
      case 'fcall': {
        const c = this.callee(e);
        return c.ret ?? fail(e, `${c.shown} non restituisce un valore`);
      }
      case 'not': {
        let t = this.typeOf(e.e, hint);
        // NOT MW0, NOT MD4: l'indirizzo è una WORD o una DWORD
        if (t === 'INT' || t === 'DINT') {
          const bits = t === 'INT' ? 'WORD' : 'DWORD';
          if (this.typeOf(e.e, bits) === bits) t = bits;
        }
        if (t !== 'BOOL' && !isBits(t))
          fail(e, `NOT si usa con BOOL, BYTE, WORD o DWORD, c'è ${t}`);
        return t;
      }
      case 'neg': {
        const t = this.typeOf(e.e, hint);
        if (t === 'BOOL' || isBits(t)) fail(e, 'Il meno si usa solo con INT, DINT e REAL');
        return t;
      }
      case 'call': {
        const c = CONV[e.name];
        if (!c) fail(e, `Funzione non supportata in SCL in prova: ${e.name}`);
        this.want(e.arg, c![0]);
        return c![1];
      }
      case 'bin': {
        const cmp = e.op in CMP;
        const t = this.pair(e, cmp ? undefined : hint);
        if (e.op in BOOL_OP) {
          if (t !== 'BOOL' && !isBits(t))
            fail(e, `${e.op} si usa con BOOL, BYTE, WORD o DWORD, c'è ${t}: usa ${t}_TO_…`);
          return t;
        }
        if (t === 'BOOL') fail(e, `L'operatore ${e.op} non si usa con BOOL: usa AND, OR, XOR, NOT`);
        if (isBits(t) && !(e.op === '=' || e.op === '<>'))
          fail(e, `Con ${t} si usano solo = e <> e AND, OR, XOR, NOT`);
        if (e.op === 'MOD' && t !== 'DINT')
          fail(
            e,
            t === 'INT' ? 'MOD in prova solo su DINT: usa INT_TO_DINT' : 'MOD non si usa con REAL',
          );
        return cmp ? 'BOOL' : t;
      }
    }
  }

  /** Tipo comune dei due lati: il letterale (o l'indirizzo) prende il tipo dell'altro lato. */
  private pair(e: Extract<Expr, { k: 'bin' }>, hint?: Ty): Ty {
    const [first, second] = isLiteral(e.l) && !isLiteral(e.r) ? [e.r, e.l] : [e.l, e.r];
    const t = this.typeOf(first, hint);
    const u = this.typeOf(second, t);
    if (t === u) return t;
    // due letterali, un letterale che non ci sta o un indirizzo: il tipo dell'altro, se ci sta
    if (this.typeOf(first, u) === u) return u;
    return mismatch(second, t, u);
  }

  private want(e: Expr, ty: Ty): void {
    const t = this.typeOf(e, ty);
    if (t !== ty) mismatch(e, ty, t);
  }

  /**
   * Letterale nel tipo scritto (`INT#5`, `W#16#FF`), altrimenti nel tipo `hint` se ci sta,
   * altrimenti nel suo tipo naturale (INT o DINT); testo per `L`.
   */
  private literal(e: Expr & { text: string }, hint?: Ty): { ty: Num; awl: string } {
    if (e.k === 'real') {
      const v = Number(e.text);
      if (!Number.isFinite(Math.fround(v))) fail(e, `Costante REAL fuori intervallo: ${e.text}`);
      return { ty: 'REAL', awl: e.text.includes('.') ? e.text : e.text.replace(/[eE]/, '.0e') };
    }
    const { value: v, type } = intLiteral(e.text);
    const fits = (t: Ty) => RANGE[t] !== undefined && v >= RANGE[t][0] && v <= RANGE[t][1];
    const ty = (type ??
      (hint === 'REAL' ? 'REAL' : hint && fits(hint) ? hint : fits('INT') ? 'INT' : 'DINT')) as Num;
    if (ty !== 'REAL' && !fits(ty)) fail(e, `Costante fuori intervallo ${ty}: ${e.text}`);
    const awl =
      ty === 'REAL'
        ? `${v}.0`
        : ty === 'INT'
          ? String(v)
          : ty === 'DINT'
            ? `L#${v}`
            : `${HEX[ty]}${v.toString(16).toUpperCase()}`;
    return { ty, awl };
  }

  // ---- espressioni numeriche e stringhe di bit: risultato in ACCU1 ----

  private load(e: Expr, ty: Ty): string {
    return isLiteral(e)
      ? this.literal(e as Expr & { text: string }, ty).awl
      : this.resolve(e as Operand, ty).awl;
  }

  num(e: Expr, ty: Num): void {
    if (isSimple(e)) return this.emit(`L ${this.load(e, ty)}`);
    if (e.k === 'neg') {
      this.num(e.e, ty);
      return this.emit(`NEG${SUFFIX[ty]}`);
    }
    if (e.k === 'not' && isBits(ty)) {
      this.num(e.e, ty);
      return this.emit(INVERT[ty]);
    }
    if (e.k === 'call') {
      const [from, , code] = CONV[e.name]!;
      this.num(e.arg, from);
      return this.emit(...code);
    }
    if (e.k !== 'bin') return fail(e, 'Espressione numerica non valida');
    this.operands(e, ty);
    if (e.op in WORD_OP) return this.emit(`${WORD_OP[e.op]}${ty === 'DWORD' ? 'D' : 'W'}`);
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

  /** L'RLO di una condizione; le chiamate di FC dentro si fanno prima (`hoist`). */
  private boolExpr(e: Expr, at: Pos): void {
    this.want(e, 'BOOL');
    this.scoped(() => this.cond(this.hoist(e), at));
  }

  // ---- chiamate di blocchi ----

  /** Il blocco chiamato: l'istanza come nella CALL AWL, l'interfaccia e il tipo di ritorno. */
  private callee(c: Call): {
    instance: string;
    shown: string;
    iface: AwlInterface;
    fc: boolean;
    ret?: Ty;
  } {
    const o = c.callee;
    if (o.k === 'temp' || o.k === 'addr' || o.index || o.path)
      return fail(o, `Si chiama un blocco per nome: "Fc"(…), "DB_di_istanza"(…) o #multi(…)`);
    const shown = o.text;
    const done = (info: ReturnType<AwlContext['block']>, instance: string, fc: boolean) => {
      const iface = info?.iface;
      if (!iface) return fail(o, `Interfaccia di ${shown} non nota`);
      const r = iface.returnType;
      const ret = fc && r && r.kind !== 'void' ? typed(r) : undefined;
      if (fc && r && r.kind !== 'void' && !ret)
        fail(o, `Il valore di ritorno di ${shown} è ${formatType(r)}: non supportato in prova`);
      return { instance, shown, iface, fc, ...(ret ? { ret } : {}) };
    };
    if (o.k === 'local') {
      const own = this.ctx.owner;
      const m =
        own.kind === 'FB'
          ? own.iface.static.find((x) => sameName(x.name, o.text.slice(1)))
          : undefined;
      const fb = m?.type.kind === 'named' ? this.ctx.block({ name: m.type.name }) : undefined;
      if (!fb || (fb.kind !== 'FB' && fb.kind !== 'SFB'))
        fail(o, `${shown} non è una multi-istanza di FB nei dati statici`);
      return done(fb, `#${m!.name}`, false);
    }
    const info = this.ctx.block({ name: unquote(o.text) });
    if (!info) return fail(o, `Blocco sconosciuto: ${shown}`);
    if (info.kind === 'FC' || info.kind === 'SFC')
      return done(info, `${info.kind} ${info.number}`, true);
    if (info.kind === 'IDB') {
      const fb = info.instanceOf ? this.ctx.block({ name: info.instanceOf }) : undefined;
      if (!fb) return fail(o, `FB di ${shown} sconosciuto`);
      return done(fb, `${fb.kind} ${fb.number}, DB ${info.number}`, false);
    }
    if (info.kind === 'FB' || info.kind === 'SFB')
      return fail(o, `Un FB si chiama col suo DB di istanza: "DB_di_istanza"(…)`);
    return fail(o, `${shown} non è un blocco da chiamare`);
  }

  /**
   * CALL con i parametri per nome nell'ordine dell'interfaccia (IN, RET_VAL, OUT, IN_OUT), come
   * il box CALL del KOP. Un ingresso che non è un operando semplice si calcola prima in una TEMP;
   * uscite e ingressi/uscite vogliono una variabile dello stesso tipo. Una FC vuole tutti i
   * parametri; il valore di ritorno va in `ret` (o in una TEMP se non serve).
   */
  private emitCall(c: Call, ret?: string): void {
    const k = this.callee(c);
    const i = k.iface;
    const formals = [
      ...i.input.map((m) => ({ m, dir: 'in' as const })),
      ...i.output.map((m) => ({ m, dir: 'out' as const })),
      ...i.inOut.map((m) => ({ m, dir: 'inout' as const })),
    ];
    const given = new Map<TypedMember, Call['args'][number]>();
    for (const a of c.args) {
      const f = formals.find((x) => sameName(x.m.name, a.name));
      if (!f) fail(a, `${k.shown} non ha il parametro ${a.name}`);
      if (given.has(f!.m)) fail(a, `Parametro ${a.name} ripetuto`);
      if (f!.dir === 'out' && !a.out)
        fail(a, `${f!.m.name} è un'uscita: si scrive ${f!.m.name} => variabile`);
      if (f!.dir !== 'out' && a.out)
        fail(a, `${f!.m.name} non è un'uscita: si scrive ${f!.m.name} := …`);
      given.set(f!.m, a);
    }
    const params: string[] = [];
    const retParam = () => {
      if (k.ret) params.push(`RET_VAL := ${ret ?? this.temp(k.ret)}`);
    };
    for (const [n, { m, dir }] of formals.entries()) {
      if (dir !== 'in' && (n === 0 || formals[n - 1]!.dir === 'in')) retParam();
      const a = given.get(m);
      if (!a) {
        if (k.fc) fail(c, `Manca il parametro ${m.name} nella chiamata di ${k.shown}`);
        continue;
      }
      const ty = typed(m.type);
      if (!ty)
        fail(
          a,
          `Parametro ${m.name} di tipo ${formatType(m.type)}: non supportato in prova (${SUPPORTED})`,
        );
      params.push(
        `${m.name} := ${dir === 'in' ? this.actual(a.e, ty!) : this.variable(a.e, ty!, m.name)}`,
      );
    }
    if (formals.every((f) => f.dir === 'in')) retParam();
    this.emit(...callLines(k.instance, params));
  }

  /** Il parametro attuale di un ingresso: operando, letterale o TEMP già calcolata. */
  private actual(e0: Expr, ty: Ty): string {
    this.want(e0, ty);
    const e = this.hoist(e0);
    if (e.k === 'bool') return e.value ? 'TRUE' : 'FALSE';
    if (isSimple(e)) return this.load(e, ty);
    const t = this.temp(ty);
    if (ty === 'BOOL') this.cond(e, e);
    else this.num(e, ty as Num);
    this.emit(`${ty === 'BOOL' ? '=' : 'T'} ${t}`);
    return t;
  }

  /** Il parametro attuale di un'uscita o di un ingresso/uscita: una variabile del tipo giusto. */
  private variable(e: Expr, ty: Ty, formal: string): string {
    if (!isOperand(e) || e.k === 'temp') return fail(e, `Per ${formal} serve una variabile`);
    const r = this.resolve(e, ty, true);
    if (r.constant) fail(e, `Non si può scrivere in una costante: ${e.text}`);
    if (r.ty !== ty) mismatch(e, ty, r.ty);
    return r.awl;
  }

  /**
   * Le chiamate di FC dentro un'espressione si fanno prima, da sinistra a destra, ognuna col
   * valore in una TEMP che prende il suo posto (la CALL distrugge accumulatori e RLO).
   */
  private hoist(e: Expr): Expr {
    switch (e.k) {
      case 'fcall': {
        const ty = this.typeOf(e);
        const text = this.temp(ty);
        this.emitCall(e, text);
        return { k: 'temp', text, ty, line: e.line, col: e.col };
      }
      case 'neg':
      case 'not':
        return { ...e, e: this.hoist(e.e) };
      case 'bin':
        return { ...e, l: this.hoist(e.l), r: this.hoist(e.r) };
      case 'call':
        return { ...e, arg: this.hoist(e.arg) };
      default:
        return e;
    }
  }

  // ---- istruzioni ----

  stmts(list: Stmt[]): void {
    for (const s of list) this.stmt(s);
  }

  /** Il ciclo più interno, per EXIT e CONTINUE. */
  private loop(s: Pos, what: string): Loop {
    return this.loops.at(-1) ?? fail(s, `${what} si usa solo dentro FOR, WHILE o REPEAT`);
  }

  /** Corpo di un ciclo; dopo, le etichette che EXIT e CONTINUE hanno chiesto. */
  private loopBody(l: Loop, body: Stmt[]): void {
    this.loops.push(l);
    try {
      this.stmts(body);
    } finally {
      this.loops.pop();
    }
  }

  private stmt(s: Stmt): void {
    this.sclLine = s.line;
    switch (s.k) {
      case 'assign': {
        // un indirizzo prende il tipo dell'espressione se ci sta (MW10 := una WORD)
        const dst = this.resolve(s.dst, s.dst.k === 'addr' ? this.typeOf(s.e) : undefined, true);
        if (dst.constant) fail(s.dst, `Non si può scrivere in una costante: ${s.dst.text}`);
        this.want(s.e, dst.ty);
        return this.scoped(() => {
          const e = this.hoist(s.e);
          if (dst.ty === 'BOOL') {
            this.cond(e, s);
            return this.emit(`= ${dst.awl}`);
          }
          this.num(e, dst.ty as Num);
          return this.emit(`T ${dst.awl}`);
        });
      }
      case 'call':
        return this.scoped(() => this.emitCall(s.c));
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
        this.loopBody({ at: s, exit: end, cont: top }, s.body);
        this.sclLine = s.line;
        this.emit(`JU ${top}`);
        return this.place(end);
      }
      case 'repeat': {
        const top = this.label(s);
        const l: Loop = { at: s };
        this.place(top);
        this.loopBody(l, s.body);
        this.sclLine = s.cond.line;
        if (l.cont) this.place(l.cont);
        this.boolExpr(s.cond, s.cond);
        this.emit(`JCN ${top}`);
        if (l.exit) this.place(l.exit);
        return;
      }
      case 'exit': {
        const l = this.loop(s, 'EXIT');
        return this.emit(`JU ${(l.exit ??= this.label(l.at))}`);
      }
      case 'continue': {
        const l = this.loop(s, 'CONTINUE');
        return this.emit(`JU ${(l.cont ??= this.label(l.at))}`);
      }
      case 'return':
        return this.emit('BEU');
    }
  }

  /**
   * Selettore letto una volta sola (TEMP se è un'espressione); `==` e `JC` per ogni valore, `>=`
   * e `<=` in AND per un intervallo `a..b`.
   */
  private caseStmt(s: Extract<Stmt, { k: 'case' }>): void {
    const ty = this.typeOf(s.sel);
    if (ty !== 'INT' && ty !== 'DINT')
      fail(s.sel, `Il selettore del CASE dev'essere INT o DINT, c'è ${ty}`);
    const n = ty as 'INT' | 'DINT';
    const seen: [bigint, bigint][] = [];
    const value = (text: string, at: Pos) => {
      const lit = this.literal({ k: 'int', text, line: at.line, col: at.col }, n);
      if (lit.ty !== n) fail(at, `Valore ${text} fuori intervallo ${n}`);
      return { awl: lit.awl, v: intLiteral(text).value };
    };
    const run = (sel: string) => {
      const end = this.label(s);
      const targets = s.arms.map((arm) => {
        const lab = this.label(s);
        for (const v of arm.values) {
          const lo = value(v.text, v);
          const hi = v.hi === undefined ? lo : value(v.hi, v);
          const shown = v.hi === undefined ? v.text : `${v.text}..${v.hi}`;
          if (lo.v > hi.v) fail(v, `Intervallo vuoto nel CASE: ${shown}`);
          if (seen.some(([a, b]) => lo.v <= b && hi.v >= a))
            fail(v, `Valore ${shown} ripetuto nel CASE`);
          seen.push([lo.v, hi.v]);
          const t = SUFFIX[n];
          if (v.hi === undefined) this.emit(`L ${sel}`, `L ${lo.awl}`, `==${t}`, `JC ${lab}`);
          else
            this.emit(
              `L ${sel}`,
              `L ${lo.awl}`,
              `>=${t}`,
              'A(',
              `L ${sel}`,
              `L ${hi.awl}`,
              `<=${t}`,
              ')',
              `JC ${lab}`,
            );
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
    this.scoped(() => {
      const sel = this.hoist(s.sel);
      if (isSimple(sel)) return run(this.load(sel, n));
      this.num(sel, n);
      this.withTemp(n, (tmp) => {
        this.emit(`T ${tmp}`);
        run(tmp);
      });
    });
  }

  /**
   * FOR su INT o DINT: il valore finale si calcola una volta sola (in una TEMP); l'uscita è `>` con
   * BY positivo e `<` con BY negativo. L'incremento che va oltre i limiti del tipo (OV) esce dal
   * ciclo senza scrivere la variabile, così `TO 32767` non gira all'infinito: dopo il ciclo la
   * variabile vale l'ultimo valore eseguito. CONTINUE salta all'incremento.
   */
  private forStmt(s: Extract<Stmt, { k: 'for' }>): void {
    const v = this.resolve(s.v);
    if (v.ty !== 'INT' && v.ty !== 'DINT')
      fail(s.v, `La variabile del FOR dev'essere INT o DINT, c'è ${v.ty}`);
    if (v.constant) fail(s.v, `Non si può scrivere in una costante: ${s.v.text}`);
    const ty = v.ty as 'INT' | 'DINT';
    const step = intLiteral(s.by?.text ?? '1').value;
    if (step === 0n) fail(s.by!, 'BY 0 non termina mai');
    const at = s.by ?? s;
    const by = this.literal({ k: 'int', text: String(step), line: at.line, col: at.col }, ty);
    if (by.ty !== ty) fail(s.by!, `BY ${step} fuori intervallo ${ty}`);
    this.want(s.from, ty);
    this.want(s.to, ty);
    const t = SUFFIX[ty];
    this.scoped(() => this.num(this.hoist(s.from), ty));
    this.emit(`T ${v.awl}`);
    const loop = (end: string) => {
      const [top, exit] = [this.label(s), this.label(s)];
      const l: Loop = { at: s, exit };
      this.place(top);
      this.emit(`L ${v.awl}`, `L ${end}`, `${step > 0n ? '>' : '<'}${t}`, `JC ${exit}`);
      this.loopBody(l, s.body);
      this.sclLine = s.line;
      if (l.cont) this.place(l.cont);
      this.emit(`L ${v.awl}`, `L ${by.awl}`, `+${t}`, `JO ${exit}`, `T ${v.awl}`, `JU ${top}`);
      this.place(exit);
    };
    if (isLiteral(s.to)) return loop(this.load(s.to, ty));
    this.scoped(() => {
      this.num(this.hoist(s.to), ty);
      this.withTemp(ty, (tmp) => {
        this.emit(`T ${tmp}`);
        loop(tmp);
      });
    });
  }
}

/** Indici e membri come in AWL: `[3]`, `[1,2]`, `.x`, `."con spazi"`. */
const tail = (o: Operand): string => {
  if (o.k === 'temp') return '';
  const idx = (i?: number[]) => (i ? `[${i.join(',')}]` : '');
  return idx(o.index) + (o.path ?? []).map((p) => `.${p.name}${idx(p.index)}`).join('');
};

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
