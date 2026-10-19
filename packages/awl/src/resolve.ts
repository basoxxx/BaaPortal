// Risoluzione di simboli, locali e percorsi di membri, condivisa da controllo e completamento.
import { sameName, type DataType, type TypedMember } from '@baaportal/s7-types';
import type { Operand, PathSegment } from './ast';
import type { AwlBlockInfo, AwlCode, AwlContext, AwlInterface } from './context';
import type { Range } from './lexer';

export type Report = (code: AwlCode, range: Range, params?: Record<string, string>) => void;
export const noReport: Report = () => undefined;

/** Come un operando risolto puo' essere usato. */
export type Resolved =
  | { k: 'bit'; src: 'address' | 'typed' | 'indirect'; type?: DataType }
  | {
      k: 'data';
      bits: 8 | 16 | 32;
      src: 'address' | 'typed' | 'indirect';
      type?: DataType;
      writable: boolean;
    }
  | { k: 'timer' | 'counter'; src: 'address' | 'typed' | 'indirect'; type?: DataType }
  | { k: 'const'; pointer: boolean; text: string }
  | { k: 'special'; name: string }
  | { k: 'complex'; type: DataType }
  | { k: 'block'; blockKind: 'FB' | 'FC' | 'SFB' | 'SFC' | 'DB' | 'OB'; info?: AwlBlockInfo }
  | { k: 'label' }
  | { k: 'status' }
  | { k: 'unknown' };

const BITS = new Map<string, 8 | 16 | 32>([
  ['Byte', 8],
  ['Char', 8],
  ['Word', 16],
  ['Int', 16],
  ['S5Time', 16],
  ['Date', 16],
  ['DWord', 32],
  ['DInt', 32],
  ['Real', 32],
  ['Time', 32],
  ['Time_Of_Day', 32],
]);

export const bitsOf = (t: DataType): 1 | 8 | 16 | 32 | null =>
  t.kind === 'elementary' ? (t.name === 'Bool' ? 1 : (BITS.get(t.name) ?? null)) : null;

const BLOCK_PARAMS: Record<string, 'FB' | 'FC' | 'DB'> = {
  Block_FB: 'FB',
  Block_FC: 'FC',
  Block_DB: 'DB',
  Block_SDB: 'DB',
};

/** Come si usa un valore del tipo dato (simbolo o locale). */
export function fromType(t: DataType | null, writable = true): Resolved {
  if (t === null || t.kind === 'void') return { k: 'unknown' };
  if (t.kind === 'elementary') {
    if (t.name === 'Bool') return { k: 'bit', src: 'typed', type: t };
    return { k: 'data', bits: BITS.get(t.name)!, src: 'typed', type: t, writable };
  }
  if (t.kind === 'parameter') {
    if (t.name === 'Timer') return { k: 'timer', src: 'typed', type: t };
    if (t.name === 'Counter') return { k: 'counter', src: 'typed', type: t };
    const b = BLOCK_PARAMS[t.name];
    if (b) return { k: 'block', blockKind: b };
  }
  return { k: 'complex', type: t };
}

export function ifaceMembers(
  owner: AwlContext['owner'],
): { section: 'input' | 'output' | 'inOut' | 'static' | 'temp' | 'ret'; members: TypedMember[] }[] {
  const i = owner.iface;
  if (owner.kind === 'OB') return [{ section: 'temp', members: i.temp }];
  const out: ReturnType<typeof ifaceMembers> = [
    { section: 'input', members: i.input },
    { section: 'output', members: i.output },
    { section: 'inOut', members: i.inOut },
  ];
  if (owner.kind === 'FB') out.push({ section: 'static', members: i.static });
  out.push({ section: 'temp', members: i.temp });
  if (owner.kind === 'FC' && i.returnType && i.returnType.kind !== 'void') {
    out.push({ section: 'ret', members: [{ name: 'RET_VAL', type: i.returnType }] });
  }
  return out;
}

export function localMembers(ctx: AwlContext): TypedMember[] {
  return ifaceMembers(ctx.owner).flatMap((s) => s.members);
}

/** Le sezioni dell'interfaccia di un blocco chiamabile, visibili dall'esterno. */
export function callMembers(iface: AwlInterface): TypedMember[] {
  return [...iface.input, ...iface.output, ...iface.inOut];
}

/** Membri di un tipo composto; 'unknown' se il tipo nominato non si risolve; null se non e' composto. */
export function membersOf(t: DataType, ctx: AwlContext): TypedMember[] | 'unknown' | null {
  if (t.kind === 'struct') return t.members;
  if (t.kind !== 'named') return null;
  const found = ctx.resolve(t.name);
  if (!found) return 'unknown';
  if (found.kind === 'udt') return found.members;
  const s = found.sections;
  return [...s.input, ...s.output, ...s.inOut, ...s.static];
}

/** I membri visibili in un DB: dbMembers, oppure le sezioni dell'FB per un DB di istanza. */
export function dbMemberList(
  info: AwlBlockInfo,
  ctx: AwlContext,
): { members: TypedMember[]; temp: TypedMember[] } | null {
  if (info.kind === 'IDB' && info.instanceOf) {
    const fb = ctx.block({ name: info.instanceOf });
    if (fb?.iface) {
      const i = fb.iface;
      return { members: [...i.input, ...i.output, ...i.inOut, ...i.static], temp: i.temp };
    }
  }
  return info.dbMembers ? { members: info.dbMembers, temp: [] } : null;
}

export function applyIndex(t: DataType, seg: PathSegment, rep: Report): DataType | null {
  if (!seg.index) return t;
  if (t.kind !== 'array') {
    rep('TYPE_MISMATCH', seg.range);
    return null;
  }
  return t.element;
}

/** Percorre i segmenti `segs` a partire dal tipo `t`; null = tipo non determinabile. */
export function walkMembers(
  ctx: AwlContext,
  t: DataType | null,
  segs: PathSegment[],
  rep: Report,
): DataType | null {
  let cur = t;
  for (const seg of segs) {
    if (cur === null) return null;
    const list = membersOf(cur, ctx);
    if (list === 'unknown') return null;
    const mem = list?.find((x) => sameName(x.name, seg.name));
    if (!mem) {
      rep('UNKNOWN_MEMBER', seg.range, { name: seg.name });
      return null;
    }
    cur = applyIndex(mem.type, seg, rep);
  }
  return cur;
}

const blockKindOf = (k: AwlBlockInfo['kind']): Extract<Resolved, { k: 'block' }>['blockKind'] =>
  k === 'IDB' ? 'DB' : k;

export function resolveLocal(ctx: AwlContext, path: PathSegment[], rep: Report): Resolved {
  const first = path[0]!;
  const mem = localMembers(ctx).find((x) => sameName(x.name, first.name));
  if (!mem) {
    rep('UNKNOWN_LOCAL', first.range, { name: first.name });
    return { k: 'unknown' };
  }
  const t0 = applyIndex(mem.type, first, rep);
  const rest = path.slice(1);
  return fromType(walkMembers(ctx, t0, rest, rep));
}

export function resolveSymbol(ctx: AwlContext, path: PathSegment[], rep: Report): Resolved {
  const first = path[0]!;
  const rest = path.slice(1);
  const sym = ctx.symbol(first.name);
  if (sym) {
    const t0 = sym.type && applyIndex(sym.type, first, rep);
    return fromType(walkMembers(ctx, t0 ?? null, rest, rep), sym.kind === 'tag');
  }
  const info = ctx.block({ name: first.name });
  if (!info) {
    rep('UNKNOWN_SYMBOL', first.range, { name: first.name });
    return { k: 'unknown' };
  }
  if (info.kind === 'DB' || info.kind === 'IDB') {
    if (rest.length === 0) return { k: 'block', blockKind: 'DB', info };
    const list = dbMemberList(info, ctx);
    if (!list) return { k: 'unknown' };
    const seg = rest[0]!;
    const mem = list.members.find((x) => sameName(x.name, seg.name));
    if (!mem) {
      if (list.temp.some((x) => sameName(x.name, seg.name))) {
        rep('LOCAL_NOT_ACCESSIBLE', seg.range, { name: seg.name });
      } else rep('UNKNOWN_MEMBER', seg.range, { name: seg.name });
      return { k: 'unknown' };
    }
    const t0 = applyIndex(mem.type, seg, rep);
    return fromType(walkMembers(ctx, t0, rest.slice(1), rep));
  }
  if (rest.length > 0) {
    rep('UNKNOWN_MEMBER', rest[0]!.range, { name: rest[0]!.name });
    return { k: 'unknown' };
  }
  return { k: 'block', blockKind: blockKindOf(info.kind), info };
}

/** Il blocco DB o IDB di un DB simbolico con indirizzo assoluto. */
export function resolveDbSymbol(ctx: AwlContext, name: string, range: Range, rep: Report): void {
  const info = ctx.block({ name });
  if (!info || (info.kind !== 'DB' && info.kind !== 'IDB')) {
    rep('UNKNOWN_SYMBOL', range, { name });
  }
}

export type PathOperand = Extract<Operand, { kind: 'symbol' | 'local' }>;
