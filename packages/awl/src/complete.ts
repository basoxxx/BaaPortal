// Completamento automatico nel codice AWL.
import { formatType, sameName, type DataType, type TypedMember } from '@baaportal/s7-types';
import type { PathSegment } from './ast';
import type { AwlBlockInfo, AwlContext } from './context';
import { INSTRUCTIONS, findInstruction, type Mnemonic } from './instructions';
import type { Range } from './lexer';
import { parseDetailed } from './parser';
import {
  applyIndex,
  dbMemberList,
  localMembers,
  membersOf,
  noReport,
  walkMembers,
} from './resolve';

export interface Completion {
  label: string;
  kind: 'instruction' | 'tag' | 'constant' | 'local' | 'member' | 'block' | 'label' | 'param';
  detail?: string;
  /** Il testo che sostituisce l'intervallo da `from` al cursore (con le virgolette dove servono). */
  apply: string;
}

const KIND_ORDER: Completion['kind'][] = [
  'instruction',
  'tag',
  'constant',
  'local',
  'member',
  'block',
  'label',
  'param',
];
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const none = (at: number): Result => ({ from: at, options: [] });

type Result = { from: number; options: Completion[] };
type Mode = 'generic' | 'callee' | 'dbs' | 'instance';

const norm = (s: string): string => s.normalize('NFC').toLowerCase();
const startsWith = (name: string, partial: string): boolean => norm(name).startsWith(norm(partial));
const bareOrQuoted = (name: string): string => (IDENT.test(name) ? name : `"${name}"`);
const detailOf = (t: DataType | null): { detail?: string } => (t ? { detail: formatType(t) } : {});
const DUMMY: Range = {
  from: { line: 0, col: 0, offset: 0 },
  to: { line: 0, col: 0, offset: 0 },
};

interface PathScan {
  segs: { name: string; quoted: boolean; indexed: boolean }[];
  local: boolean;
  partial: { text: string; start: number };
}

/** Scompone `text` (un operando simbolico in corso di scrittura); null se non e' un percorso. */
function scanPath(text: string): PathScan | null {
  let i = 0;
  const local = text[0] === '#';
  if (local) i++;
  const segs: PathScan['segs'] = [];
  for (;;) {
    const start = i;
    let name: string;
    let quoted = false;
    if (text[i] === '"') {
      const close = text.indexOf('"', i + 1);
      if (close < 0) return { segs, local, partial: { text: text.slice(i + 1), start } };
      name = text.slice(i + 1, close);
      quoted = true;
      i = close + 1;
    } else {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
      if (!m) return i === text.length ? { segs, local, partial: { text: '', start: i } } : null;
      name = m[0];
      i += name.length;
      if (i === text.length) return { segs, local, partial: { text: name, start } };
    }
    let indexed = false;
    if (text[i] === '[') {
      const close = text.indexOf(']', i);
      if (close < 0) return null;
      indexed = true;
      i = close + 1;
    }
    if (i === text.length && !indexed) return { segs, local, partial: { text: name, start } };
    if (text[i] !== '.') return null;
    segs.push({ name, quoted, indexed });
    i++;
    if (i === text.length) return { segs, local, partial: { text: '', start: i } };
  }
}

const asSegs = (segs: PathScan['segs']): PathSegment[] =>
  segs.map((s) => ({
    name: s.name,
    quoted: s.quoted,
    range: DUMMY,
    ...(s.indexed ? { index: [0] } : {}),
  }));

/** I membri raggiungibili dopo i segmenti completi `scan.segs` (null = nessuno / sconosciuto). */
function containerMembers(ctx: AwlContext, scan: PathScan): TypedMember[] | null {
  const segs = asSegs(scan.segs);
  const first = segs[0]!;
  let t: DataType | null;
  let rest = segs.slice(1);
  if (scan.local) {
    const mem = localMembers(ctx).find((m) => sameName(m.name, first.name));
    t = mem ? applyIndex(mem.type, first, noReport) : null;
  } else {
    const sym = ctx.symbol(first.name);
    if (sym) t = sym.type && applyIndex(sym.type, first, noReport);
    else {
      const info = ctx.block({ name: first.name });
      if (!info || (info.kind !== 'DB' && info.kind !== 'IDB')) return null;
      const list = dbMemberList(info, ctx);
      if (!list) return null;
      if (rest.length === 0) return list.members;
      const mem = list.members.find((m) => sameName(m.name, rest[0]!.name));
      t = mem ? applyIndex(mem.type, rest[0]!, noReport) : null;
      rest = rest.slice(1);
    }
  }
  const end = walkMembers(ctx, t, rest, noReport);
  const list = end && membersOf(end, ctx);
  return Array.isArray(list) ? list : null;
}

function blockOption(b: AwlBlockInfo): Completion {
  return { label: b.name, kind: 'block', detail: `${b.kind} ${b.number}`, apply: `"${b.name}"` };
}

function rootOptions(ctx: AwlContext, mode: Mode, calleeName: string | null): Completion[] {
  const blocks = ctx.allBlocks();
  switch (mode) {
    case 'callee':
      return blocks.filter((b) => ['FB', 'FC', 'SFB', 'SFC'].includes(b.kind)).map(blockOption);
    case 'dbs':
      return blocks.filter((b) => b.kind === 'DB' || b.kind === 'IDB').map(blockOption);
    case 'instance':
      return blocks
        .filter(
          (b) =>
            b.kind === 'IDB' &&
            (calleeName === null || !b.instanceOf || sameName(b.instanceOf, calleeName)),
        )
        .map(blockOption);
    case 'generic':
      return [
        ...ctx.allSymbols().map((s) => ({
          label: s.name,
          kind: s.kind,
          ...detailOf(s.type),
          apply: `"${s.name}"`,
        })),
        ...blocks.filter((b) => b.kind === 'DB' || b.kind === 'IDB').map(blockOption),
      ];
  }
}

/** Completa un operando simbolico; `base` e' l'offset di `text` nella rete. */
function completeOperand(
  ctx: AwlContext,
  text: string,
  base: number,
  mode: Mode,
  calleeName: string | null,
): Result {
  const scan = scanPath(text);
  if (!scan) return none(base + text.length);
  const from = base + scan.partial.start;
  let options: Completion[];
  if (scan.segs.length === 0) {
    if (scan.local) {
      options = localMembers(ctx)
        .filter((m) => mode !== 'callee' || m.type.kind === 'named')
        .map((m) => ({
          label: m.name,
          kind: 'local' as const,
          ...detailOf(m.type),
          apply: bareOrQuoted(m.name),
        }));
    } else options = rootOptions(ctx, mode, calleeName);
  } else {
    options = (containerMembers(ctx, scan) ?? []).map((m) => ({
      label: m.name,
      kind: 'member' as const,
      ...detailOf(m.type),
      apply: bareOrQuoted(m.name),
    }));
  }
  return { from, options: options.filter((o) => startsWith(o.label, scan.partial.text)) };
}

function calleeOf(
  ctx: AwlContext,
  stmt: { operand?: import('./ast').Operand },
): AwlBlockInfo | undefined {
  const op = stmt.operand;
  if (!op) return undefined;
  if (op.kind === 'block') {
    return op.blockKind === 'DB' || op.blockKind === 'DI'
      ? undefined
      : ctx.block({ kind: op.blockKind, number: op.number });
  }
  if (op.kind === 'symbol' && op.path.length === 1) return ctx.block({ name: op.path[0]!.name });
  if (op.kind === 'local' && op.path.length === 1) {
    const mem = localMembers(ctx).find((m) => sameName(m.name, op.path[0]!.name));
    return mem?.type.kind === 'named' ? ctx.block({ name: mem.type.name }) : undefined;
  }
  return undefined;
}

/** Dentro l'elenco parametri di un CALL non chiuso. */
function completeInParams(
  ctx: AwlContext,
  text: string,
  openAt: number,
  callStmt: Parameters<typeof calleeOf>[1] & { params?: { name: string }[] },
  end: number,
): Result {
  // scansione dell'elenco: apici, commenti, parentesi; trova l'inizio del parametro corrente
  let segStart = openAt + 1;
  let hasContent = false;
  let depth = 0;
  for (let i = openAt + 1; i < end; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'") {
      const close = text.indexOf(c, i + 1);
      const eol = text.slice(i).search(/[\r\n]/);
      const limit = eol < 0 ? text.length : i + eol;
      if (close < 0 || close >= limit || close >= end) {
        if (c === "'") return none(end);
        break; // virgolette non chiuse: e' il simbolo che si sta scrivendo
      }
      i = close;
      hasContent = true;
    } else if (c === '/' && text[i + 1] === '/') {
      const eol = text.slice(i).search(/[\r\n]/);
      if (eol < 0 || i + eol >= end) return none(end);
      i += eol - 1;
      if (!hasContent) segStart = i + 1;
    } else if (c === '[' || c === '(') {
      depth++;
      hasContent = true;
    } else if (c === ']' || c === ')') {
      depth = Math.max(0, depth - 1);
    } else if (c === ',' && depth === 0) {
      segStart = i + 1;
      hasContent = false;
    } else if (c !== ' ' && c !== '\t' && c !== '\r' && c !== '\n') hasContent = true;
  }
  const raw = text.slice(segStart, end);
  const lead = raw.length - raw.trimStart().length;
  const s = raw.slice(lead);
  const sAt = segStart + lead;
  const callee = calleeOf(ctx, callStmt);

  const arrow = /^("[^"]*"|[A-Za-z_][A-Za-z0-9_]*)[ \t]*(:=|=>)[ \t]*/.exec(s);
  if (arrow)
    return completeOperand(ctx, s.slice(arrow[0].length), sAt + arrow[0].length, 'generic', null);

  const m = /^(")?([^"]*)$/.exec(s);
  if (!m || (!m[1] && !/^[A-Za-z_0-9]*$/.test(m[2]!))) return none(end);
  const partial = m[2]!;
  const iface = callee?.iface;
  if (!callee || !iface) return none(sAt);
  // Un parametro scritto con un alias (SZL_ID) è già assegnato con il suo nome canonico (SSL_ID).
  const canonical = (name: string): string => {
    for (const [alias, to] of Object.entries(callee.paramAliases ?? {})) {
      if (sameName(alias, name)) return to;
    }
    return name;
  };
  const assigned = new Set(
    (callStmt.params ?? []).map((p) => norm(canonical(p.name.replace(/^"|"$/g, '')))),
  );
  const ret =
    (callee.kind === 'FC' || callee.kind === 'SFC') &&
    iface.returnType &&
    iface.returnType.kind !== 'void'
      ? [{ name: 'RET_VAL', type: iface.returnType }]
      : [];
  const options: Completion[] = [...iface.input, ...iface.output, ...iface.inOut, ...ret]
    .filter((p) => !assigned.has(norm(p.name)) && startsWith(p.name, partial))
    .map((p) => ({
      label: p.name,
      kind: 'param' as const,
      detail: formatType(p.type),
      apply: bareOrQuoted(p.name),
    }));
  return { from: sAt, options };
}

/** Indice del primo '//' fuori dagli apici, o -1. */
function commentStart(s: string): number {
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '/' && s[i + 1] === '/') return i;
  }
  return -1;
}

/** Posizione della prima virgola fuori dagli apici, o -1. */
function topLevelComma(s: string): number {
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ',') return i;
  }
  return -1;
}

function allLabels(networks: string[], mnemonic: Mnemonic): string[] {
  const names: string[] = [];
  for (const n of networks) {
    for (const st of parseDetailed(n, mnemonic).statements) if (st.label) names.push(st.label.name);
  }
  return [...new Set(names)];
}

function compute(
  networks: string[],
  network: number,
  offset: number,
  ctx: AwlContext,
  mnemonic: Mnemonic,
): Result {
  const text = networks[network] ?? '';
  offset = Math.max(0, Math.min(offset, text.length));
  const before = text.slice(0, offset);

  // dentro i parametri di un CALL
  const parsed = parseDetailed(before, mnemonic);
  const unclosed = parsed.errors.filter((e) => e.code === 'UNCLOSED_PARAMS').at(-1);
  if (unclosed) {
    const openAt = unclosed.range.from.offset;
    const call = parsed.statements
      .filter((s) => s.instruction.def?.id === 'CALL' && s.range.from.offset <= openAt)
      .at(-1);
    if (call) return completeInParams(ctx, before, openAt, call, offset);
  }

  const lineStart = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r')) + 1;
  const prefix = before.slice(lineStart);
  if (commentStart(prefix) >= 0) return none(offset);

  const label = /^[ \t]*[A-Za-z_][A-Za-z0-9_]{0,3}[ \t]*:(?!=)/.exec(prefix);
  const rest = prefix.slice(label ? label[0].length : 0);
  const restAt = lineStart + (label ? label[0].length : 0);
  const body = rest.trimStart();
  const bodyAt = restAt + (rest.length - body.length);

  if (!/[ \t]/.test(body)) {
    const up = body.toUpperCase();
    const options = INSTRUCTIONS.map((i) => (mnemonic === 'international' ? i.id : i.german))
      .filter((n) => n.toUpperCase().startsWith(up))
      .map((n) => ({ label: n, kind: 'instruction' as const, apply: n }));
    return { from: bodyAt, options };
  }

  const wordLen = body.search(/[ \t]/);
  const def = findInstruction(body.slice(0, wordLen), mnemonic);
  if (!def) return none(offset);
  const opRaw = body.slice(wordLen);
  const opText = opRaw.trimStart();
  const opAt = bodyAt + wordLen + (opRaw.length - opText.length);

  if (def.operands.includes('label')) {
    if (!/^[A-Za-z0-9_]*$/.test(opText)) return none(offset);
    const options = allLabels(networks, mnemonic)
      .filter((n) => startsWith(n, opText))
      .map((n) => ({ label: n, kind: 'label' as const, apply: n }));
    return { from: opAt, options };
  }
  if (def.id === 'CALL') {
    const comma = topLevelComma(opText);
    if (comma < 0) return completeOperand(ctx, opText, opAt, 'callee', null);
    const first = scanPath(opText.slice(0, comma).trim());
    const calleeName = first && first.segs.length === 0 && !first.local ? first.partial.text : null;
    const second = opText.slice(comma + 1);
    const lead = second.length - second.trimStart().length;
    return completeOperand(
      ctx,
      second.trimStart(),
      opAt + comma + 1 + lead,
      'instance',
      calleeName,
    );
  }
  const mode: Mode =
    def.id === 'OPN' ? 'dbs' : def.id === 'UC' || def.id === 'CC' ? 'callee' : 'generic';
  return completeOperand(ctx, opText, opAt, mode, null);
}

export function completeAt(
  networks: string[],
  network: number,
  offset: number,
  ctx: AwlContext,
  mnemonic: Mnemonic,
): { from: number; options: Completion[] } {
  const r = compute(networks, network, offset, ctx, mnemonic);
  r.options.sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.label.localeCompare(b.label),
  );
  return r;
}
