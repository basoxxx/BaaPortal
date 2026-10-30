// Traduzione SCL → AWL (mnemonici internazionali) del sottoinsieme in prova, piano rc-1.0 task 4
// e versione 1.1. Numeri e stringhe di bit in ACCU1 (S7-300: `L` sposta ACCU1 in ACCU2; `-I` e
// `/I` fanno ACCU2 op ACCU1), logica nell'RLO con al massimo 7 parentesi aperte, TEMP di appoggio
// dopo `tempEnd` allocate a pila, etichette `_001`… su `NOP 0`. Nessun AWL se c'è anche un solo
// errore.
import {
  formatNetwork,
  type AwlContext,
  type AwlInterface,
  type Operand as AwlOperand,
  type PathSegment,
} from '@baaportal/awl';
import { callLines } from '@baaportal/ladfbd';
import { NO_RANGE, ownOperandResolver, type ResolvedOperand } from '@baaportal/mc7';
import {
  formatType,
  layoutStruct,
  sameName,
  type DataType,
  type TypedMember,
} from '@baaportal/s7-types';
import { intLiteral, parseAddress, SclError, timeLiteral } from './lexer.js';
import {
  MAX_ERRORS,
  parse,
  type Call,
  type Expr,
  type Operand,
  type Pos,
  type Seg,
  type Stmt,
} from './parser.js';

export type SclDiag = { line: number; col: number; message: string }; // line 1-based
/** Formati dei valori osservati (`SclLine.value`): TIME e TOD come DINT (ms), DATE come INT (giorni
 * dal 1990), S5TIME come WORD, CHAR come BYTE. */
export type SclType = 'BOOL' | 'BYTE' | 'WORD' | 'DWORD' | 'INT' | 'DINT' | 'REAL';
/**
 * Riga 0-based dell'AWL generato → riga 1-based del testo SCL. `value`: lo stato dopo questa
 * istruzione dà il valore della riga SCL nel tipo detto (RLO per BOOL, ACCU1 altrimenti): il valore
 * scritto da un'assegnazione (`T`/`=`), il risultato di una condizione (l'istruzione prima del salto,
 * che rimette RLO a 1), il selettore di CASE, la variabile di FOR al controllo in cima al ciclo.
 */
export type SclLine = { line: number; sclLine: number; value?: SclType };
export type SclAwl = {
  source: string;
  lines: SclLine[];
  diagnostics: SclDiag[];
};

/** Tipi elementari del sottoinsieme SCL in prova (TOD è TIME_OF_DAY). */
type Ty = SclType | 'TIME' | 'S5TIME' | 'DATE' | 'TOD' | 'CHAR';
const SHOWN: Partial<Record<Ty, SclType>> = {
  TIME: 'DINT',
  TOD: 'DINT',
  DATE: 'INT',
  S5TIME: 'WORD',
  CHAR: 'BYTE',
};
type Num = Exclude<Ty, 'BOOL'>;
type Bits = 'BYTE' | 'WORD' | 'DWORD';
type Conn = 'A' | 'O' | 'X';
type Dim = { lo: number; hi: number };

const MAX_BRACKETS = 7;
const MAX_LABEL = 999;
const SUPPORTED =
  'solo BOOL, BYTE, WORD, DWORD, INT, DINT, REAL, TIME, S5TIME, DATE, TIME_OF_DAY, CHAR; STRING, STRUCT, ARRAY e UDT interi solo in :=';
/** Copia di STRUCT, ARRAY e UDT interi a istruzioni L/T: oltre, il codice diventa troppo lungo. */
const MAX_COPY = 1024;
const ELEMENTARY: Record<string, Ty> = {
  Bool: 'BOOL',
  Byte: 'BYTE',
  Word: 'WORD',
  DWord: 'DWORD',
  Int: 'INT',
  DInt: 'DINT',
  Real: 'REAL',
  Time: 'TIME',
  S5Time: 'S5TIME',
  Date: 'DATE',
  Time_Of_Day: 'TOD',
  Char: 'CHAR',
};
const isBits = (t: Ty): t is Bits => t === 'BYTE' || t === 'WORD' || t === 'DWORD';
/** DATE si confronta a 32 bit: `L` di una parola azzera la parola alta, così vale senza segno. */
const SUFFIX: Record<Num, string> = {
  BYTE: 'I',
  WORD: 'I',
  DWORD: 'D',
  INT: 'I',
  DINT: 'D',
  REAL: 'R',
  TIME: 'D',
  S5TIME: 'I',
  DATE: 'D',
  TOD: 'D',
  CHAR: 'I',
};
const SIZE: Record<Num, number> = {
  BYTE: 1,
  WORD: 2,
  DWORD: 4,
  INT: 2,
  DINT: 4,
  REAL: 4,
  TIME: 4,
  S5TIME: 2,
  DATE: 2,
  TOD: 4,
  CHAR: 1,
};
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
  TIME_TO_DINT: ['TIME', 'DINT', []],
  DINT_TO_TIME: ['DINT', 'TIME', []],
  CHAR_TO_INT: ['CHAR', 'INT', []],
  CHAR_TO_BYTE: ['CHAR', 'BYTE', []],
  BYTE_TO_CHAR: ['BYTE', 'CHAR', []],
  INT_TO_CHAR: ['INT', 'CHAR', ['AW W#16#FF']],
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
/**
 * Conversioni che come in STEP 7 mettono a 0 il bit OK (qui BR, quindi l'ENO del blocco) se il
 * valore non ci sta: istruzioni dopo `T` nella TEMP del risultato, che tiene comunque i bit bassi.
 */
const CHECKED: Record<string, (bad: string, ok: string) => string[]> = {
  DINT_TO_INT: (bad, ok) => [
    'L L#32767',
    '>D',
    `JC ${bad}`,
    'TAK',
    'L L#-32768',
    '<D',
    `JCN ${ok}`,
  ],
  ROUND: (bad, ok) => [`JO ${bad}`, `JU ${ok}`],
  TRUNC: (bad, ok) => [`JO ${bad}`, `JU ${ok}`],
};
const HINT: Partial<Record<string, string>> = {
  'DINT→REAL': 'DINT_TO_REAL (valore) o DWORD_TO_REAL (bit)',
  'REAL→DINT': 'ROUND o TRUNC',
  'REAL→INT': 'DINT_TO_INT(ROUND(…)) o DINT_TO_INT(TRUNC(…))',
  'INT→TIME': 'DINT_TO_TIME(INT_TO_DINT(…))',
  'TIME→INT': 'DINT_TO_INT(TIME_TO_DINT(…))',
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
const isLiteral = (e: Expr) =>
  e.k === 'int' || e.k === 'real' || e.k === 'tlit' || (e.k === 'str' && e.text.length === 1);
/** Operando che si carica con un solo `L` (variabile, TEMP di appoggio o letterale). */
const isSimple = (e: Expr) =>
  isLiteral(e) ||
  e.k === 'local' ||
  e.k === 'id' ||
  e.k === 'symbol' ||
  e.k === 'addr' ||
  e.k === 'temp';
const isOperand = (e: Expr): e is Operand => isSimple(e) && !isLiteral(e);
/** Un elemento di ARRAY con indici variabili: si legge e si scrive passando da AR1. */
type Indexed = Exclude<Operand, { k: 'temp' }> & { vindex: Expr[] };
const isIndexed = (e: Expr): e is Indexed => isOperand(e) && e.k !== 'temp' && !!e.vindex;

/** Posizione di una variabile come la risolve il compilatore; `at` per gli errori. */
type Loc = { area: string; bit: number; db?: number; at: Pos };
type Located = Exclude<Operand, { k: 'temp' | 'addr' }>;
const WIDTH: Record<number, 'B' | 'W' | 'D'> = { 1: 'B', 2: 'W', 4: 'D' };

/** Un ciclo aperto: le etichette di EXIT e CONTINUE nascono solo se servono. */
type Loop = { at: Pos; exit?: string; cont?: string };

class Gen {
  readonly out: { text: string; sclLine: number; value?: Ty }[] = [];
  readonly errors: SclError[] = [];
  private sclLine = 1;
  private labelNo = 1;
  private tempTop: number;
  private depth = 0;
  private readonly loops: Loop[] = [];
  private resolver?: ReturnType<typeof ownOperandResolver>;

  constructor(
    private readonly ctx: AwlContext,
    tempEnd: number,
  ) {
    this.tempTop = tempEnd;
  }

  private emit(...texts: string[]): void {
    for (const text of texts) this.out.push({ text, sclLine: this.sclLine });
  }

  /** L'istruzione `at` (di solito l'ultima scritta) porta il valore della riga (`SclLine.value`). */
  private mark(ty: Ty, at = this.out.length - 1): void {
    this.out[at]!.value = ty;
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
    if (SIZE[ty] === 1) {
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
  private resolve(
    o: Operand,
    hint?: Ty,
    dest = false,
  ): { awl: string; ty: Ty; constant: boolean; dims?: Dim[] } {
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
    const d = this.declared(o, dest);
    let t = d.type;
    // indici variabili: tipo e limiti dell'elemento (l'indirizzo lo fa `address`)
    let dims: Dim[] | undefined;
    if (o.vindex) {
      if (t?.kind !== 'array')
        return fail(o, `${o.text}${tail(o)} non è un ARRAY: niente indici [ ]`);
      if (t.dims.length !== o.vindex.length)
        fail(o, `L'ARRAY ha ${t.dims.length} dimensioni, gli indici sono ${o.vindex.length}`);
      dims = t.dims;
      t = t.element;
    }
    const ty = typed(t);
    if (!ty) fail(o, `Tipo di ${shown}${tail(o)} non supportato in SCL in prova (${SUPPORTED})`);
    return { awl: d.awl, ty: ty!, constant: d.constant, ...(dims ? { dims } : {}) };
  }

  /**
   * Tipo dichiarato di una variabile, dopo indici costanti e membri, e la sua forma AWL. `dest`:
   * la variabile si scrive (un ingresso di FC no).
   */
  private declared(
    o: Exclude<Operand, { k: 'temp' | 'addr' }>,
    dest = false,
  ): { type: DataType | null; awl: string; constant: boolean; formal?: TypedMember } {
    if (o.k === 'symbol') {
      const name = unquote(o.text);
      const s = this.ctx.symbol(name);
      if (s)
        return {
          type: this.walk(o, s.type, o.index, o.path),
          awl: o.text + tail(o),
          constant: s.kind === 'constant',
        };
      const db = this.ctx.block({ name });
      const members = db ? this.dbMembers(db) : undefined;
      if (!members) fail(o, `Operando sconosciuto: ${o.text}`);
      const [first, ...rest] = o.path ?? [];
      if (!first || o.index) fail(o, `Di un DB si usa un membro: ${o.text}.nome`);
      const m = this.member(o, members!, first!);
      return {
        type: this.walk(o, m.type, first!.index, rest),
        awl: o.text + tail(o),
        constant: false,
      };
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
    const deep = o.index || o.path || o.vindex;
    if (deep && formal && (own.kind === 'FC' || i.inOut.includes(formal)))
      fail(
        o,
        `Membri ed elementi di un parametro ${own.kind === 'FC' ? 'di FC' : 'IN_OUT'} (#${m!.name}) non sono supportati in prova: il parametro è un puntatore`,
      );
    if (dest && formal && own.kind === 'FC' && i.input.includes(formal))
      fail(o, `#${m!.name} è un ingresso della FC: non si scrive (usa una TEMP)`);
    return {
      type: this.walk(o, m!.type, o.index, o.path),
      awl: `#${m!.name}${tail(o)}`,
      constant: false,
      ...(formal || m!.name === 'RET_VAL' ? { formal: m as TypedMember } : {}),
    };
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
      case 'tlit':
      case 'str':
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
        if (!['INT', 'DINT', 'REAL', 'TIME'].includes(t))
          fail(e, 'Il meno si usa solo con INT, DINT, REAL e TIME');
        return t;
      }
      case 'call': {
        if (e.name === 'LEN') {
          if (!this.strSide(e.arg)) fail(e.arg, 'LEN vuole una STRING');
          return 'INT';
        }
        const c = CONV[e.name];
        if (!c) return this.typeOf(this.blockCall(e));
        this.want(e.arg, c[0]);
        return c[1];
      }
      case 'bin': {
        const cmp = e.op in CMP;
        if (cmp && this.isStrCmp(e)) return 'BOOL';
        const t = this.pair(e, cmp ? undefined : hint);
        if (e.op in BOOL_OP) {
          if (t !== 'BOOL' && !isBits(t))
            fail(e, `${e.op} si usa con BOOL, BYTE, WORD o DWORD, c'è ${t}: usa ${t}_TO_…`);
          return t;
        }
        if (t === 'BOOL' && !(e.op === '=' || e.op === '<>'))
          fail(e, `L'operatore ${e.op} non si usa con BOOL: usa =, <>, AND, OR, XOR, NOT`);
        if (isBits(t) && !cmp) fail(e, `Con ${t} si usano solo i confronti e AND, OR, XOR, NOT`);
        if (t === 'S5TIME' && !(e.op === '=' || e.op === '<>'))
          fail(e, 'Con S5TIME si usano solo = e <>: per i calcoli usa TIME');
        if ((t === 'DATE' || t === 'TOD' || t === 'CHAR') && !cmp)
          fail(e, `Con ${t === 'TOD' ? 'TIME_OF_DAY' : t} si usano solo i confronti`);
        if (t === 'TIME' && !cmp && e.op !== '+' && e.op !== '-')
          fail(e, 'Con TIME si usano + e - fra due TIME e i confronti: per altro usa TIME_TO_DINT');
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
    if (e.k === 'tlit') return timeLiteral(e.text) ?? fail(e, `Costante non valida: ${e.text}`);
    if (e.k === 'str') {
      if (e.text.length !== 1)
        fail(
          e,
          `Una costante CHAR ha un solo carattere: '${e.text}' (le STRING solo in :=, =, <> e LEN)`,
        );
      const code = this.chars(e)[0]!;
      const c = String.fromCharCode(code);
      return {
        ty: 'CHAR',
        awl: /^[ -~]$/.test(c) ? `'${c}'` : `B#16#${code.toString(16).toUpperCase()}`,
      };
    }
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
    if (e.k === 'call' && e.name === 'LEN') {
      const s = this.strSide(e.arg)!;
      if ('codes' in s) return this.emit(`L ${s.codes.length}`);
      this.opn(s.loc);
      return this.emit(`L ${this.at(s.loc, 'B', 1)}`);
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

  /**
   * WORD e DWORD si confrontano senza segno: col bit alto invertito in entrambi i lati l'ordine
   * con segno di `<I`/`<D` è quello senza segno (BYTE sta già fra 0 e 255).
   */
  private compare(e: Extract<Expr, { k: 'bin' }>): void {
    const ty = this.pair(e) as Num;
    this.operands(e, ty);
    const flip =
      e.op === '=' || e.op === '<>'
        ? undefined
        : { WORD: 'XOW W#16#8000', DWORD: 'XOD DW#16#80000000' }[ty as string];
    if (flip) this.emit(flip, 'TAK', flip, 'TAK');
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
    this.mark('BOOL');
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
    if (o.k === 'temp' || o.k === 'addr' || o.index || o.path || o.vindex)
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
    // per posizione: tutti i parametri, nell'ordine dell'interfaccia
    const positional = c.args.length > 0 && c.args[0]!.name === '';
    if (positional && c.args.length !== formals.length)
      fail(
        c,
        `${k.shown} ha ${formals.length} parametri, ne sono dati ${c.args.length}: per posizione servono tutti nell'ordine dell'interfaccia, altrimenti si passano per nome (p := valore)`,
      );
    const args = positional
      ? c.args.map((a, n) => ({ ...a, name: formals[n]!.m.name, out: formals[n]!.dir === 'out' }))
      : c.args;
    const after: (() => void)[] = [];
    for (const a of args) {
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
      if (!ty) {
        this.complexParam(c, k.fc, m, dir, a, after);
        continue;
      }
      params.push(
        `${m.name} := ${dir === 'in' ? this.actual(a.e, ty) : this.variable(a.e, ty, m.name)}`,
      );
    }
    if (formals.every((f) => f.dir === 'in')) retParam();
    this.emit(...callLines(k.instance, params));
    for (const f of after) f();
  }

  /**
   * Un parametro STRUCT, ARRAY, UDT o STRING di un FB, come fa STEP 7: un ingresso si copia
   * nell'istanza prima della CALL, un'uscita dall'istanza dopo (in `after`). Gli IN_OUT sono
   * puntatori e i parametri complessi delle FC la compilazione non li supporta: errore.
   */
  private complexParam(
    c: Call,
    fc: boolean,
    m: TypedMember,
    dir: 'in' | 'out' | 'inout',
    a: Call['args'][number],
    after: (() => void)[],
  ): void {
    const t = m.type;
    const shown = `Parametro ${m.name} di tipo ${formatType(t)}`;
    const complex =
      ['string', 'struct', 'array'].includes(t.kind) ||
      (t.kind === 'named' && this.ctx.resolve(t.name)?.kind === 'udt');
    if (!complex) fail(a, `${shown}: non supportato in prova (${SUPPORTED})`);
    if (fc) fail(a, `${shown}: la compilazione non supporta i parametri complessi delle FC`);
    if (dir === 'inout') fail(a, `${shown}: un IN_OUT complesso è un puntatore, non supportato`);
    const name = /^[A-Za-z_][A-Za-z0-9_]*$/.test(m.name) ? m.name : `"${m.name}"`;
    const o = c.callee as Located;
    const formal: Located =
      o.k === 'local'
        ? { k: 'local', text: o.text, path: [{ name }], line: a.line, col: a.col }
        : { k: 'symbol', text: `"${unquote(o.text)}"`, path: [{ name }], line: a.line, col: a.col };
    if (dir === 'in') return this.assignComplex(formal, t, a.e, a);
    const to =
      this.complexOf(a.e) ?? fail(a.e, `Per ${m.name} serve una variabile ${formatType(t)}`);
    after.push(() => this.assignComplex(a.e as Located, to, formal, a));
  }

  /** `Fc(x)` scritto come una conversione: la chiamata di un blocco con un parametro per posizione. */
  private blockCall(e: Extract<Expr, { k: 'call' }>): Call {
    if (!this.ctx.block({ name: e.raw }))
      fail(e, `Funzione non supportata in SCL in prova: ${e.name}`);
    const at = { line: e.line, col: e.col };
    const arg = { name: '', out: false, e: e.arg, line: e.arg.line, col: e.arg.col };
    return { k: 'fcall', callee: { k: 'id', text: e.raw, ...at }, args: [arg], ...at };
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
    if (e.vindex)
      fail(e, `Per ${formal} serve una variabile senza indici variabili (usa una TEMP e copiala)`);
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
      case 'bin': {
        if (e.op in CMP && this.isStrCmp(e)) return this.strCompare(e);
        const h = { ...e, l: this.hoist(e.l), r: this.hoist(e.r) };
        // BOOL: a <> b è a XOR b, a = b è NOT (a XOR b)
        if ((e.op === '=' || e.op === '<>') && this.pair(e) === 'BOOL') {
          const x: Expr = { ...h, op: 'XOR' };
          return e.op === '=' ? { k: 'not', e: x, line: e.line, col: e.col } : x;
        }
        return h;
      }
      case 'call': {
        if (e.name === 'LEN') return e;
        if (!CONV[e.name]) return this.hoist(this.blockCall(e));
        const c = { ...e, arg: this.hoist(e.arg) };
        const check = CHECKED[e.name];
        if (!check) return c;
        const ty = CONV[e.name]![1];
        const text = this.temp(ty);
        const [bad, ok] = [this.label(e), this.label(e)];
        this.num(c, ty);
        this.emit(`T ${text}`, ...check(bad, ok));
        this.place(bad);
        this.emit('CLR', 'SAVE');
        this.place(ok);
        return { k: 'temp', text, ty, line: e.line, col: e.col };
      }
      default:
        return isIndexed(e) ? this.readIndexed(e) : e;
    }
  }

  // ---- ARRAY con indici variabili ----

  /** Un elemento con indici variabili letto in una TEMP (anche questo prima del resto). */
  private readIndexed(o: Indexed): Expr {
    const ty = this.resolve(o).ty;
    const text = this.temp(ty);
    const [bad, end] = [this.label(o), this.label(o)];
    const op = this.address(o, bad);
    this.emit(...(ty === 'BOOL' ? [`A ${op}`, `= ${text}`] : [`L ${op}`, `T ${text}`]));
    this.emit(`JU ${end}`);
    this.place(bad);
    this.emit(...(ty === 'BOOL' ? ['CLR', `= ${text}`] : ['L 0', `T ${text}`, 'CLR']), 'SAVE');
    this.place(end);
    return { k: 'temp', text, ty, line: o.line, col: o.col };
  }

  /** `#a[#i] := e`: il valore in una TEMP (o un letterale), poi l'indirizzo e la scrittura. */
  private writeIndexed(dst: Indexed, ty: Ty, e0: Expr, at: Pos): void {
    const e = this.hoist(e0);
    let value: string;
    if (ty === 'BOOL' && e.k === 'bool') value = e.value ? 'SET' : 'CLR';
    else if (isLiteral(e)) value = `L ${this.load(e, ty)}`;
    else {
      const t = this.temp(ty);
      if (ty === 'BOOL') this.cond(e, at);
      else this.num(e, ty as Num);
      this.emit(`${ty === 'BOOL' ? '=' : 'T'} ${t}`);
      value = `${ty === 'BOOL' ? 'A' : 'L'} ${t}`;
    }
    const [bad, end] = [this.label(at), this.label(at)];
    const op = this.address(dst, bad);
    this.emit(value, `${ty === 'BOOL' ? '=' : 'T'} ${op}`);
    this.mark(ty);
    this.emit(`JU ${end}`);
    this.place(bad);
    this.emit('CLR', 'SAVE');
    this.place(end);
  }

  /** L'elemento `index` dell'ARRAY di `o`, risolto come nel compilatore (area, bit, DB). */
  private located(o: Located, index?: number[]): Loc {
    const seg = (name: string, i?: number[]): PathSegment => ({
      name: unquote(name),
      quoted: name.startsWith('"'),
      ...(i ? { index: i } : {}),
      range: NO_RANGE,
    });
    const path = [
      seg(o.k === 'local' ? o.text.slice(1) : o.text, o.index),
      ...(o.path ?? []).map((s) => seg(s.name, s.index)),
    ];
    if (index) path[path.length - 1]!.index = index;
    const op: AwlOperand = { kind: o.k === 'symbol' ? 'symbol' : 'local', path, range: NO_RANGE };
    const shown = `${o.text}${tail(o)}${index ? `[${index.join(',')}]` : ''}`;
    let v: ResolvedOperand;
    try {
      this.resolver ??= ownOperandResolver(this.ctx);
      v = this.resolver(op);
    } catch (e) {
      // Anche gli errori di layout dell'interfaccia (tipo mancante): diagnostica, non eccezione.
      if (e instanceof Error) return fail(o, e.message);
      throw e;
    }
    const at = { line: o.line, col: o.col };
    if (v.k === 'inst') return { area: 'DI', bit: v.bit, at };
    if (v.k === 'area' && ['L', 'M', 'I', 'Q', 'DB'].includes(v.area))
      return { area: v.area, bit: v.bit, at, ...(v.db !== undefined ? { db: v.db } : {}) };
    return fail(
      o,
      index
        ? `${shown}: ARRAY non raggiungibile con un indice variabile`
        : `${shown}: non raggiungibile per copiarlo intero`,
    );
  }

  // ---- STRING, STRUCT, ARRAY e UDT interi: a byte, dagli indirizzi del compilatore ----

  /** Il byte `k` dall'inizio di `l`, largo `sz`: `LD 4`, `DBW 2` (dopo `OPN DB`), `DIB [AR2,P#…]`. */
  private at(l: Loc, sz: 'B' | 'W' | 'D', k: number, ar1 = false): string {
    const byte = (l.bit >> 3) + k;
    if (ar1 || l.area === 'DI') {
      if (byte > 8191) fail(l.at, `Offset ${byte} oltre P#8191.7: non raggiungibile con [AR…,P#…]`);
      return `${l.area}${sz} [${ar1 ? 'AR1' : 'AR2'},P#${byte}.0]`;
    }
    return `${l.area}${sz} ${byte}`;
  }

  private opn(l: Loc): void {
    if (l.area === 'DB') this.emit(`OPN DB ${l.db}`);
  }

  /**
   * Tipo dichiarato di un operando STRING, STRUCT, ARRAY o UDT intero; `undefined` per gli altri.
   * I parametri complessi delle FC e gli IN_OUT complessi degli FB sono puntatori: errore.
   */
  private complexOf(e: Expr): DataType | undefined {
    if (!isOperand(e) || e.k === 'temp' || e.k === 'addr' || e.vindex) return undefined;
    const d = this.declared(e);
    const t = d.type;
    if (!t || typed(t) || !['string', 'struct', 'array', 'named'].includes(t.kind))
      return undefined;
    if (t.kind === 'named' && this.ctx.resolve(t.name)?.kind !== 'udt')
      fail(e, `${e.text}${tail(e)}: si copiano interi solo STRUCT, ARRAY, UDT e STRING`);
    const own = this.ctx.owner;
    if (d.formal && !e.index && !e.path) {
      if (own.kind === 'FC')
        fail(
          e,
          `#${d.formal.name} è un parametro ${formatType(t)} di FC: la compilazione non supporta i parametri complessi delle FC`,
        );
      if (own.iface.inOut.includes(d.formal))
        fail(
          e,
          `#${d.formal.name} è un IN_OUT ${formatType(t)}: è un puntatore, non supportato in prova`,
        );
    }
    return t;
  }

  /** Lunghezza in byte di un tipo, dal layout del compilatore. */
  private bytesOf(t: DataType, at: Pos): number {
    const r = layoutStruct([{ name: 'x', type: t }], this.ctx.resolve);
    const e = r.ok ? r.entries.find((x) => x.path === 'x') : undefined;
    return e ? Math.ceil(e.sizeBits / 8) : fail(at, `Tipo ${formatType(t)} senza layout`);
  }

  /** Stesso tipo: gli UDT si confrontano coi loro membri, nomi compresi. */
  private sameType(a: DataType, b: DataType): boolean {
    const flat = (t: DataType): DataType => {
      if (t.kind !== 'named') return t;
      const r = this.ctx.resolve(t.name);
      return r?.kind === 'udt' ? { kind: 'struct', members: r.members } : t;
    };
    const [x, y] = [flat(a), flat(b)];
    if (x.kind === 'elementary' && y.kind === 'elementary') return x.name === y.name;
    if (x.kind === 'string' && y.kind === 'string') return x.length === y.length;
    if (x.kind === 'array' && y.kind === 'array')
      return (
        x.dims.length === y.dims.length &&
        x.dims.every((d, n) => d.lo === y.dims[n]!.lo && d.hi === y.dims[n]!.hi) &&
        this.sameType(x.element, y.element)
      );
    if (x.kind === 'struct' && y.kind === 'struct')
      return (
        x.members.length === y.members.length &&
        x.members.every(
          (m, n) =>
            sameName(m.name, y.members[n]!.name) && this.sameType(m.type, y.members[n]!.type),
        )
      );
    if (x.kind === 'named' && y.kind === 'named') return sameName(x.name, y.name);
    return x.kind === 'dateAndTime' && y.kind === 'dateAndTime';
  }

  /**
   * `dst := e` con `dst` di tipo `t`: una STRING con `assignString`, STRUCT, ARRAY e UDT dello
   * stesso tipo a istruzioni `L`/`T` di doppie parole (poi parola), sugli indirizzi del compilatore.
   */
  private assignComplex(dst: Located, t: DataType, e: Expr, at: Pos): void {
    if (this.declared(dst, true).constant)
      fail(dst, `Non si può scrivere in una costante: ${dst.text}`);
    if (t.kind === 'string') return this.assignString(dst, t.length, e, at);
    const src = this.complexOf(e);
    if (!src || !this.sameType(src, t))
      return fail(
        e,
        `Tipi diversi: serve ${formatType(t)}${src ? `, c'è ${formatType(src)}` : ' (una variabile dello stesso tipo)'}`,
      );
    const bytes = this.bytesOf(t, at);
    if (bytes > MAX_COPY)
      fail(
        at,
        `Copia di ${bytes} byte: in prova al massimo ${MAX_COPY} (si copia a istruzioni L/T)`,
      );
    const [from, to] = [this.located(e as Located), this.located(dst)];
    if (from.bit % 8 || to.bit % 8) fail(at, 'Copia non allineata al byte');
    let open: number | undefined;
    const move = (op: 'L' | 'T', l: Loc, operand: string) => {
      if (l.area === 'DB' && l.db !== open) {
        this.emit(`OPN DB ${l.db}`);
        open = l.db;
      }
      this.emit(`${op} ${operand}`);
    };
    for (let k = 0; k < bytes;) {
      const n = bytes - k >= 4 ? 4 : bytes - k >= 2 ? 2 : 1;
      move('L', from, this.at(from, WIDTH[n]!, k));
      move('T', to, this.at(to, WIDTH[n]!, k));
      k += n;
    }
  }

  /** I codici dei caratteri di una costante fra apici (niente sequenze `$`). */
  private chars(e: Extract<Expr, { k: 'str' }>): number[] {
    if (e.text.includes('$'))
      fail(e, 'Le sequenze $ nelle costanti fra apici non sono supportate in prova');
    const codes = Array.from(e.text, (c) => c.codePointAt(0)!);
    if (codes.some((c) => c > 0xff)) fail(e, `Carattere fuori da Latin-1 in '${e.text}'`);
    if (codes.length > 254) fail(e, 'Una STRING ha al massimo 254 caratteri');
    return codes;
  }

  /** Un lato STRING: una costante (codici) o una variabile (posizione e lunghezza massima). */
  private strSide(e: Expr): { codes: number[] } | { loc: Loc; max: number } | undefined {
    if (e.k === 'str') return { codes: this.chars(e) };
    const t = this.complexOf(e);
    if (t?.kind !== 'string') return undefined;
    const loc = this.located(e as Located);
    if (loc.bit % 8) fail(e, 'STRING non allineata al byte');
    return { loc, max: t.length };
  }

  /** Un confronto con un lato STRING: una costante che non è di un carattere o una variabile. */
  private isStrCmp(e: Extract<Expr, { k: 'bin' }>): boolean {
    const str = (x: Expr) =>
      (x.k === 'str' && x.text.length !== 1) || this.complexOf(x)?.kind === 'string';
    if (!str(e.l) && !str(e.r)) return false;
    if (e.op !== '=' && e.op !== '<>') fail(e, `Con STRING si usano solo = e <>, non ${e.op}`);
    if (!this.strSide(e.l) || !this.strSide(e.r))
      fail(e, 'Una STRING si confronta solo con una STRING');
    if (e.l.k === 'str' && e.r.k === 'str') fail(e, 'Confronto fra due costanti');
    return true;
  }

  /** `AR1 = i · 8`, più AR2 nei dati d'istanza: il carattere `i` con `[AR1,P#…]`. */
  private pointAt(i: string, l: Loc): void {
    this.emit(`L ${i}`, 'SLD 3');
    if (l.area === 'DI') this.emit('TAR2', '+D');
    this.emit('LAR1');
  }

  /**
   * Ciclo sui caratteri `0 … n-1`: il carattere di `a` in ACCU1, poi `bOp` (`T` lo scrive in `b`,
   * `L` carica quello di `b` e `after` li confronta). Finito, salta a `done`.
   */
  private charLoop(n: string, a: Loc, b: Loc, bOp: 'L' | 'T', after: () => void, done: string) {
    const i = this.temp('INT');
    const top = this.label(a.at);
    this.emit('L 0', `T ${i}`);
    this.place(top);
    this.emit(`L ${i}`, `L ${n}`, '>=I', `JC ${done}`);
    this.pointAt(i, a);
    this.opn(a);
    this.emit(`L ${this.at(a, 'B', 2, true)}`);
    if ((a.area === 'DI') !== (b.area === 'DI')) {
      // AR1 diverso per i due lati: il carattere aspetta in una TEMP
      const c = this.temp('BYTE');
      this.emit(`T ${c}`);
      this.pointAt(i, b);
      this.emit(`L ${c}`);
    }
    this.opn(b);
    this.emit(`${bOp} ${this.at(b, 'B', 2, true)}`);
    after();
    this.emit(`L ${i}`, 'L 1', '+I', `T ${i}`, `JU ${top}`);
  }

  /** `n` = lunghezza attuale di `l` (byte 1), al massimo `max`. */
  private curLen(l: Loc, max: number, n: string): void {
    const small = this.label(l.at);
    this.opn(l);
    this.emit(`L ${this.at(l, 'B', 1)}`, `L ${max}`, '>I', `JC ${small}`, 'TAK');
    this.place(small);
    this.emit(`T ${n}`);
  }

  /** `L`/compare di una costante di 1, 2 o 4 caratteri. */
  private charConst(c: number[]): string {
    const v = c
      .reduce((a, b) => a * 256 + b, 0)
      .toString(16)
      .toUpperCase();
    return `${{ 1: 'B#16#', 2: 'W#16#', 4: 'DW#16#' }[c.length]}${v}`;
  }

  /** Pezzi di 4, 2 e 1 caratteri dall'inizio. */
  private pieces(c: number[]): { k: number; part: number[] }[] {
    const out: { k: number; part: number[] }[] = [];
    for (let k = 0; k < c.length;) {
      const n = c.length - k >= 4 ? 4 : c.length - k >= 2 ? 2 : 1;
      out.push({ k, part: c.slice(k, k + n) });
      k += n;
    }
    return out;
  }

  /**
   * `s := 'testo'` o `s := t`: come STEP 7 si copiano la lunghezza attuale (al massimo quella di
   * `s`) e i caratteri; il byte 0 riceve la lunghezza massima dichiarata di `s`.
   */
  private assignString(dst: Located, max: number, e: Expr, at: Pos): void {
    const src = this.strSide(e) ?? fail(e, "Per una STRING serve una costante '…' o una STRING");
    const to = this.located(dst);
    if (to.bit % 8) fail(dst, 'STRING non allineata al byte');
    if ('codes' in src) {
      const c = src.codes;
      if (c.length > max)
        fail(e, `La costante ha ${c.length} caratteri, ${dst.text}${tail(dst)} ne tiene ${max}`);
      this.opn(to);
      this.emit(
        `L ${max}`,
        `T ${this.at(to, 'B', 0)}`,
        `L ${c.length}`,
        `T ${this.at(to, 'B', 1)}`,
      );
      for (const { k, part } of this.pieces(c))
        this.emit(`L ${this.charConst(part)}`, `T ${this.at(to, WIDTH[part.length]!, 2 + k)}`);
      return;
    }
    const n = this.temp('INT');
    this.curLen(src.loc, Math.min(src.max, max), n);
    this.opn(to);
    this.emit(`T ${this.at(to, 'B', 1)}`, `L ${max}`, `T ${this.at(to, 'B', 0)}`);
    const done = this.label(at);
    this.charLoop(n, src.loc, to, 'T', () => undefined, done);
    this.place(done);
  }

  /** `a = b` / `a <> b` fra STRING: stessa lunghezza attuale e stessi caratteri, in una TEMP BOOL. */
  private strCompare(e: Extract<Expr, { k: 'bin' }>): Expr {
    const [a, b] = [this.strSide(e.l)!, this.strSide(e.r)!];
    const r = this.temp('BOOL');
    const end = this.label(e);
    this.emit('CLR', `= ${r}`);
    if ('codes' in a || 'codes' in b) {
      const [v, c] =
        'codes' in a
          ? [b as { loc: Loc; max: number }, a.codes]
          : [a, (b as { codes: number[] }).codes];
      // una costante più lunga della STRING non è mai uguale
      if (c.length <= v.max) {
        this.opn(v.loc);
        this.emit(`L ${this.at(v.loc, 'B', 1)}`, `L ${c.length}`, '<>I', `JC ${end}`);
        for (const { k, part } of this.pieces(c))
          this.emit(
            `L ${this.at(v.loc, WIDTH[part.length]!, 2 + k)}`,
            `L ${this.charConst(part)}`,
            part.length === 4 ? '<>D' : '<>I',
            `JC ${end}`,
          );
        this.emit('SET', `= ${r}`);
      }
    } else {
      const eq = this.label(e);
      const n = this.temp('INT');
      // n = lunghezza di a; diversa da quella di b, le STRING sono diverse
      this.curLen(a.loc, a.max, n);
      this.opn(b.loc);
      this.emit(`L ${this.at(b.loc, 'B', 1)}`, '<>I', `JC ${end}`);
      this.charLoop(n, a.loc, b.loc, 'L', () => this.emit('<>I', `JC ${end}`), eq);
      this.place(eq);
      this.emit('SET', `= ${r}`);
    }
    this.place(end);
    const t: Expr = { k: 'temp', text: r, ty: 'BOOL', line: e.line, col: e.col };
    return e.op === '=' ? t : { k: 'not', e: t, line: e.line, col: e.col };
  }

  /**
   * Indirizzo di un elemento con indici variabili, come STEP 7 SCL: AR1 = indice lineare (riga per
   * riga) · passo, più AR2 nei dati d'istanza di un FB (così vale anche in multi-istanza), e
   * l'accesso interno all'area `[AR1,P#inizio]`. Inizio e passo vengono dal layout del compilatore
   * (primo e secondo elemento). Un indice fuori dai limiti salta a `bad` (STEP 7 senza il controllo
   * dei limiti scriverebbe fuori dall'ARRAY). Il risultato va usato subito: AR1 non dura.
   */
  private address(o: Indexed, bad: string): string {
    const r = this.resolve(o);
    const dims = r.dims!;
    const lows = dims.map((d) => d.lo);
    const first = this.located(o, lows);
    // il secondo elemento: +1 nell'ultima dimensione con più di un elemento
    const next = [...lows];
    let j = dims.length - 1;
    while (j >= 0 && dims[j]!.hi === dims[j]!.lo) j--;
    if (j >= 0) next[j]! += 1;
    const stride = j >= 0 ? this.located(o, next).bit - first.bit : 0;
    if (first.bit > 0xffff)
      fail(o, `${o.text}: l'ARRAY inizia oltre il byte 8191, non raggiungibile con [AR1,P#…]`);
    this.scoped(() => {
      const k = dims.length > 1 ? this.temp('DINT') : '';
      dims.forEach((d, n) => {
        const e = this.dint(o.vindex[n]!);
        if (e.k === 'int') {
          const v = Number(intLiteral(e.text).value);
          if (v < d.lo || v > d.hi) fail(e, `Indice ${v} fuori da [${d.lo}..${d.hi}]`);
        }
        if (n > 0) this.emit(`L ${k}`, `L L#${d.hi - d.lo + 1}`, '*D', `T ${k}`);
        this.num(this.hoist(e), 'DINT');
        // ACCU2 = indice: oltre hi o sotto lo si salta, poi indice - lo
        this.emit(`L L#${d.hi}`, '>D', `JC ${bad}`, 'TAK', `L L#${d.lo}`, '<D', `JC ${bad}`, '-D');
        if (n > 0) this.emit(`L ${k}`, '+D');
        if (n < dims.length - 1) this.emit(`T ${k}`);
      });
    });
    if (stride !== 1) this.emit(`L L#${stride}`, '*D');
    if (first.area === 'DI') this.emit('TAR2', '+D');
    this.emit('LAR1');
    if (first.area === 'DB') this.emit(`OPN DB ${first.db}`);
    const size = r.ty === 'BOOL' ? 'X' : WIDTH[SIZE[r.ty as Num]]!;
    const mnem = first.area + (size === 'X' && first.area.length === 1 ? '' : size);
    return `${mnem} [AR1,P#${first.bit >> 3}.${first.bit & 7}]`;
  }

  /** Un indice come DINT: un INT si allarga con ITD. */
  private dint(e: Expr): Expr {
    const t = this.typeOf(e, 'DINT');
    if (t === 'INT')
      return {
        k: 'call',
        name: 'INT_TO_DINT',
        raw: 'INT_TO_DINT',
        arg: e,
        line: e.line,
        col: e.col,
      };
    if (t !== 'DINT') fail(e, `Un indice dev'essere INT o DINT, c'è ${t}`);
    return e;
  }

  // ---- istruzioni ----

  /** Ogni istruzione da sola: un errore si registra e si passa alla successiva. */
  stmts(list: Stmt[]): void {
    for (const s of list) {
      const depth = this.depth;
      try {
        this.stmt(s);
      } catch (e) {
        if (!(e instanceof SclError)) throw e;
        this.depth = depth;
        this.errors.push(e);
      }
    }
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
        const whole = this.complexOf(s.dst);
        if (whole) return this.scoped(() => this.assignComplex(s.dst as Located, whole, s.e, s));
        // un indirizzo prende il tipo dell'espressione se ci sta (MW10 := una WORD)
        const dst = this.resolve(s.dst, s.dst.k === 'addr' ? this.typeOf(s.e) : undefined, true);
        if (dst.constant) fail(s.dst, `Non si può scrivere in una costante: ${s.dst.text}`);
        this.want(s.e, dst.ty);
        const to = s.dst;
        if (isIndexed(to)) return this.scoped(() => this.writeIndexed(to, dst.ty, s.e, s));
        return this.scoped(() => {
          const e = this.hoist(s.e);
          if (dst.ty === 'BOOL') this.cond(e, s);
          else this.num(e, dst.ty as Num);
          this.emit(`${dst.ty === 'BOOL' ? '=' : 'T'} ${dst.awl}`);
          this.mark(dst.ty);
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
    /** `simple`: il selettore si carica nei confronti, e il primo `L` ne dà il valore. */
    const run = (sel: string, simple: boolean) => {
      const end = this.label(s);
      const first = this.out.length;
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
      if (simple && this.out.length > first) this.mark(n, first);
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
      if (isSimple(sel)) return run(this.load(sel, n), true);
      this.num(sel, n);
      this.withTemp(n, (tmp) => {
        this.emit(`T ${tmp}`);
        this.mark(n);
        run(tmp, false);
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
    if (s.v.k !== 'temp' && s.v.vindex)
      fail(s.v, 'La variabile del FOR non può avere indici variabili');
    const v = this.resolve(s.v, undefined, true);
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
      this.mark(ty, this.out.length - 4);
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
  const { stmts, errors } = parse(text);
  gen.stmts(stmts);
  if (errors.length || gen.errors.length) {
    // Uno per posizione (un carattere sbagliato non dà anche l'errore del parser), in ordine.
    const seen = new Set<string>();
    const diagnostics = [...errors, ...gen.errors]
      .filter((e) => !seen.has(`${e.line}:${e.col}`) && !!seen.add(`${e.line}:${e.col}`))
      .sort((a, b) => a.line - b.line || a.col - b.col)
      .slice(0, MAX_ERRORS)
      .map((e) => ({ line: e.line, col: e.col, message: e.message }));
    return { source: '', lines: [], diagnostics };
  }
  const plain = gen.out.map((l) => l.text).join('\n');
  // forma canonica come nel KOP; se cambia il numero di righe resta il testo grezzo
  const formatted = formatNetwork(plain, 'international');
  return {
    source: formatted.split('\n').length === gen.out.length ? formatted : plain,
    lines: gen.out.map((l, line) => ({
      line,
      sclLine: l.sclLine,
      ...(l.value ? { value: SHOWN[l.value] ?? (l.value as SclType) } : {}),
    })),
    diagnostics: [],
  };
}
