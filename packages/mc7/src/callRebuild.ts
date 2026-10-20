import {
  checkBlockCode,
  parseNetwork,
  type AwlBlockInfo,
  type AwlContext,
  type AwlDiagnostic,
  type AwlInterface,
  type Operand,
  type Statement,
} from '@baaportal/awl';
import type { DataType, FbSections, TypedMember } from '@baaportal/s7-types';
import { expandCall } from './callExpand';
import { codeEnvironment, toolsOf, type CodeEnvironment } from './codeEnv';
import type { CompiledStatement } from './encode';
import { generatedNames } from './layout';
import { encodeInstruction, type DecodedStatement } from './opcodes';
import {
  NO_RANGE,
  address,
  blockRef,
  constant,
  formatOperand,
  parseOffset,
  parsePointer,
  pointerText,
  timerCounter,
} from './operands';
import {
  formalParam,
  instanceLayout,
  locate,
  sizeOf,
  type NamedLayout,
  type Sections,
} from './resolveSymbols';
import type { SsbElement, SsbInterface, SsbSection } from './ssb';

/**
 * Ricostruzione delle `CALL` nella decodifica (mc7 §2.5, §6.3).
 *
 * Nei blocchi reali una `CALL` è la sequenza `BLD n` … `BLD n+1` che il compilatore ha espanso; per
 * le FC/SFC con parametri il cuore è un `UC` con la lista dei puntatori, che il testo AWL non porta
 * (grezzo). Se l'interfaccia del chiamato è nota (`resolveCallee`), la sequenza si rilegge come
 * `CALL … (par := attuale, …)` e si **verifica**: l'espansione del compilatore di quella CALL
 * (`callExpand.ts`, stesso ambiente di `compile.ts`: stessa base dei temporanei calcolata sul testo
 * con le CALL ricostruite, stessi AR2 e registri DB/DI) deve ridare esattamente i byte originali, e
 * il controllo AWL non deve dare errori sulla riga. Altrimenti la sequenza resta com'era (espansa,
 * col grezzo). La base dipende da tutto il blocco: le CALL scartate rientrano nel testo e la
 * verifica si ripete finché nessuna cambia.
 *
 * Parametri attuali (forma AWL che il compilatore accetta): costanti; indirizzi assoluti (`%MW2`,
 * `%LW34`, `%DB33.DBD80` qualificato); `P#…` per ANY e POINTER costruiti nei temporanei; il nome
 * generato del temporaneo ANY/POINTER del chiamante passato direttamente (`#TEMP24`); i formali del
 * chiamante FC (`#PARn`) e i suoi dati d'istanza se FB (`#STAT0`, nome generato); `%T5`, `%DB1`
 * per TIMER, COUNTER, BLOCK. Una multi-istanza è `CALL #STATk` col nome generato del membro.
 */

export type CalleeKind = 'FC' | 'FB' | 'SFC' | 'SFB';

/** Interfaccia di un blocco chiamato: sezioni e, se noti, nomi che sostituiscono quelli dei membri. */
export interface CalleeInterface {
  sections: Record<SsbSection, TypedMember[]>;
  names?: Partial<Record<SsbSection, string[]>>;
}

export type ResolveCallee = (kind: CalleeKind, number: number) => CalleeInterface | undefined;

/** Un'istruzione della decodifica (`decode.ts`): offset nella rete, byte, istruzione, grezza. */
export interface CodeItem {
  start: number;
  bytes: Uint8Array;
  stmt?: DecodedStatement;
  raw: boolean;
}

/** CALL ricostruita al posto delle istruzioni `from`…`to` (comprese) della rete `network` (da 0). */
export interface RebuiltCall {
  network: number;
  from: number;
  to: number;
  /** La riga AWL, senza tabulazione né `;`. */
  text: string;
  /** I byte originali della sequenza. */
  bytes: Uint8Array;
  /** CALL di FB/SFB con DB: il DB di istanza e il chiamato (per il controllo AWL). */
  instance?: { db: number; callee: string };
}

export interface RebuildInput {
  nets: { base: number; items: CodeItem[] }[];
  /** Offset assoluti delle istruzioni che sono destinazione di un salto. */
  targets: ReadonlySet<number>;
  /** Testo delle reti con queste CALL al posto delle loro sequenze. */
  render: (calls: readonly RebuiltCall[]) => string[];
  resolveCallee: ResolveCallee;
  /** Il blocco che contiene il codice. */
  caller: { kind: 'OB' | 'FB' | 'FC'; iface: SsbInterface };
}

const SECTION_FIELD = { in: 'input', out: 'output', inOut: 'inOut', stat: 'static' } as const;

/**
 * Sezioni di un'interfaccia letta dall'SSB, coi nomi generati (`IN0`, `STAT1`, `TEMP24`…, come
 * l'importazione del progetto; RET_VAL `RET_VAL`) e le strutture delle multi-istanze (`FB<n>`).
 * Con `formalNames` i parametri di una FC si chiamano `PAR<n>` come i formali `#PARn` del testo
 * decodificato: n = posizione nella lista IN, RET_VAL, OUT, IN_OUT. Lancia sui tipi grezzi.
 */
export function sectionsFromSsb(
  iface: SsbInterface,
  opts: { formalNames?: boolean } = {},
): { sections: Sections; fbTypes: Map<string, FbSections> } {
  const fbTypes = new Map<string, FbSections>();
  const members = (els: SsbElement[], path: string): TypedMember[] => {
    const names = generatedNames(els);
    return els.map((e, i) => ({ name: names[i]!, type: typeOf(e, `${path}.${names[i]}`) }));
  };
  const typeOf = (e: SsbElement, path: string): DataType => {
    const t = e.type;
    if (t.kind === 'raw') throw new Error(`${path}: tipo grezzo 0x${t.code.toString(16)}`);
    if (t.kind === 'struct') return { kind: 'struct', members: members(e.children ?? [], path) };
    if (t.kind === 'array') {
      const el = e.children?.[0];
      if (!el) throw new Error(`${path}: ARRAY senza elemento`);
      return { kind: 'array', dims: t.dims, element: typeOf(el, path) };
    }
    if (t.kind === 'named' && !fbTypes.has(t.name)) {
      const inner = e.children?.[0]?.children ?? [];
      const names = generatedNames(inner);
      const f: FbSections = { input: [], output: [], inOut: [], static: [] };
      inner.forEach((c, i) => {
        if (c.section === 'temp' || c.section === 'ret') return;
        f[SECTION_FIELD[c.section]].push({
          name: names[i]!,
          type: typeOf(c, `${path}.${names[i]}`),
        });
      });
      fbTypes.set(t.name, f);
    }
    return t;
  };
  const els = iface.elements;
  const names = generatedNames(els);
  const isRet = (e: SsbElement): boolean => e.section === 'ret' && e.type.kind !== 'void';
  const pick = (sec: SsbSection): number[] =>
    els.flatMap((e, i) => (e.section === sec && (sec !== 'ret' || isRet(e)) ? [i] : []));
  const order = opts.formalNames
    ? [...pick('in'), ...pick('ret'), ...pick('out'), ...pick('inOut')]
    : [];
  const sections: Sections = { in: [], out: [], inOut: [], stat: [], temp: [], ret: [] };
  els.forEach((e, i) => {
    if (e.section === 'ret' && !isRet(e)) return;
    const k = order.indexOf(i);
    const name = k >= 0 ? `PAR${k}` : e.section === 'ret' ? 'RET_VAL' : names[i]!;
    sections[e.section].push({ name, type: typeOf(e, name) });
  });
  return { sections, fbTypes };
}

// ---------------------------------------------------------------------------------------------
// Lettura delle sequenze

const CALL_OPEN = new Set([1, 3, 7, 9, 14, 16]);
const bldOf = (it: CodeItem): number | undefined =>
  !it.raw && it.stmt?.id === 'BLD' && it.bytes.length === 2 && it.bytes[0] === 0x10
    ? it.bytes[1]
    : undefined;

interface Op {
  id: string;
  op?: Operand;
}
const local = (name: string): Operand => ({
  kind: 'local',
  path: [{ name, quoted: false, range: NO_RANGE }],
  range: NO_RANGE,
});
const opOf = (s: DecodedStatement): Op =>
  s.formal
    ? { id: s.id, op: local(s.formal.name) }
    : { id: s.id, ...(s.operand ? { op: s.operand } : {}) };

type Addr = Extract<Operand, { kind: 'address' }>;
const plain = (op: Operand | undefined, area: string): Addr | undefined =>
  op?.kind === 'address' && op.area === area && op.db === undefined && !op.dbSymbol
    ? op
    : undefined;
const bitOf = (a: { byte: number; bit?: number }): number => a.byte * 8 + (a.bit ?? 0);
const sameOp = (a: Operand, b: Operand): boolean => formatOperand(a) === formatOperand(b);
/** `[AR2,P#o]` di DI: la posizione in bit e la dimensione. */
function viaAr2(op: Operand | undefined): { bit: number; size: string | null } | undefined {
  if (op?.kind !== 'indirect' || op.area !== 'DI' || op.via.kind !== 'register' || op.via.ar !== 2)
    return undefined;
  const bit = parseOffset(op.via.offset);
  return bit === undefined ? undefined : { bit, size: op.size };
}

interface Move {
  v: Operand;
  bool: boolean;
  n: number;
}
/** Lettura: `SET`/`CLR`, `L x`, `A x`, con `OPN DB n` davanti per un accesso qualificato. */
function readAt(ops: readonly Op[], i: number): Move | undefined {
  const o = ops[i];
  if (!o) return undefined;
  if (o.id === 'SET' || o.id === 'CLR') {
    return { v: constant(o.id === 'SET' ? 'TRUE' : 'FALSE'), bool: true, n: 1 };
  }
  if (o.id === 'OPN' && o.op?.kind === 'block' && o.op.blockKind === 'DB') {
    const r = readAt(ops, i + 1);
    const a = r && r.n === 1 ? plain(r.v, 'DB') : undefined;
    return a ? { v: { ...a, db: o.op.number }, bool: r!.bool, n: 2 } : undefined;
  }
  return (o.id === 'L' || o.id === 'A') && o.op ? { v: o.op, bool: o.id === 'A', n: 1 } : undefined;
}
/** Scrittura: `T x`, `= x`, con `OPN DB n` davanti per un accesso qualificato. */
function writeAt(ops: readonly Op[], i: number): Move | undefined {
  const o = ops[i];
  if (!o) return undefined;
  if (o.id === 'OPN' && o.op?.kind === 'block' && o.op.blockKind === 'DB') {
    const w = writeAt(ops, i + 1);
    const a = w && w.n === 1 ? plain(w.v, 'DB') : undefined;
    return a ? { v: { ...a, db: o.op.number }, bool: w!.bool, n: 2 } : undefined;
  }
  return (o.id === 'T' || o.id === '=') && o.op ? { v: o.op, bool: o.id === '=', n: 1 } : undefined;
}

interface Copy {
  src: Operand;
  dst: Operand;
}
/** Una sequenza di sole copie (lettura + scrittura), o undefined. */
function copies(ops: readonly Op[]): Copy[] | undefined {
  const out: Copy[] = [];
  for (let i = 0; i < ops.length;) {
    const r = readAt(ops, i);
    const w = r && writeAt(ops, i + r.n);
    if (!r || !w || w.bool !== r.bool) return undefined;
    out.push({ src: r.v, dst: w.v });
    i += r.n + w.n;
  }
  return out;
}

type Dir = 'IN' | 'OUT' | 'IN_OUT';
interface Param {
  name: string;
  type: DataType;
  dir: Dir;
}
interface Assign {
  name: string;
  dir: Dir;
  value: Operand;
}

const ANY_NAMES: Record<number, string> = {
  0x01: 'BOOL',
  0x02: 'BYTE',
  0x03: 'CHAR',
  0x04: 'WORD',
  0x05: 'INT',
  0x06: 'DWORD',
  0x07: 'DINT',
  0x08: 'REAL',
  0x09: 'DATE',
  0x0a: 'TOD',
  0x0b: 'TIME',
  0x0c: 'S5TIME',
  0x0e: 'DT',
  0x13: 'STRING',
};
const AREA_OF_POINTER: Record<number, 'I' | 'Q' | 'M'> = { 0x81: 'I', 0x82: 'Q', 0x83: 'M' };
const BLOCK_PARAM: Record<string, 'FC' | 'FB' | 'DB'> = {
  Block_FC: 'FC',
  Block_FB: 'FB',
  Block_DB: 'DB',
};
const int16 = (text: string | undefined): number | undefined => {
  if (text === undefined || !/^-?\d+$/.test(text)) return undefined;
  const n = Number(text);
  return n < -0x8000 || n > 0xffff ? undefined : n & 0xffff;
};

/** Costante caricata in L byte `byte` con dimensione `size` (`L c; T L… byte`). */
function constAt(before: readonly Copy[], byte: number, size: 'W' | 'D'): string | undefined {
  const c = before.find((x) => {
    const a = plain(x.dst, 'L');
    return a && a.size === size && a.byte === byte && x.src.kind === 'constant';
  });
  return c?.src.kind === 'constant' ? c.src.text : undefined;
}
/** `P#DB100.DBX 0.0` (puntatore a 6 byte in L) o, con `any`, `… BYTE 400` (ANY a 10 byte). */
function builtPointer(before: readonly Copy[], byte: number, any: boolean): string | undefined {
  let at = byte;
  let suffix = '';
  if (any) {
    const head = /^W#16#10([0-9A-F]{2})$/i.exec(constAt(before, at, 'W') ?? '');
    const type = head ? ANY_NAMES[parseInt(head[1]!, 16)] : undefined;
    const count = int16(constAt(before, at + 2, 'W'));
    if (!type || count === undefined) return undefined;
    suffix = ` ${type} ${count}`;
    at += 4;
  }
  const db = int16(constAt(before, at, 'W'));
  const ptr = parsePointer(constAt(before, at + 2, 'D') ?? '');
  const text = ptr && ptr[0] !== 0 ? pointerText(ptr) : undefined;
  if (db === undefined || !text) return undefined;
  return `P#${db ? `DB${db}.` : ''}${text.slice(2)}${suffix}`;
}

interface CallerView {
  sections: Sections;
  env: CodeEnvironment['env'];
}

/** Il dato d'istanza del chiamante FB in `[AR2,P#o]` (membro di primo livello), come `#nome`. */
function instanceName(op: Operand, caller: CallerView): Operand {
  const at = viaAr2(op);
  const lay = caller.env.instance;
  if (!at || !lay) return op;
  const s = caller.sections;
  for (const m of [...s.in, ...s.out, ...s.inOut, ...s.stat]) {
    try {
      const r = locate(lay, [{ name: m.name, quoted: false, range: NO_RANGE }], m.name);
      if (r.bit === at.bit && sizeOf(r.type) === at.size) return local(m.name);
    } catch {
      /* membro senza layout */
    }
  }
  return op;
}

/** Il temporaneo ANY/POINTER del chiamante che comincia in `bit`. */
function tempAt(bit: number, kind: 'Any' | 'Pointer', caller: CallerView): string | undefined {
  for (const m of caller.sections.temp) {
    if (m.type.kind !== 'parameter' || m.type.name !== kind) continue;
    try {
      const r = locate(caller.env.temp, [{ name: m.name, quoted: false, range: NO_RANGE }], m.name);
      if (r.bit === bit) return m.name;
    } catch {
      /* membro senza layout */
    }
  }
  return undefined;
}

const lAddr = (size: 'X' | 'B' | 'W' | 'D', bit: number): Operand | undefined =>
  size !== 'X' && bit % 8 !== 0
    ? undefined
    : address('L', size, bit >> 3, size === 'X' ? bit & 7 : undefined);

/** Parametri di FC/SFC: lista dei puntatori → attuali (schema FC di `callExpand.ts`). */
function fcAssigns(
  inner: readonly Op[],
  call: number,
  params: readonly Param[],
  pointers: readonly Uint8Array[],
  caller: CallerView,
): Assign[] | undefined {
  let pre = inner.slice(0, call);
  let post = inner.slice(call + 1);
  if (pre[0]?.id === '=' && plain(pre[0].op, 'L')?.size === 'X') pre = pre.slice(1);
  if (pre[0]?.id === 'TAR2' && plain(pre[0].op, 'L')?.size === 'D') pre = pre.slice(1);
  if (post[0]?.id === 'LAR2' && plain(post[0].op, 'L')?.size === 'D') post = post.slice(1);
  const before = copies(pre);
  const after = copies(post);
  if (!before || !after || pointers.length !== params.length) return undefined;
  const out: Assign[] = [];
  for (const [k, p] of params.entries()) {
    const ptr = pointers[k]!;
    const pos = (ptr[1]! << 16) | (ptr[2]! << 8) | ptr[3]!;
    const t = p.type;
    let value: Operand | undefined;
    // TIMER, COUNTER e BLOCK passano un numero: mai un byte d'area (80…87) in testa
    if (t.kind === 'parameter' && (t.name === 'Timer' || t.name === 'Counter')) {
      if (ptr[0]! >= 0x80 || ptr[2] || ptr[3]) return undefined;
      value = timerCounter(t.name === 'Timer' ? 'T' : 'C', (ptr[0]! << 8) | ptr[1]!);
    } else if (t.kind === 'parameter' && BLOCK_PARAM[t.name]) {
      if (ptr[0]! >= 0x80 || ptr[2] || ptr[3]) return undefined;
      value = blockRef(BLOCK_PARAM[t.name]!, (ptr[0]! << 8) | ptr[1]!);
    } else if (sizeOf(t)) {
      const size = sizeOf(t)!;
      if (ptr[0] === 0x87) {
        const slot = (op: Operand): boolean => {
          const a = plain(op, 'L');
          return !!a && a.size === size && bitOf(a) === pos;
        };
        const b = before.filter((c) => slot(c.dst));
        const a = after.filter((c) => slot(c.src));
        if (b.length > 1 || a.length > 1) return undefined;
        if (!b.length && !a.length) value = lAddr(size, pos);
        else if (p.dir === 'IN' && b.length && !a.length) value = b[0]!.src;
        else if (p.dir === 'OUT' && a.length && !b.length) value = a[0]!.dst;
        else if (p.dir === 'IN_OUT' && b.length && a.length && sameOp(b[0]!.src, a[0]!.dst))
          value = b[0]!.src;
      } else {
        const area =
          AREA_OF_POINTER[ptr[0]!] ??
          (ptr[0] === 0x80 ? (p.dir === 'IN' ? 'PI' : 'PQ') : undefined);
        if (area && (size === 'X' || pos % 8 === 0)) {
          value = address(area, size, pos >> 3, size === 'X' ? pos & 7 : undefined);
        }
      }
    } else if (t.kind === 'parameter' && (t.name === 'Any' || t.name === 'Pointer')) {
      if (ptr[0] !== 0x87) return undefined;
      const built = pos % 8 === 0 ? builtPointer(before, pos >> 3, t.name === 'Any') : undefined;
      const temp = built ? undefined : tempAt(pos, t.name, caller);
      value = built ? constant(built) : temp ? local(temp) : undefined;
    }
    if (!value) return undefined;
    out.push({ name: p.name, dir: p.dir, value: instanceName(value, caller) });
  }
  return out;
}

interface Member {
  name: string;
  dir: Dir;
  bit: number;
  type: DataType;
}
/** IN, OUT, IN_OUT di un FB/SFB con la posizione nell'istanza. */
function membersOf(info: AwlBlockInfo, lay: NamedLayout): Member[] | undefined {
  const i = info.iface!;
  const out: Member[] = [];
  const add = (list: TypedMember[], dir: Dir): boolean =>
    list.every((m) => {
      try {
        const r = locate(lay, [{ name: m.name, quoted: false, range: NO_RANGE }], m.name);
        out.push({ name: m.name, dir, bit: r.bit, type: m.type });
        return true;
      } catch {
        return false;
      }
    });
  return add(i.input, 'IN') && add(i.output, 'OUT') && add(i.inOut, 'IN_OUT') ? out : undefined;
}

/**
 * Copie verso e dall'istanza → attuali. `at(op)` dà la posizione nell'istanza di un operando DI;
 * `stageIn`/`stageOut` sono le copie attraverso L fuori dai CDB (DB qualificati, dati del chiamante).
 */
function instanceAssigns(
  members: readonly Member[],
  before: readonly Copy[],
  after: readonly Copy[],
  at: (op: Operand) => { bit: number; size: string | null } | undefined,
  caller: CallerView,
  stageIn: readonly Copy[] = [],
  stageOut: readonly Copy[] = [],
): Assign[] | undefined {
  const target = (op: Operand, m: Member, size: string): boolean => {
    const a = at(op);
    return !!a && a.bit === m.bit && a.size === size;
  };
  const staged = (op: Operand, list: readonly Copy[], from: 'dst' | 'src'): Operand => {
    const hit = plain(op, 'L') ? list.find((c) => sameOp(c[from], op)) : undefined;
    return hit ? hit[from === 'dst' ? 'src' : 'dst'] : op;
  };
  let used = 0;
  const out: Assign[] = [];
  for (const m of members) {
    const t = m.type;
    const numeric =
      t.kind === 'parameter' && (t.name === 'Timer' || t.name === 'Counter' || BLOCK_PARAM[t.name]);
    const size = numeric ? 'W' : sizeOf(t);
    if (!size) continue;
    const b = before.filter((c) => target(c.dst, m, size));
    const a = after.filter((c) => target(c.src, m, size));
    if (b.length > 1 || a.length > 1) return undefined;
    if (!b.length && !a.length) continue; // non assegnato: tiene il valore dell'istanza
    used += b.length + a.length;
    let value: Operand | undefined;
    if (m.dir === 'IN' && b.length && !a.length) value = staged(b[0]!.src, stageIn, 'dst');
    else if (m.dir === 'OUT' && a.length && !b.length) value = staged(a[0]!.dst, stageOut, 'src');
    else if (m.dir === 'IN_OUT' && b.length && a.length) {
      const i = staged(b[0]!.src, stageIn, 'dst');
      const o = staged(a[0]!.dst, stageOut, 'src');
      if (sameOp(i, o)) value = i;
    }
    if (!value) return undefined;
    if (numeric) {
      const n = value.kind === 'constant' ? int16(value.text) : undefined;
      if (n === undefined || t.kind !== 'parameter') return undefined;
      value =
        t.name === 'Timer' || t.name === 'Counter'
          ? timerCounter(t.name === 'Timer' ? 'T' : 'C', n)
          : blockRef(BLOCK_PARAM[t.name]!, n);
    }
    out.push({ name: m.name, dir: m.dir, value: instanceName(value, caller) });
  }
  return used === before.length + after.length ? out : undefined;
}

/** Parametri di FB/SFB con DB di istanza (schema FB di `callExpand.ts`). */
function fbAssigns(
  inner: readonly Op[],
  call: number,
  members: readonly Member[],
  caller: CallerView,
): { db: number; assigns: Assign[] } | undefined {
  const pre = inner.slice(0, call);
  const post = inner.slice(call + 1);
  const i = pre[0]?.id === '=' && plain(pre[0].op, 'L')?.size === 'X' ? 1 : 0;
  const cdb = pre.findIndex((o, k) => k >= i && o.id === 'CDB');
  const opn = pre[cdb + 1];
  const last = pre[pre.length - 1];
  if (
    cdb < 0 ||
    opn?.id !== 'OPN' ||
    opn.op?.kind !== 'block' ||
    opn.op.blockKind !== 'DI' ||
    pre[cdb + 2]?.id !== 'TAR2' ||
    plain(pre[cdb + 2]!.op, 'L')?.size !== 'D' ||
    last?.id !== 'LAR2' ||
    last.op?.kind !== 'constant' ||
    last.op.text.replace(/\s+/g, '').toUpperCase() !== 'P#DBX0.0' ||
    post[0]?.id !== 'LAR2' ||
    plain(post[0].op, 'L')?.size !== 'D'
  ) {
    return undefined;
  }
  const cdb2 = post.findIndex((o, k) => k >= 1 && o.id === 'CDB');
  if (cdb2 < 0) return undefined;
  const stageIn = copies(pre.slice(i, cdb));
  const before = copies(pre.slice(cdb + 3, pre.length - 1));
  const after = copies(post.slice(1, cdb2));
  const stageOut = copies(post.slice(cdb2 + 1));
  if (!stageIn || !before || !after || !stageOut) return undefined;
  const at = (op: Operand) => {
    const a = plain(op, 'DI');
    return a ? { bit: bitOf(a), size: a.size } : undefined;
  };
  const assigns = instanceAssigns(members, before, after, at, caller, stageIn, stageOut);
  return assigns ? { db: opn.op.number, assigns } : undefined;
}

/** Multi-istanza (schema multi-istanza di `callExpand.ts`): posizione nell'istanza e attuali. */
function multiAssigns(
  inner: readonly Op[],
  call: number,
  members: readonly Member[],
  caller: CallerView,
): { at: number; assigns: Assign[] } | undefined {
  const pre = inner.slice(0, call);
  const post = inner.slice(call + 1);
  let i = pre[0]?.id === '=' && plain(pre[0].op, 'L')?.size === 'X' ? 1 : 0;
  const ar2 = pre[i]?.id === 'TAR2' ? plain(pre[i]!.op, 'L') : undefined;
  if (!ar2 || ar2.size !== 'D') return undefined;
  i++;
  const n = pre.length;
  const load = pre[n - 4];
  const off = pre[n - 3];
  const x = off?.id === 'L' && off.op?.kind === 'constant' ? parseOffset(off.op.text) : undefined;
  if (
    n - 4 < i ||
    load?.id !== 'L' ||
    !load.op ||
    !sameOp(load.op, ar2) ||
    x === undefined ||
    pre[n - 2]?.id !== '+D' ||
    pre[n - 1]?.id !== 'LAR2' ||
    pre[n - 1]!.op !== undefined ||
    post[0]?.id !== 'LAR2' ||
    !post[0].op ||
    !sameOp(post[0].op, ar2)
  ) {
    return undefined;
  }
  const before = copies(pre.slice(i, n - 4));
  const after = copies(post.slice(1));
  if (!before || !after) return undefined;
  const at = (op: Operand) => {
    const a = viaAr2(op);
    return a && a.bit >= x ? { bit: a.bit - x, size: a.size } : undefined;
  };
  const assigns = instanceAssigns(members, before, after, at, caller);
  return assigns ? { at: x, assigns } : undefined;
}

/** La multi-istanza del chiamante (membro STAT di primo livello) in `bit` di tipo FB/SFB n. */
function multiName(
  bit: number,
  kind: string,
  number: number,
  caller: CallerView,
): string | undefined {
  const lay = caller.env.instance;
  if (!lay) return undefined;
  for (const m of caller.sections.stat) {
    if (m.type.kind !== 'named' || m.type.name.toUpperCase() !== `${kind}${number}`) continue;
    try {
      if (locate(lay, [{ name: m.name, quoted: false, range: NO_RANGE }], m.name).bit === bit)
        return m.name;
    } catch {
      /* membro senza layout */
    }
  }
  return undefined;
}

function callText(head: string, assigns: readonly Assign[]): string {
  const params = assigns.map(
    (a) => `${a.name} ${a.dir === 'OUT' ? '=>' : ':='} ${formatOperand(a.value)}`,
  );
  return `CALL ${head}${params.length ? ` (${params.join(', ')})` : ''}`;
}

// ---------------------------------------------------------------------------------------------

function calleeInfo(kind: CalleeKind, number: number, ci: CalleeInterface): AwlBlockInfo {
  const named = (sec: SsbSection): TypedMember[] =>
    ci.sections[sec].map((m, i) => ({ name: ci.names?.[sec]?.[i] ?? m.name, type: m.type }));
  const ret = named('ret').find((m) => m.type.kind !== 'void');
  const fcLike = kind === 'FC' || kind === 'SFC';
  const iface: AwlInterface = {
    input: named('in'),
    output: named('out'),
    inOut: named('inOut'),
    static: named('stat'),
    temp: [],
    returnType: ret ? ret.type : fcLike ? { kind: 'void' } : null,
  };
  return { name: `${kind}${number}`, kind, number, iface };
}

const BLOCK_NAME = /^(FC|FB|SFC|SFB)(\d+)$/i;

/** Le CALL ricostruite e verificate al byte (vuoto se il chiamante o i chiamati non hanno layout). */
export function rebuildCalls(input: RebuildInput): RebuiltCall[] {
  const { caller, resolveCallee } = input;
  let sections: Sections;
  let fbTypes: Map<string, FbSections>;
  try {
    ({ sections, fbTypes } = sectionsFromSsb(caller.iface, { formalNames: caller.kind === 'FC' }));
  } catch {
    return [];
  }
  const infos = new Map<string, AwlBlockInfo | undefined>();
  const callee = (kind: CalleeKind, number: number): AwlBlockInfo | undefined => {
    const key = `${kind}${number}`;
    if (!infos.has(key)) {
      let ci: CalleeInterface | undefined;
      try {
        ci = resolveCallee(kind, number);
      } catch {
        ci = undefined; // un risolutore che fallisce vale "chiamato sconosciuto"
      }
      infos.set(key, ci ? calleeInfo(kind, number, ci) : undefined);
    }
    return infos.get(key);
  };
  const instanceOf = new Map<number, string>();
  const ctx: AwlContext = {
    owner: {
      kind: caller.kind,
      iface: {
        input: sections.in,
        // RET_VAL di una FC è `#PARn` nel testo decodificato: per il controllo AWL è un'uscita
        output: [...sections.out, ...(caller.kind === 'FC' ? sections.ret : [])],
        inOut: sections.inOut,
        static: sections.stat,
        temp: sections.temp,
        returnType: caller.kind === 'FC' ? (sections.ret[0]?.type ?? { kind: 'void' }) : null,
      },
    },
    symbol: () => undefined,
    block: (ref) => {
      if ('name' in ref) {
        const m = BLOCK_NAME.exec(ref.name);
        return m ? callee(m[1]!.toUpperCase() as CalleeKind, Number(m[2])) : undefined;
      }
      if (ref.kind === 'IDB') {
        const fb = instanceOf.get(ref.number);
        return fb
          ? { name: `DB${ref.number}`, kind: 'IDB', number: ref.number, instanceOf: fb }
          : undefined;
      }
      return ref.kind === 'FC' || ref.kind === 'FB' || ref.kind === 'SFC' || ref.kind === 'SFB'
        ? callee(ref.kind, ref.number)
        : undefined;
    },
    resolve: (name) => {
      // Layout del chiamante: prima la struttura reale della multi-istanza nel suo SSB. Quella
      // dell'interfaccia nota può essere diversa, e per un SFB del catalogo è incompleta (solo i
      // parametri documentati, non i dati statici interni).
      const f = fbTypes.get(name);
      if (f) return { kind: 'fb', sections: f };
      const m = /^(FB|SFB)(\d+)$/i.exec(name);
      const info = m ? callee(m[1]!.toUpperCase() as CalleeKind, Number(m[2])) : undefined;
      if (info?.iface) {
        const i = info.iface;
        return {
          kind: 'fb',
          sections: { input: i.input, output: i.output, inOut: i.inOut, static: i.static },
        };
      }
      return null;
    },
    allSymbols: () => [],
    allBlocks: () => [],
  };
  let view: CallerView;
  try {
    view = { sections, env: codeEnvironment(caller.kind, sections, ctx, []).env };
  } catch {
    return [];
  }

  // Candidati: ogni BLD n … BLD n+1 della stessa rete che si rilegge come CALL
  const tools = toolsOf(ctx);
  const candidates: RebuiltCall[] = [];
  input.nets.forEach((net, k) => {
    const items = net.items;
    for (let i = 0; i < items.length; i++) {
      const open = bldOf(items[i]!);
      if (open === undefined || !CALL_OPEN.has(open)) continue;
      let j = i + 1;
      while (j < items.length) {
        const m = bldOf(items[j]!);
        if (m === open + 1 || (m !== undefined && CALL_OPEN.has(m))) break;
        j++;
      }
      if (j >= items.length || bldOf(items[j]!) !== open + 1) continue;
      const c = candidate(k, net.base, items, i, j, open);
      if (c) candidates.push(c);
      i = j;
    }
  });

  function candidate(
    network: number,
    base: number,
    items: readonly CodeItem[],
    from: number,
    to: number,
    open: number,
  ): RebuiltCall | undefined {
    const span = items.slice(from + 1, to);
    // nessun salto dentro né destinazione dopo il BLD di apertura; grezzo solo l'UC con i puntatori
    for (let k = from; k <= to; k++) {
      const it = items[k]!;
      if (it.stmt?.jumpTo !== undefined) return undefined;
      if (k > from && input.targets.has(base + it.start)) return undefined;
    }
    const calls = span.flatMap((it, k) => (it.stmt?.id === 'UC' ? [k] : []));
    if (calls.length !== 1) return undefined;
    const call = calls[0]!;
    const uc = span[call]!.stmt!;
    if (span.some((it, k) => !it.stmt || (it.raw && k !== call))) return undefined;
    const target = uc.operand;
    if (target?.kind !== 'block' || uc.indirectBlock) return undefined;
    const kind = target.blockKind;
    if (kind !== 'FC' && kind !== 'FB' && kind !== 'SFC' && kind !== 'SFB') return undefined;
    const fcLike = kind === 'FC' || kind === 'SFC';
    const expected = fcLike ? (kind === 'FC' ? 1 : 7) : undefined;
    if (expected !== undefined && open !== expected) return undefined;
    const info = callee(kind, target.number);
    if (!info?.iface) return undefined;
    const inner = span.map((it) => opOf(it.stmt!));
    const bytes = Uint8Array.from(items.slice(from, to + 1).flatMap((it) => [...it.bytes]));
    const head = formatOperand(blockRef(kind, target.number));
    if (fcLike) {
      const i = info.iface;
      const params: Param[] = [
        ...i.input.map((m) => ({ ...m, dir: 'IN' as const })),
        ...(i.returnType && i.returnType.kind !== 'void'
          ? [{ name: 'RET_VAL', type: i.returnType, dir: 'OUT' as const }]
          : []),
        ...i.output.map((m) => ({ ...m, dir: 'OUT' as const })),
        ...i.inOut.map((m) => ({ ...m, dir: 'IN_OUT' as const })),
      ];
      const assigns = fcAssigns(inner, call, params, uc.pointers ?? [], view);
      return assigns ? { network, from, to, text: callText(head, assigns), bytes } : undefined;
    }
    let lay: NamedLayout;
    try {
      lay = instanceLayout(
        {
          in: info.iface.input,
          out: info.iface.output,
          inOut: info.iface.inOut,
          stat: info.iface.static,
          temp: [],
          ret: [],
        },
        tools,
      );
    } catch {
      return undefined;
    }
    const members = membersOf(info, lay);
    if (!members) return undefined;
    if (open === 3 || open === 9) {
      if (open !== (kind === 'FB' ? 3 : 9)) return undefined;
      const r = fbAssigns(inner, call, members, view);
      if (!r) return undefined;
      const text = callText(`${head}, ${formatOperand(blockRef('DB', r.db))}`, r.assigns);
      return { network, from, to, text, bytes, instance: { db: r.db, callee: info.name } };
    }
    if (open !== (kind === 'FB' ? 14 : 16)) return undefined;
    const r = multiAssigns(inner, call, members, view);
    const name = r && multiName(r.at, kind, target.number, view);
    return r && name
      ? { network, from, to, text: callText(`#${name}`, r.assigns), bytes }
      : undefined;
  }

  // Verifica al byte, ripetuta finché nessuna CALL viene scartata (la base dipende dal testo)
  let accepted = candidates;
  while (accepted.length > 0) {
    const texts = input.render(accepted);
    const parsed = texts.map((t) => parseNetwork(t, 'international').statements);
    let ce: CodeEnvironment;
    try {
      ce = codeEnvironment(caller.kind, sections, ctx, parsed);
    } catch {
      return [];
    }
    instanceOf.clear();
    for (const c of accepted) if (c.instance) instanceOf.set(c.instance.db, c.instance.callee);
    const errors = checkBlockCode(texts, ctx, 'international').filter(
      (d) => d.severity === 'error',
    );
    // Le CALL del testo di una rete sono, in ordine, le sue CALL ricostruite
    const callsOf = parsed.map((sts) => sts.filter((s) => s.instruction.def?.id === 'CALL'));
    const seen = parsed.map(() => 0);
    const keep = accepted.filter((c) => {
      const st = callsOf[c.network]![seen[c.network]!++];
      return st !== undefined && verify(c, st, ce, errors);
    });
    if (keep.length === accepted.length) return accepted;
    accepted = keep;
  }
  return [];
}

function verify(
  c: RebuiltCall,
  st: Statement,
  ce: CodeEnvironment,
  errors: readonly AwlDiagnostic[],
): boolean {
  const from = st.range.from.line;
  const to = st.range.to.line;
  if (
    errors.some(
      (d) => d.network === c.network && d.range.from.line >= from && d.range.from.line <= to,
    )
  ) {
    return false;
  }
  try {
    const x = expandCall(st, c.network + 1, ce.callEnv);
    if (!Array.isArray(x)) return false;
    const out: number[] = [];
    for (const s of x as CompiledStatement[]) {
      out.push(...encodeInstruction(s, { ...s.encode, formal: (n) => formalParam(ce.env, n) }));
    }
    return out.length === c.bytes.length && out.every((b, i) => b === c.bytes[i]);
  } catch {
    return false;
  }
}
