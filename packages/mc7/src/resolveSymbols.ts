import type {
  AddressSize,
  AreaId,
  AwlBlockInfo,
  AwlContext,
  Operand,
  PathSegment,
  Statement,
} from '@baaportal/awl';
import {
  parseAddress,
  parseLiteral,
  sameName,
  type DataType,
  type TypedMember,
  type TypeResolver,
} from '@baaportal/s7-types';
import { parseConstant } from './constants';
import { dataLayout, type LayoutOffset } from './layout';
import {
  address,
  blockRef,
  constant,
  indirectReg,
  timerCounter,
  NO_RANGE,
  type FormalParam,
  type FormalType,
} from './operands';
import { buildSsb, readSsb, type SsbElement, type SsbSection, type SsbType } from './ssb';

/**
 * Risoluzione dei simboli del compilatore (Task 7): ogni operando simbolico diventa un operando che
 * `encodeInstruction` accetta.
 *
 * | sorgente                    | risultato                                                              |
 * | --------------------------- | ---------------------------------------------------------------------- |
 * | `"Tag"`                     | l'indirizzo del tag (`ctx.symbol().address`, letto con s7-types)       |
 * | `"Tag".m` (tag composto)    | indirizzo del tag + posizione del membro nel layout del tipo           |
 * | `"Costante"`                | il valore, con la sintassi AWL del suo tipo (`L#…` per un DINT)        |
 * | `"DB".a.b`, `"DB".DBW4`     | accesso qualificato `DBn.DBx` = `OPN DB n` + accesso (mc7 §3.2)        |
 * | `"Blocco"`                  | `FC n`, `FB n`, `DB n`… (`ctx.block`)                                  |
 * | `#t` (TEMP)                 | area L al posto del layout dei TEMP (mc7 §1.4.8)                       |
 * | `#x` in un FB (IN…STAT)     | `DIx [AR2,P#offset]` come FB41/FB80: l'FB vale anche come multi-istanza |
 * | `#p` parametro di FC        | formale `#p`: `fb x wwww` con wwww = 2·(indice + 1) (mc7 §2.2.6)       |
 * | `P##x`                      | errore `P_LOCAL_UNSUPPORTED` (forme `fb ca/cb` non in tabella)         |
 *
 * L'indice di un parametro di FC segue l'ordine della lista dei puntatori: IN, RET_VAL, OUT, IN_OUT
 * (RET_VAL dopo gli ingressi come nella CALL SFC 20 reale di FC100).
 */

export type Sections = Record<SsbSection, TypedMember[]>;

/** Errore di risoluzione: codice della diagnostica e messaggio. */
export class SymbolError extends Error {
  readonly code: string;
  readonly params?: Record<string, string>;
  constructor(code: string, message: string, params?: Record<string, string>) {
    super(message);
    this.code = code;
    if (params) this.params = params;
  }
}
const fail = (code: string, message: string): never => {
  throw new SymbolError(code, message);
};

const key = (s: string): string => s.normalize('NFC').toLowerCase();

export interface LayoutTools {
  resolve: TypeResolver;
  blockNumber: (name: string) => { block: 'FB' | 'SFB'; number: number } | undefined;
}

/** Layout con i nomi veri: percorso (minuscolo, `a.b`, `v[0].c`) → voce di `dataLayout`. */
export interface NamedLayout {
  size: number;
  /** Fine dell'ultimo dato in bit, senza arrotondare (per la base dei temporanei, mc7 §6.3). */
  endBits: number;
  byPath: Map<string, LayoutOffset>;
}

const emptySections = (over: Partial<Sections> = {}): Sections => ({
  in: [],
  out: [],
  inOut: [],
  stat: [],
  temp: [],
  ret: [],
  ...over,
});

function nameType(e: SsbElement, t: DataType, tools: LayoutTools): void {
  if (t.kind === 'struct') nameMembers(e.children ?? [], t.members, tools);
  else if (t.kind === 'array' && e.children?.[0]) nameType(e.children[0], t.element, tools);
  else if (t.kind === 'named') {
    const found = tools.resolve(t.name);
    if (found?.kind === 'udt') nameMembers(e.children ?? [], found.members, tools);
    else if (found?.kind === 'fb') {
      const s = found.sections;
      nameMembers(
        e.children?.[0]?.children ?? [],
        [...s.input, ...s.output, ...s.inOut, ...s.static],
        tools,
      );
    }
  }
}
function nameMembers(els: SsbElement[], members: TypedMember[], tools: LayoutTools): void {
  els.forEach((e, i) => {
    const m = members[i];
    if (!m) return;
    e.name = m.name;
    nameType(e, m.type, tools);
  });
}

function named(i: ReturnType<typeof readSsb>, endBits: number): NamedLayout {
  const lay = dataLayout(i);
  return { size: lay.size, endBits, byPath: new Map(lay.offsets.map((o) => [key(o.path), o])) };
}

const SENTINEL = '\u0000fine';

/** Layout di membri come in una STRUCT (TEMP, DB globale, tipo di un tag), con la fine esatta. */
export function structLayout(members: TypedMember[], tools: LayoutTools): NamedLayout {
  // Un BOOL in più dopo l'ultimo membro cade esattamente sul primo bit libero.
  const all = [
    ...members,
    { name: SENTINEL, type: { kind: 'elementary', name: 'Bool' } as DataType },
  ];
  const ssb = buildSsb(emptySections({ stat: all }), {}, 'DB', tools);
  const i = readSsb(ssb, 'DB');
  nameMembers(i.elements[0]?.children ?? [], all, tools);
  const lay = named(i, 0);
  const s = lay.byPath.get(key(SENTINEL))!;
  lay.byPath.delete(key(SENTINEL));
  lay.endBits = s.byte * 8 + (s.bit ?? 0);
  return lay;
}

/** Layout dei dati d'istanza di un FB/SFB: IN, OUT, IN_OUT, STAT (mc7 §1.4.8 regola 7). */
export function instanceLayout(s: Sections, tools: LayoutTools): NamedLayout {
  const ssb = buildSsb({ ...s, temp: [], ret: [] }, {}, 'FB', tools);
  const i = readSsb(ssb, 'FB');
  nameMembers(i.elements, [...s.in, ...s.out, ...s.inOut, ...s.stat], tools);
  const lay = named(i, 0);
  lay.endBits = lay.size * 8;
  return lay;
}

/** Sezioni di un blocco chiamabile dalla sua interfaccia AWL. */
export function sectionsOf(info: AwlBlockInfo): Sections {
  const i = info.iface;
  return emptySections(
    i ? { in: i.input, out: i.output, inOut: i.inOut, stat: i.static, temp: i.temp } : {},
  );
}

/** Posizione (in bit dall'inizio dell'area) e tipo di un percorso nel layout. */
export function locate(
  lay: NamedLayout,
  segs: readonly PathSegment[],
  what: string,
): { bit: number; type: SsbType } {
  let path = '';
  let shift = 0;
  let found: { bit: number; type: SsbType } | undefined;
  for (const seg of segs) {
    path = path ? `${path}.${key(seg.name)}` : key(seg.name);
    const e = lay.byPath.get(path);
    if (!e) return fail('UNKNOWN_MEMBER', `${what}: membro ${seg.name} non trovato`);
    let bit = e.byte * 8 + (e.bit ?? 0) + shift;
    let type: SsbType = e.type;
    if (seg.index) {
      if (type.kind !== 'array' || e.strideBits === undefined) {
        return fail('UNSUPPORTED', `${what}: ${seg.name} non è un ARRAY`);
      }
      const dims = type.dims;
      if (dims.length !== seg.index.length) {
        return fail('UNSUPPORTED', `${what}: ${seg.name} ha ${dims.length} dimensioni`);
      }
      let k = 0;
      dims.forEach((d, j) => {
        const v = seg.index![j]!;
        if (v < d.lo || v > d.hi)
          fail('UNSUPPORTED', `${what}: indice ${v} fuori da ${d.lo}..${d.hi}`);
        k = k * (d.hi - d.lo + 1) + (v - d.lo);
      });
      bit += k * e.strideBits;
      shift += k * e.strideBits;
      path = `${path}[${dims.map((d) => d.lo).join(',')}]`;
      type = type.element;
    }
    found = { bit, type };
  }
  return found ?? fail('UNSUPPORTED', `${what}: percorso vuoto`);
}

const BITS_OF: Record<string, AddressSize> = {
  Bool: 'X',
  Byte: 'B',
  Char: 'B',
  Word: 'W',
  Int: 'W',
  S5Time: 'W',
  Date: 'W',
  DWord: 'D',
  DInt: 'D',
  Real: 'D',
  Time: 'D',
  Time_Of_Day: 'D',
};
/** Dimensione d'accesso di un tipo elementare; undefined per gli altri. */
export const sizeOf = (t: SsbType | undefined): AddressSize | undefined =>
  t?.kind === 'elementary' ? BITS_OF[t.name] : undefined;

const FORMAL_OF: Record<string, FormalType> = {
  Bool: 'Bool',
  Byte: 'Byte',
  Char: 'Byte',
  Word: 'Word',
  Int: 'Word',
  S5Time: 'Word',
  Date: 'Word',
  DWord: 'DWord',
  DInt: 'DWord',
  Real: 'DWord',
  Time: 'DWord',
  Time_Of_Day: 'DWord',
  Timer: 'Timer',
  Counter: 'Counter',
  Block_FB: 'Block_FB',
  Block_FC: 'Block_FC',
  Block_DB: 'Block_DB',
};
/** Forma di accesso di un parametro formale di FC (mc7 §2.2.6); undefined per i tipi complessi. */
export const formalTypeOf = (t: DataType): FormalType | undefined =>
  t.kind === 'elementary' || t.kind === 'parameter' ? FORMAL_OF[t.name] : undefined;

const WIDTH: Record<string, number> = { DWord: 4, DInt: 4, Real: 4, Time: 4, Time_Of_Day: 4 };

/**
 * Testo AWL di una costante per un dato di tipo `type`: quello scritto se `L` lo carica già nella
 * larghezza giusta (`1` per un INT, `L#400` per un DINT, come FC1), altrimenti la forma del tipo
 * (`L#400`, `W#16#FF`, `80.0`): un dato a 32 bit non si carica mai con una costante a 16 bit.
 */
export function constantFor(type: DataType | null | undefined, text: string): string {
  const t = text.trim();
  let c;
  try {
    c = parseConstant(t);
  } catch {
    c = undefined;
  }
  if (type?.kind !== 'elementary' || type.name === 'Bool') return t;
  const wide = (WIDTH[type.name] ?? 0) === 4;
  if (c && (!wide || c.op === 0x38)) return t;
  const lit = parseLiteral(type, t);
  if (!lit.ok) return fail('UNSUPPORTED', `costante ${t} non valida per ${type.name}`);
  const canon = lit.canonical;
  const prefix: Record<string, string> = { Byte: 'B#', Word: 'W#', DWord: 'DW#', DInt: 'L#' };
  const out = `${prefix[type.name] ?? ''}${canon}`;
  let back;
  try {
    back = parseConstant(out);
  } catch {
    back = undefined;
  }
  if (!back || (wide && back.op !== 0x38)) {
    return fail('UNSUPPORTED', `costante ${t}: nessuna forma AWL per ${type.name}`);
  }
  return out;
}

/** Un operando risolto, con quello che serve alle CALL per scegliere come passarlo. */
export type Value =
  | { k: 'const'; text: string; type?: DataType }
  | {
      k: 'area';
      area: AreaId;
      /** byte·8 + bit dall'inizio dell'area. */
      bit: number;
      size: AddressSize | undefined;
      db?: number;
      type?: SsbType;
    }
  | { k: 'inst'; bit: number; type: SsbType }
  | { k: 'formal'; name: string; index: number; type: DataType }
  | { k: 'tc'; area: 'T' | 'C'; number: number }
  | { k: 'block'; blockKind: 'FB' | 'FC' | 'SFB' | 'SFC' | 'DB' | 'DI'; number: number }
  | { k: 'other'; op: Operand };

export interface SymbolEnv {
  ctx: AwlContext;
  owner: 'OB' | 'FB' | 'FC';
  sections: Sections;
  tools: LayoutTools;
  temp: NamedLayout;
  instance?: NamedLayout;
  /** FC: parametro (nome minuscolo) → indice nella lista dei puntatori e tipo. */
  formals: Map<string, { name: string; index: number; type: DataType }>;
  /** Layout dei DB, delle istanze e dei tag composti già calcolati. */
  cache: Map<string, NamedLayout>;
}

const cached = (env: SymbolEnv, k: string, make: () => NamedLayout): NamedLayout => {
  let l = env.cache.get(k);
  if (!l) {
    try {
      l = make();
    } catch (e) {
      if (e instanceof SymbolError) throw e;
      return fail('UNSUPPORTED', `layout di ${k}: ${e instanceof Error ? e.message : String(e)}`);
    }
    env.cache.set(k, l);
  }
  return l;
};

/** Layout dei dati di un DB globale o di istanza. */
export function dbLayout(info: AwlBlockInfo, env: SymbolEnv): NamedLayout {
  return cached(env, `db:${info.number}`, () => {
    if (info.kind === 'IDB') {
      const fb = info.instanceOf ? env.ctx.block({ name: info.instanceOf }) : undefined;
      if (!fb?.iface) return fail('UNSUPPORTED', `DB ${info.name}: FB di istanza sconosciuto`);
      return instanceLayout(sectionsOf(fb), env.tools);
    }
    return structLayout(info.dbMembers ?? [], env.tools);
  });
}

function blockOfDb(env: SymbolEnv, name: string): AwlBlockInfo {
  const info = env.ctx.block({ name });
  if (!info || (info.kind !== 'DB' && info.kind !== 'IDB')) {
    return fail('UNKNOWN_SYMBOL', `"${name}" non è un DB`);
  }
  return info;
}

function inSection(s: Sections, sec: SsbSection[], name: string): TypedMember | undefined {
  for (const k of sec) {
    const m = s[k].find((x) => sameName(x.name, name));
    if (m) return m;
  }
  return undefined;
}

const isComplex = (t: DataType): boolean =>
  t.kind === 'struct' ||
  t.kind === 'array' ||
  t.kind === 'string' ||
  t.kind === 'dateAndTime' ||
  t.kind === 'named';

function resolveLocal(path: readonly PathSegment[], env: SymbolEnv): Value {
  const first = path[0]!;
  const what = `#${path.map((p) => p.name).join('.')}`;
  if (env.owner === 'FC') {
    const f = env.formals.get(key(first.name));
    if (f) {
      if (path.length > 1 || first.index) {
        return fail(
          'UNSUPPORTED',
          `${what}: i membri di un parametro di FC si raggiungono solo tramite il suo puntatore (non supportato)`,
        );
      }
      return { k: 'formal', name: f.name, index: f.index, type: f.type };
    }
  }
  if (env.owner === 'FB' && env.instance) {
    const m = inSection(env.sections, ['in', 'out', 'inOut', 'stat'], first.name);
    if (m) {
      if (path.length > 1 && env.sections.inOut.includes(m) && isComplex(m.type)) {
        return fail(
          'UNSUPPORTED',
          `${what}: un IN_OUT di tipo complesso è un puntatore nell'istanza (accesso ai membri non supportato)`,
        );
      }
      const r = locate(env.instance, path, what);
      return { k: 'inst', bit: r.bit, type: r.type };
    }
  }
  if (inSection(env.sections, ['temp'], first.name)) {
    const r = locate(env.temp, path, what);
    return { k: 'area', area: 'L', bit: r.bit, size: sizeOf(r.type), type: r.type };
  }
  return fail('UNKNOWN_LOCAL', `${what}: variabile locale sconosciuta`);
}

function resolveSymbol(path: readonly PathSegment[], env: SymbolEnv): Value {
  const first = path[0]!;
  const rest = path.slice(1);
  const what = path.map((p) => `"${p.name}"`).join('.');
  const sym = env.ctx.symbol(first.name);
  if (sym) {
    if (sym.kind === 'constant') {
      if (rest.length || first.index)
        return fail('UNSUPPORTED', `${what}: una costante non ha membri`);
      if (sym.value === undefined) return fail('UNSUPPORTED', `${what}: costante senza valore`);
      return {
        k: 'const',
        text: constantFor(sym.type, sym.value),
        ...(sym.type ? { type: sym.type } : {}),
      };
    }
    if (!sym.address) return fail('UNSUPPORTED', `${what}: il tag non ha un indirizzo assoluto`);
    const a = parseAddress(sym.address);
    if (!a.ok) return fail('UNSUPPORTED', `${what}: indirizzo "${sym.address}" non valido`);
    const abs = a.address;
    if ('number' in abs) {
      if (rest.length || first.index) return fail('UNSUPPORTED', `${what}: un T/C non ha membri`);
      return { k: 'tc', area: abs.area, number: abs.number };
    }
    const base = abs.byte * 8 + (abs.size === 'X' ? abs.bit : 0);
    if (rest.length === 0 && !first.index) {
      return {
        k: 'area',
        area: abs.area,
        bit: base,
        size: abs.size,
        ...(sym.type ? { type: sym.type } : {}),
      };
    }
    if (!sym.type) return fail('UNSUPPORTED', `${what}: tag senza tipo`);
    const type = sym.type;
    const lay = cached(env, `tag:${key(first.name)}`, () =>
      structLayout([{ name: first.name, type }], env.tools),
    );
    const r = locate(lay, path, what);
    return { k: 'area', area: abs.area, bit: base + r.bit, size: sizeOf(r.type), type: r.type };
  }
  const info = env.ctx.block({ name: first.name });
  if (!info) return fail('UNKNOWN_SYMBOL', `${what}: simbolo sconosciuto`);
  if (info.kind === 'DB' || info.kind === 'IDB') {
    if (rest.length === 0) return { k: 'block', blockKind: 'DB', number: info.number };
    const r = locate(dbLayout(info, env), rest, what);
    return {
      k: 'area',
      area: 'DB',
      bit: r.bit,
      size: sizeOf(r.type),
      db: info.number,
      type: r.type,
    };
  }
  if (rest.length || info.kind === 'OB') return fail('UNSUPPORTED', `${what}: non è un operando`);
  return { k: 'block', blockKind: info.kind, number: info.number };
}

/** Risolve un operando (anche il valore di un parametro di CALL). */
export function resolveValue(op: Operand, env: SymbolEnv): Value {
  switch (op.kind) {
    case 'address': {
      const bit = op.byte * 8 + (op.bit ?? 0);
      if (op.dbSymbol) {
        const db = blockOfDb(env, op.dbSymbol.name).number;
        return { k: 'area', area: 'DB', bit, size: op.size ?? undefined, db };
      }
      return {
        k: 'area',
        area: op.area,
        bit,
        size: op.size ?? undefined,
        ...(op.db !== undefined ? { db: op.db } : {}),
      };
    }
    case 'timerCounter':
      return { k: 'tc', area: op.area, number: op.number };
    case 'block':
      return { k: 'block', blockKind: op.blockKind, number: op.number };
    case 'constant':
      if (op.pointerTo) {
        return fail(
          'P_LOCAL_UNSUPPORTED',
          `${op.text}: il puntatore a un locale (P##) non è ancora supportato dal compilatore`,
        );
      }
      return { k: 'const', text: op.text };
    case 'local':
      return resolveLocal(op.path, env);
    case 'symbol':
      return resolveSymbol(op.path, env);
    default:
      return { k: 'other', op };
  }
}

const localOp = (name: string): Operand => ({
  kind: 'local',
  path: [{ name, quoted: false, range: NO_RANGE }],
  range: NO_RANGE,
});

/** Un indirizzo `[AR2,P#byte.bit]` (16 bit: byte ≤ 8191, mc7 §2.2.3). */
export function ar2Offset(bit: number, what: string): string {
  if (bit > 0xffff) {
    return fail(
      'UNSUPPORTED',
      `${what}: offset ${bit >> 3} oltre P#8191.7, non indirizzabile con [AR2,P#…]`,
    );
  }
  return `P#${bit >> 3}.${bit & 7}`;
}

/** Il valore come operando di un'istruzione. */
export function toOperand(v: Value, what: string): Operand {
  switch (v.k) {
    case 'const':
      return constant(v.text);
    case 'area': {
      if (!v.size) return fail('UNSUPPORTED', `${what}: accesso a un dato di tipo complesso`);
      if (v.size !== 'X' && v.bit % 8 !== 0)
        return fail('UNSUPPORTED', `${what}: non allineato a un byte`);
      return address(v.area, v.size, v.bit >> 3, v.size === 'X' ? v.bit & 7 : undefined, v.db);
    }
    case 'inst': {
      const size = sizeOf(v.type);
      if (!size) {
        return fail(
          'UNSUPPORTED',
          `${what}: dato d'istanza di tipo complesso o parametro (TIMER, COUNTER, BLOCK) di un FB: accesso non supportato`,
        );
      }
      return indirectReg('DI', size, 2, ar2Offset(v.bit, what));
    }
    case 'formal':
      if (!formalTypeOf(v.type)) {
        return fail(
          'UNSUPPORTED',
          `${what}: parametro di FC di tipo complesso: accesso diretto non supportato`,
        );
      }
      return localOp(v.name);
    case 'tc':
      return timerCounter(v.area, v.number);
    case 'block':
      return blockRef(v.blockKind, v.number);
    case 'other':
      return v.op;
  }
}

/** Il parametro formale `#nome` di una FC (per `encodeCode`). */
export function formalParam(env: SymbolEnv, name: string): FormalParam | undefined {
  const f = env.formals.get(key(name));
  const type = f && formalTypeOf(f.type);
  return f && type ? { offset: 2 * (f.index + 1), type } : undefined;
}

/** Riscrive un'istruzione (non CALL) con gli operandi risolti. */
export function rewriteStatement(stmt: Statement, env: SymbolEnv): Statement[] {
  const op = stmt.operand;
  if (!op || op.kind === 'labelRef') return [stmt];
  const what = stmt.instruction.text;
  if (op.kind === 'indirect' && op.via.kind === 'memory') {
    const loc = toOperand(resolveValue(op.via.location, env), what);
    if (loc.kind !== 'address' || loc.db !== undefined) {
      return fail(
        'UNSUPPORTED',
        `${what}: il puntatore di un accesso indiretto deve stare in M, DB, DI o L`,
      );
    }
    return [{ ...stmt, operand: { ...op, via: { kind: 'memory', location: loc } } }];
  }
  return [{ ...stmt, operand: toOperand(resolveValue(op, env), what) }];
}
