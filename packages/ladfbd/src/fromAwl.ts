// Conversione AWL → KOP/FUP di un segmento («Converti» di STEP 7): l'inverso di `networkToAwl`.
// Il riconoscimento prova le forme che la traduzione KOP → AWL genera (docs/linguaggi/kop-awl.md
// §2–§4) e propone reti candidate; una candidata vale solo se la sua traduzione dà le stesse
// istruzioni con gli stessi operandi dell'ingresso (spazi, commenti e maiuscole a parte; le
// etichette automatiche dei box si possono rinominare se nessun altro segmento le usa). Altrimenti
// il segmento resta AWL: questo codice finisce in un PLC vero, il controllo di andata e ritorno
// non si salta mai.
import { formatNetwork, parseDetailed } from '@baaportal/awl';
import type { Operand } from '@baaportal/awl';
import { BOX_CATALOG } from './catalog.js';
import type { BoxDef } from './catalog.js';
import type { BoxKind, CmpFn, LadBox, LadElem, LadNetwork, LadNode, LadOut } from './model.js';
import { CMP_FNS, isNode } from './model.js';
import { mapOperands } from './operands.js';
import { networkToAwl } from './toAwl.js';
import type { NetworkAwlOpts } from './toAwl.js';

/** Un'istruzione in forma canonica: mnemonico internazionale, operando come lo scrive formatNetwork. */
type Tok = {
  label?: string;
  op: string;
  arg: string;
  /** L'operando è un'etichetta (salti). */
  ref: boolean;
  params?: string[];
  /** Riga 1-based nella sorgente formattata. */
  line: number;
};

export type AwlToLadOpts = NetworkAwlOpts & {
  newId: () => string;
  /** Etichette scritte negli altri segmenti del blocco: queste non si rinominano. */
  foreignLabels?: ReadonlySet<string>;
  /**
   * Byte L scritti come operandi negli altri segmenti: un bit L in questi byte non diventa il bit
   * nascosto di un ramo a T o di un pin (il compilatore lo sceglie dopo i TEMP, l'altro segmento no).
   */
  foreignLocals?: ReadonlySet<number>;
};

/**
 * Perché un segmento resta AWL: `SYNTAX` errori nel testo, `EMPTY` nessuna istruzione, `SHAPE`
 * nessuna rete KOP dà le stesse istruzioni (`line`: fin dove si è riconosciuto), `TOO_COMPLEX`
 * troppe istruzioni o combinazioni da provare.
 */
export type AwlToLadFailure = { code: 'SYNTAX' | 'EMPTY' | 'SHAPE' | 'TOO_COMPLEX'; line?: number };
export type AwlToLadResult =
  { ok: true; network: LadNetwork; nextLabel: number } | { ok: false; reason: AwlToLadFailure };

const MAX_STEPS = 200_000;
const MAX_CANDIDATES = 200;
/** Oltre, il segmento resta AWL senza provarci: la ricerca crescerebbe col quadrato. */
const MAX_INSTRUCTIONS = 300;
const TIMER_FNS = ['SP', 'SE', 'SD', 'SS', 'SF'] as const;
type TimerFn = (typeof TIMER_FNS)[number];
const L_BIT = /^%L\d+\.[0-7]$/;

class Budget extends Error {}

/** Istruzioni canoniche di una sorgente; `null` se ha errori o etichette senza istruzione. */
function tokensOf(source: string): Tok[] | null {
  const text = formatNetwork(source, 'international');
  const r = parseDetailed(text, 'international');
  if (r.errors.length > 0) return null;
  const slice = (o: Operand) => text.slice(o.range.from.offset, o.range.to.offset);
  const toks: Tok[] = [];
  for (const st of r.statements) {
    if (!st.instruction.def) return null;
    const t: Tok = {
      op: st.instruction.def.id,
      arg: st.operand ? slice(st.operand) + (st.instanceDb ? `, ${slice(st.instanceDb)}` : '') : '',
      ref: st.operand?.kind === 'labelRef',
      line: st.range.from.line + 1,
    };
    if (st.label) t.label = st.label.name;
    if (st.params)
      t.params = st.params.map((p) => `${p.name} ${p.arrow} ${p.value ? slice(p.value) : ''}`);
    toks.push(t);
  }
  // due etichette di fila: la prima non è su nessuna istruzione
  const defined = new Set(toks.flatMap((t) => (t.label ? [t.label] : [])));
  if (r.units.some((u) => u.kind === 'label' && !defined.has(u.text ?? ''))) return null;
  return toks;
}

/** Etichette definite o usate in una sorgente AWL (per `foreignLabels`). */
export function awlLabels(source: string): Set<string> {
  const out = new Set<string>();
  for (const t of tokensOf(source) ?? []) {
    if (t.label) out.add(t.label);
    if (t.ref) out.add(t.arg);
  }
  return out;
}

/** Byte L letti o scritti da operandi assoluti (`%L0.0`, `%LW2`…) in testo AWL formattato. */
function localBytesOf(texts: Iterable<string>, re: RegExp): Set<number> {
  const out = new Set<number>();
  for (const t of texts)
    for (const m of t.matchAll(re)) {
      const width = { B: 1, W: 2, D: 4 }[m[1] as 'B' | 'W' | 'D'] ?? 1;
      for (let k = 0; k < width; k++) out.add(Number(m[2]) + k);
    }
  return out;
}

// shortcut: gli accessi indiretti all'area L (`W[AR1,P#…]`, puntatori P#L) non si vedono; servirebbe
// un'analisi dei puntatori.
/** Byte L usati da un segmento AWL (per `foreignLocals`). */
export function awlLocalBytes(source: string): Set<number> {
  return localBytesOf([formatNetwork(source, 'international')], /%L([BWD]?)(\d+)/g);
}

/** Byte L usati dagli operandi scritti di una rete KOP/FUP (per `foreignLocals`). */
export function ladLocalBytes(net: LadNetwork): Set<number> {
  const ops: string[] = [];
  mapOperands(net, (v) => (ops.push(v.replace(/[\s%]/g, '')), v));
  return localBytesOf(ops, /^L([BWD]?)(\d+)(?:\.[0-7])?$/g);
}

/** Etichette scritte in una rete KOP/FUP: quella del segmento e quelle dei salti (non le automatiche). */
export function ladLabels(net: LadNetwork): Set<string> {
  const out = new Set<string>(net.label ? [net.label] : []);
  const walk = (n: LadNode): void =>
    n.outs.forEach((o) => {
      if (isNode(o)) walk(o);
      else if (o.k === 'jmp' || o.k === 'jmpn') out.add(o.label);
    });
  walk(net.root);
  return out;
}

/**
 * Dove porta ogni salto di un blocco (segmenti in ordine): `segmento:istruzione` del bersaglio,
 * `?` se l'etichetta non c'è; `null` se un'etichetta è definita due volte. Un segmento con errori
 * non conta.
 */
export function blockJumps(sources: string[]): string[] | null {
  const toks = sources.map((s) => tokensOf(s) ?? []);
  const where = new Map<string, string>();
  for (const [n, ts] of toks.entries())
    for (const [i, t] of ts.entries()) {
      if (!t.label) continue;
      if (where.has(t.label)) return null;
      where.set(t.label, `${n}:${i}`);
    }
  return toks.flatMap((ts) => ts.flatMap((t) => (t.ref ? [where.get(t.arg) ?? '?'] : [])));
}

/**
 * Stesse istruzioni e operandi; un'etichetta si può rinominare solo in modo coerente (biiezione)
 * e solo se nessun altro segmento scrive né il vecchio né il nuovo nome.
 */
function sameCode(a: Tok[], b: Tok[], foreign: ReadonlySet<string>): boolean {
  if (a.length !== b.length) return false;
  const ab = new Map<string, string>();
  const ba = new Map<string, string>();
  const pair = (x: string | undefined, y: string | undefined): boolean => {
    if (x === undefined || y === undefined) return x === y;
    if (ab.has(x) || ba.has(y)) return ab.get(x) === y && ba.get(y) === x;
    if (x !== y && (foreign.has(x) || foreign.has(y))) return false;
    ab.set(x, y);
    ba.set(y, x);
    return true;
  };
  return a.every((x, i) => {
    const y = b[i]!;
    return (
      x.op === y.op &&
      x.ref === y.ref &&
      (x.ref ? pair(x.arg, y.arg) : x.arg === y.arg) &&
      JSON.stringify(x.params) === JSON.stringify(y.params) &&
      pair(x.label, y.label)
    );
  });
}

// Box con EN/ENO riconoscibili dall'istruzione del corpo (MOVE e CALL a parte).
const EN_BY_AWL = new Map<string, BoxDef[]>();
for (const d of Object.values(BOX_CATALOG)) {
  if (!d.en || !d.awl) continue;
  EN_BY_AWL.set(d.awl, [...(EN_BY_AWL.get(d.awl) ?? []), d]);
}

type Gen<T> = Generator<[T, number]>;
/** Serie come lista concatenata: le serie memorizzate condividono la coda, senza copie. */
type List = { head: LadElem; tail: List; closed: boolean } | null;
/** Bit L della logica dei pin BOOL dei box CALL (H18) → la sua serie. */
type Pre = ReadonlyMap<string, LadElem[]>;
const NO_PRE: Pre = new Map();

/** Dove una serie ammette box: ovunque (radice), solo per primo (ramo a T, §1.3), mai (rami, pin). */
type Boxes = 'any' | 'first' | 'none';

class Parser {
  private steps = 0;
  far = 0;
  /** Box con ENO o Q libero: chiudono la serie e il nodo (nessuna uscita dopo). */
  private readonly last = new WeakSet<LadElem>();
  private readonly memo = new Map<string, [List, number][]>();
  private readonly preIds = new WeakMap<Pre, number>();
  private preCount = 0;

  constructor(
    private readonly t: Tok[],
    private readonly id: () => string,
    private readonly foreignLocals: ReadonlySet<number>,
  ) {}

  /** Un passo di lavoro: oltre `MAX_STEPS` la ricerca si ferma. */
  private tick(): void {
    if (++this.steps > MAX_STEPS) throw new Budget();
  }

  /** Bit L che può restare nascosto nel grafico (nessun altro segmento ne usa il byte). */
  private hidden(bit: string | undefined): bit is string {
    return !!bit && L_BIT.test(bit) && !this.foreignLocals.has(Number(/\d+/.exec(bit)![0]));
  }

  private list(l: List): LadElem[] {
    const out: LadElem[] = [];
    for (; l; l = l.tail) {
      this.tick();
      out.push(l.head);
    }
    return out;
  }

  /** L'istruzione `op` in posizione `i`, senza etichetta (o con l'etichetta `label`). */
  private at(i: number, op: string, label?: string): Tok | undefined {
    this.tick();
    const k = this.t[i];
    if (!k || k.op !== op || k.label !== label) return undefined;
    if (i > this.far) this.far = i;
    return k;
  }
  /** `op` con operando (non un'etichetta). */
  private arg(i: number, op: string): string | undefined {
    const k = this.at(i, op);
    return k && k.arg !== '' && !k.ref ? k.arg : undefined;
  }
  private bare(i: number, op: string): boolean {
    const k = this.at(i, op);
    return !!k && k.arg === '';
  }
  private ref(i: number, op: string): string | undefined {
    const k = this.at(i, op);
    return k?.ref ? k.arg : undefined;
  }

  *network(): Gen<LadNetwork> {
    const first = this.t[0];
    const label = first?.label;
    if (first && label !== undefined) delete first.label;
    for (const [root, end] of this.node(0, true, true, NO_PRE, true)) {
      if (end === this.t.length) yield [label === undefined ? { root } : { label, root }, end];
    }
  }

  // ---- nodi ----

  /** §2.8–§2.10 e la logica dei pin dei box CALL (H18) davanti alla serie (`prelude`). */
  private *node(
    i: number,
    fresh: boolean,
    prelude: boolean,
    pre: Pre,
    root: boolean,
  ): Gen<LadNode> {
    for (const [pre2, j] of prelude ? this.prelude(i, pre) : [[pre, i] as [Pre, number]]) {
      for (const [s, k] of this.series(j, fresh, pre2, root ? 'any' : 'first')) {
        if (!root && fresh && !s) continue;
        const nodeOf = (outs: (LadOut | LadNode)[]): LadNode => ({
          id: this.id(),
          series: this.list(s),
          outs,
        });
        if (fresh && !s) {
          for (const [outs, m] of this.railOuts(k, pre2))
            if (outs.length > 0) yield [nodeOf(outs), m];
          continue;
        }
        // un box con ENO o Q libero chiude il nodo senza uscite
        if (s?.closed) {
          yield [nodeOf([]), k];
          continue;
        }
        for (const [outs, m] of this.outList(k, true)) if (outs.length > 0) yield [nodeOf(outs), m];
        const bit = this.arg(k, '=');
        if (this.hidden(bit)) {
          for (const [outs, m] of this.shared(k + 1, bit, pre2))
            if (outs.length > 0) yield [nodeOf(outs), m];
        }
      }
    }
  }

  /** Gruppi `serie; = L x.y` dei pin BOOL dei box CALL. Prima l'alternativa senza. */
  private *prelude(i: number, pre: Pre): Gen<Pre> {
    yield [pre, i];
    for (const [s, j] of this.series(i, true, NO_PRE, 'none')) {
      if (!s) continue;
      const bit = this.arg(j, '=');
      if (!this.hidden(bit) || pre.has(bit)) continue;
      yield* this.prelude(j + 1, new Map([...pre, [bit, this.list(s)]]));
    }
  }

  /** Uscite una dopo l'altra sullo stesso RLO. */
  private *outList(i: number, cond: boolean): Gen<(LadOut | LadNode)[]> {
    for (const [o, j] of this.output(i, cond))
      for (const [rest, k] of this.outList(j, cond)) yield [[o, ...rest], k];
    yield [[], i];
  }

  /** Nodo salvato in un bit L: ogni uscita o ramo a T riparte da `A bit` (H4/H5). */
  private *shared(i: number, bit: string, pre: Pre): Gen<(LadOut | LadNode)[]> {
    for (const [pre2, j] of this.prelude(i, pre)) {
      if (this.arg(j, 'A') !== bit) continue;
      // con la logica dei pin davanti segue un ramo a T, non un'uscita
      const alts: Gen<LadOut | LadNode>[] = [this.node(j + 1, false, false, pre2, false)];
      if (pre2 === pre) alts.unshift(this.output(j + 1, true));
      for (const g of alts)
        for (const [o, k] of g)
          for (const [rest, m] of this.shared(k, bit, pre)) yield [[o, ...rest], m];
    }
    yield [[], i];
  }

  /** Uscite sulla barra: ognuna riparte da capo, con SET se usa l'RLO (H7). */
  private *railOuts(i: number, pre: Pre): Gen<(LadOut | LadNode)[]> {
    const alts: Gen<LadOut | LadNode>[] = [
      this.output(i, false),
      this.node(i, true, true, pre, false),
    ];
    if (this.bare(i, 'SET')) alts.unshift(this.output(i + 1, false));
    for (const g of alts)
      for (const [o, j] of g)
        for (const [rest, k] of this.railOuts(j, pre)) yield [[o, ...rest], k];
    yield [[], i];
  }

  private *output(i: number, cond: boolean): Gen<LadOut> {
    const id = this.id;
    const one = (o: LadOut, n = 1): [LadOut, number] => [o, i + n];
    let a: string | undefined;
    if ((a = this.arg(i, '='))) yield one({ id: id(), k: 'coil', op: a });
    if ((a = this.arg(i, 'S'))) yield one({ id: id(), k: 'set', op: a });
    if ((a = this.arg(i, 'R'))) yield one({ id: id(), k: 'reset', op: a });
    const v = this.arg(i, 'L');
    if (v) {
      for (const fn of TIMER_FNS) {
        const t = this.arg(i + 1, fn);
        if (t) yield one({ id: id(), k: 'tcoil', fn, timer: t, value: v }, 2);
      }
      const c = this.arg(i + 1, 'S');
      if (c) yield one({ id: id(), k: 'ccoil', fn: 'SC', counter: c, value: v }, 2);
    }
    for (const fn of ['CU', 'CD'] as const)
      if ((a = this.arg(i, fn))) yield one({ id: id(), k: 'ccoil', fn, counter: a, value: '' });
    if ((a = this.ref(i, cond ? 'JC' : 'JU'))) yield one({ id: id(), k: 'jmp', label: a });
    if (cond && (a = this.ref(i, 'JCN'))) yield one({ id: id(), k: 'jmpn', label: a });
    if ((a = this.arg(i, cond ? 'CC' : 'UC'))) yield one({ id: id(), k: 'callCoil', block: a });
    if ((a = this.arg(i, 'OPN'))) yield one({ id: id(), k: 'opn', db: a });
    if (this.bare(i, 'SAVE')) {
      if (cond && this.bare(i + 1, 'BEC')) yield one({ id: id(), k: 'ret' }, 2);
      if (this.bare(i + 1, 'CLR')) yield one({ id: id(), k: 'save' }, 2);
    }
    const flags = [
      ['MCR(', 'mcrOpen'],
      [')MCR', 'mcrClose'],
      ['MCRA', 'mcra'],
      ['MCRD', 'mcrd'],
    ] as const;
    for (const [op, k] of flags) if (this.bare(i, op)) yield one({ id: id(), k });
  }

  // ---- serie ----

  /** Tutte le serie da `i`, la più lunga per prima (memorizzate: le stesse si riprovano spesso). */
  private series(i: number, fresh: boolean, pre: Pre, boxes: Boxes): [List, number][] {
    let preId = this.preIds.get(pre);
    if (preId === undefined) this.preIds.set(pre, (preId = this.preCount++));
    const key = `${i}|${fresh}|${boxes}|${preId}`;
    const hit = this.memo.get(key);
    if (hit) return hit;
    const out: [List, number][] = [];
    for (const [e, j] of this.item(i, fresh, pre, boxes !== 'none')) {
      if (this.last.has(e)) {
        out.push([{ head: e, tail: null, closed: true }, j]);
        continue;
      }
      const restBoxes = boxes === 'any' ? 'any' : 'none';
      for (const [tail, k] of this.series(j, false, pre, restBoxes)) {
        this.tick();
        out.push([{ head: e, tail, closed: tail?.closed ?? false }, k]);
      }
    }
    out.push([null, i]);
    this.memo.set(key, out);
    return out;
  }

  private *item(i: number, fresh: boolean, pre: Pre, boxes: boolean): Gen<LadElem> {
    const id = this.id;
    let a: string | undefined;
    for (const [op, neg] of [
      ['A', false],
      ['AN', true],
    ] as const)
      if ((a = this.arg(i, op))) yield [{ id: id(), k: 'contact', neg, op: a }, i + 1];
    if (this.bare(i, 'NOT')) yield [{ id: id(), k: 'not' }, i + 1];
    for (const dir of ['P', 'N'] as const)
      if ((a = this.arg(i, `F${dir}`))) yield [{ id: id(), k: 'edge', dir, mem: a }, i + 1];
    // (#), §2.9: = x; A x
    if ((a = this.arg(i, '=')) && this.arg(i + 1, 'A') === a)
      yield [{ id: id(), k: 'midline', op: a }, i + 2];
    // confronto §3.5 e box POS/NEG §2.13, in A( … ) se c'è logica davanti
    const open = fresh ? i : this.bare(i, 'A(') ? i + 1 : -1;
    if (open >= 0) {
      const close = (j: number) => (fresh ? j : this.bare(j, ')') ? j + 1 : -1);
      const in1 = this.arg(open, 'L');
      const in2 = in1 && this.arg(open + 1, 'L');
      const fn = in2 ? CMP_FNS.find((f) => this.bare(open + 2, f)) : undefined;
      const end = fn ? close(open + 3) : -1;
      if (fn && in1 && in2 && end >= 0)
        yield [{ id: id(), k: 'cmp', fn: fn as CmpFn, in1, in2 }, end];
      if (!fresh) {
        const bit = this.arg(open, 'A');
        for (const dir of ['P', 'N'] as const) {
          const mem = bit && this.arg(open + 1, `F${dir}`);
          const e = mem ? close(open + 2) : -1;
          if (bit && mem && e >= 0) yield [{ id: id(), k: 'posneg', dir, bit, mem }, e];
        }
      }
    }
    yield* this.parallel(i, fresh, pre);
    if (!boxes) return;
    yield* this.enBox(i, fresh, pre);
    yield* this.flowBox(i, fresh, pre);
  }

  // ---- paralleli (regole 1–4) ----

  private *parallel(i: number, fresh: boolean, pre: Pre): Gen<LadElem> {
    const par = (branches: LadElem[][]): LadElem => ({ id: this.id(), k: 'parallel', branches });
    if (this.bare(i, 'A(')) {
      for (const [bs, j] of this.branches(i + 1, pre))
        if (this.bare(j, ')')) yield [par(bs), j + 1];
    }
    if (fresh) for (const [bs, j] of this.branches(i, pre)) yield [par(bs), j];
    // H21: `= bit` e ogni ramo in `O( A bit … )` (NOT, (#) o fronti nei rami con logica davanti)
    const bit = fresh ? undefined : this.arg(i, '=');
    if (this.hidden(bit))
      for (const [bs, j] of this.flowBranches(i + 1, bit, pre))
        if (bs.length >= 2) yield [par(bs), j];
    // gruppo `A( … NOT )`: la negazione di un'entrata in mezzo alla serie (un solo ramo)
    if (this.bare(i, 'A('))
      for (const [s, j] of this.series(i + 1, true, pre, 'none')) {
        if (!s || !this.bare(j, ')')) continue;
        const g = this.list(s);
        if (g.length >= 2 && g.at(-1)!.k === 'not') yield [par([g]), j + 1];
      }
  }

  private *branches(i: number, pre: Pre): Gen<LadElem[][]> {
    // regola 2: A… / O / A…
    const groups: LadElem[][] = [];
    let j = i;
    for (;;) {
      const g: LadElem[] = [];
      for (let a: string | undefined; ; j++) {
        const neg = !(a = this.arg(j, 'A'));
        if (neg) a = this.arg(j, 'AN');
        if (!a) break;
        g.push({ id: this.id(), k: 'contact', neg, op: a });
      }
      if (g.length === 0) break;
      groups.push(g);
      if (!this.bare(j, 'O') || !this.t[j + 1]) break;
      j++;
    }
    // un O senza gruppo dopo non è un parallelo
    if (groups.length >= 2 && !this.bare(j - 1, 'O')) yield [groups, j];
    // regole 1 e 3: O x per un contatto solo, O( … ) per gli altri rami
    for (const [bs, k] of this.orBranches(i, pre)) if (bs.length >= 2) yield [bs, k];
  }

  private *flowBranches(i: number, bit: string, pre: Pre): Gen<LadElem[][]> {
    if (this.bare(i, 'O(') && this.arg(i + 1, 'A') === bit)
      for (const [s, j] of this.series(i + 2, false, pre, 'none')) {
        if (!s || !this.bare(j, ')')) continue;
        const branch = this.list(s);
        for (const [rest, k] of this.flowBranches(j + 1, bit, pre)) yield [[branch, ...rest], k];
      }
    yield [[], i];
  }

  private *orBranches(i: number, pre: Pre): Gen<LadElem[][]> {
    let a: string | undefined;
    for (const [op, neg] of [
      ['O', false],
      ['ON', true],
    ] as const) {
      if ((a = this.arg(i, op)))
        for (const [rest, k] of this.orBranches(i + 1, pre))
          yield [[[{ id: this.id(), k: 'contact', neg, op: a }], ...rest], k];
    }
    if (this.bare(i, 'O(')) {
      for (const [s, j] of this.series(i + 1, true, pre, 'none')) {
        if (!s || !this.bare(j, ')')) continue;
        const branch = this.list(s);
        for (const [rest, k] of this.orBranches(j + 1, pre)) yield [[branch, ...rest], k];
      }
    }
    yield [[], i];
  }

  // ---- box ----

  /** Box con EN/ENO, §4.1–§4.11. */
  private *enBox(i: number, fresh: boolean, pre: Pre): Gen<LadElem> {
    if (fresh) {
      for (const [b, j] of this.enBody(i, pre)) {
        if (this.at(j, 'NOP') && this.t[j]!.arg === '0') yield [this.final(b), j + 1];
        if (this.isBr(j)) yield [b, j + 1];
        for (const first of ['AN', 'SET']) {
          const ok =
            (first === 'SET' ? this.bare(j, 'SET') : this.arg(j, 'AN') === 'OV') &&
            this.bare(j + 1, 'SAVE') &&
            this.bare(j + 2, 'CLR') &&
            this.isBr(j + 3);
          if (ok) yield [b, j + 4];
        }
      }
      return;
    }
    const label = this.ref(i, 'JNB');
    if (!label) return;
    for (const [b, j] of this.enBody(i + 1, pre)) {
      const ends = [j];
      if (this.arg(j, 'AN') === 'OV' && this.bare(j + 1, 'SAVE') && this.bare(j + 2, 'CLR'))
        ends.push(j + 3);
      for (const e of ends) {
        const k = this.t[e];
        if (!k || k.label !== label) continue;
        this.tick();
        if (k.op === 'A' && k.arg === 'BR') yield [{ ...b }, e + 1];
        if (k.op === 'NOP' && k.arg === '0') yield [this.final({ ...b }), e + 1];
      }
    }
  }

  private final(e: LadElem): LadElem {
    this.last.add(e);
    return e;
  }

  private isBr(i: number): boolean {
    return this.arg(i, 'A') === 'BR';
  }

  private box(kind: BoxKind, instance: string, pins: Record<string, string>): LadBox {
    return { id: this.id(), k: 'box', box: kind, instance, pins, boolPins: {} };
  }

  /** Corpo di un box con EN/ENO: CALL con parametri, oppure L…, istruzione, T…. */
  private *enBody(i: number, pre: Pre): Gen<LadBox> {
    const call = this.at(i, 'CALL');
    if (call && call.arg && !call.ref) {
      const b = this.box('CALL', call.arg, {});
      let ok = true;
      for (const p of call.params ?? []) {
        const m = /^(\S+) := (.+)$/.exec(p);
        if (!m) {
          ok = false;
          break;
        }
        const logic = pre.get(m[2]!);
        if (logic) b.boolPins[m[1]!] = logic;
        else b.pins[m[1]!] = m[2]!;
      }
      if (ok) yield [b, i + 1];
      return;
    }
    const loads: string[] = [];
    let j = i;
    for (let a: string | undefined; (a = this.arg(j, 'L')); j++) loads.push(a);
    if (loads.length === 0) return;
    const stores = (k: number, def: BoxDef): [LadBox, number] | undefined => {
      const outs = def.outputs.map((p, n) => this.arg(k + n, 'T') ?? '');
      if (outs.some((o) => o === '')) return undefined;
      // §4.8, H14: N si carica prima di IN
      const names = def.group === 'shift' ? ['N', 'IN'] : def.dataInputs.map((p) => p.name);
      const pins: Record<string, string> = {};
      def.dataInputs.forEach((p) => (pins[p.name] = loads[names.indexOf(p.name)]!));
      def.outputs.forEach((p, n) => (pins[p.name] = outs[n]!));
      return [this.box(def.kind, '', pins), k + def.outputs.length];
    };
    if (loads.length === 1) {
      const r = stores(j, BOX_CATALOG.MOVE);
      if (r) yield r;
    }
    const instr = this.t[j];
    if (!instr || instr.label !== undefined || instr.arg !== '') return;
    for (const def of EN_BY_AWL.get(instr.op) ?? []) {
      if (def.dataInputs.length !== loads.length || !this.bare(j, instr.op)) continue;
      const r = stores(j + 1, def);
      if (r) yield r;
    }
  }

  /** Flip-flop §2.12, temporizzatori §3.2 e contatori §3.4 a box. */
  private *flowBox(i: number, fresh: boolean, pre: Pre): Gen<LadElem> {
    let j = i;
    if (fresh) {
      if (!this.bare(j, 'SET')) return;
      j++;
    }
    const cands: { def: BoxDef; inst: string; pins: Record<string, string>; end: number }[] = [];
    const tv = this.arg(j, 'L');
    if (tv) {
      for (const fn of TIMER_FNS) {
        const inst = this.arg(j + 1, fn);
        const kind = timerKind(fn);
        if (inst) cands.push({ def: BOX_CATALOG[kind], inst, pins: { TV: tv }, end: j + 2 });
      }
    }
    const firsts: [string, BoxKind[]][] = [
      ['S', ['SR']],
      ['R', ['RS']],
      ['CU', ['S_CU', 'S_CUD']],
      ['CD', ['S_CD']],
    ];
    for (const [op, kinds] of firsts) {
      const inst = this.arg(j, op);
      if (inst)
        for (const k of kinds) cands.push({ def: BOX_CATALOG[k], inst, pins: {}, end: j + 1 });
    }
    for (const c of cands) {
      for (const [b, k] of this.boolInputs(c.def, c.inst, c.def.boolInputs, c.end, pre, {
        ...c.pins,
      })) {
        for (const [pins, m] of this.flowOutputs(c.def, c.inst, k, b.pins)) {
          if (this.arg(m, 'A') === c.inst) yield [{ ...b, pins }, m + 1];
          yield [this.final({ ...b, pins }), m];
        }
      }
    }
  }

  /** Ogni pin BOOL d'ingresso (in ordine) ha la sua logica da capo e poi l'azione, o manca. */
  private *boolInputs(
    def: BoxDef,
    inst: string,
    names: string[],
    i: number,
    pre: Pre,
    pins: Record<string, string>,
    boolPins: Record<string, LadElem[]> = {},
  ): Gen<LadBox> {
    const [name, ...rest] = names;
    if (name === undefined) {
      yield [{ ...this.box(def.kind, inst, pins), boolPins }, i];
      return;
    }
    for (const [s, j] of this.series(i, true, pre, 'none')) {
      if (!s) continue;
      const act = this.action(def, name, inst, j);
      if (!act) continue;
      yield* this.boolInputs(
        def,
        inst,
        rest,
        act.end,
        pre,
        { ...pins, ...act.pins },
        { ...boolPins, [name]: this.list(s) },
      );
    }
    yield* this.boolInputs(def, inst, rest, i, pre, pins, boolPins);
  }

  private action(
    def: BoxDef,
    name: string,
    inst: string,
    i: number,
  ): { end: number; pins: Record<string, string> } | undefined {
    if ((def.group === 'timer' || def.group === 'counter') && name === 'S') {
      const v = this.arg(i, 'L');
      const fn = def.group === 'timer' ? def.awl! : 'S';
      if (!v || this.arg(i + 1, fn) !== inst) return undefined;
      return { end: i + 2, pins: { [def.group === 'timer' ? 'TV' : 'PV']: v } };
    }
    return this.arg(i, name) === inst ? { end: i + 1, pins: {} } : undefined;
  }

  /** Uscite di dati collegate: `L`/`LC istanza; T pin`, ognuna c'è o manca. */
  private *flowOutputs(
    def: BoxDef,
    inst: string,
    i: number,
    pins: Record<string, string>,
    from = 0,
  ): Gen<Record<string, string>> {
    const o = def.outputs.slice(from).find((p) => p.type !== 'BOOL');
    if (!o) {
      yield [pins, i];
      return;
    }
    const next = def.outputs.indexOf(o) + 1;
    const to = this.arg(i, o.name.includes('BCD') ? 'LC' : 'L') === inst && this.arg(i + 1, 'T');
    if (to) yield* this.flowOutputs(def, inst, i + 2, { ...pins, [o.name]: to }, next);
    yield* this.flowOutputs(def, inst, i, pins, next);
  }
}

function timerKind(fn: TimerFn): BoxKind {
  return ({ SP: 'S_PULSE', SE: 'S_PEXT', SD: 'S_ODT', SS: 'S_ODTS', SF: 'S_OFFDT' } as const)[fn];
}

/**
 * Converte la sorgente AWL di un segmento in una rete KOP/FUP, solo se la traduzione della rete
 * (con le stesse `opts` del blocco: `tempEnd`, `firstLabel`, `callParams`) dà le stesse istruzioni.
 * `nextLabel` è il numero della prossima etichetta automatica dopo questo segmento.
 */
export function awlToLad(source: string, opts: AwlToLadOpts): AwlToLadResult {
  const input = tokensOf(source);
  if (!input) return { ok: false, reason: { code: 'SYNTAX' } };
  if (input.length === 0) return { ok: false, reason: { code: 'EMPTY' } };
  if (input.length > MAX_INSTRUCTIONS) return { ok: false, reason: { code: 'TOO_COMPLEX' } };
  const foreign = opts.foreignLabels ?? new Set<string>();
  const p = new Parser(structuredClone(input), opts.newId, opts.foreignLocals ?? new Set());
  let tried = 0;
  try {
    for (const [network] of p.network()) {
      if (++tried > MAX_CANDIDATES) break;
      let r;
      try {
        r = networkToAwl(network, opts);
      } catch {
        continue; // candidata che viola un invariante della traduzione
      }
      if (r.diagnostics.length > 0) continue;
      const back = tokensOf(r.source);
      if (back && sameCode(input, back, foreign))
        return { ok: true, network, nextLabel: r.nextLabel };
    }
  } catch (e) {
    if (!(e instanceof Budget)) throw e;
    return { ok: false, reason: { code: 'TOO_COMPLEX' } };
  }
  if (tried > MAX_CANDIDATES) return { ok: false, reason: { code: 'TOO_COMPLEX' } };
  return { ok: false, reason: { code: 'SHAPE', line: input[p.far]?.line ?? 1 } };
}

/**
 * Converte i segmenti di un blocco tutto AWL, con le etichette automatiche che crescono nel blocco
 * come in `blockToAwl`; le etichette di ogni segmento sono «estranee» per gli altri.
 */
export function blockAwlToLad(
  sources: string[],
  opts: Omit<AwlToLadOpts, 'firstLabel' | 'foreignLabels' | 'foreignLocals'>,
): AwlToLadResult[] {
  const labels = sources.map(awlLabels);
  const locals = sources.map(awlLocalBytes);
  const others = <T>(all: Set<T>[], i: number) =>
    new Set(all.flatMap((l, k) => (k === i ? [] : [...l])));
  let firstLabel = 1;
  return sources.map((s, i) => {
    const r = awlToLad(s, {
      ...opts,
      firstLabel,
      foreignLabels: others(labels, i),
      foreignLocals: others(locals, i),
    });
    if (r.ok) firstLabel = r.nextLabel;
    return r;
  });
}
