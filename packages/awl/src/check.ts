// Controllo semantico di un blocco di codice AWL (l'insieme dei suoi segmenti).
import { sameName } from '@baaportal/s7-types';
import type { CallParam, Operand, Statement } from './ast';
import type { AwlBlockInfo, AwlContext, AwlDiagnostic } from './context';
import type { Mnemonic } from './instructions';
import type { Range } from './lexer';
import { parseDetailed, type ParseResult } from './parser';
import { classify, paramCompatible, resolveOperand } from './operandClass';
import { localMembers, type Report } from './resolve';

const MAX_BRACKETS = 7;
const MAX_MCR = 8;
const MAX_LABEL = 4;
const CALLABLE = new Set<AwlBlockInfo['kind']>(['FB', 'FC', 'SFB', 'SFC']);

const labelKey = (name: string): string => name.normalize('NFC').toLowerCase();
const unquote = (name: string): string =>
  name.startsWith('"') && name.endsWith('"') ? name.slice(1, -1) : name;

interface LabelDef {
  name: string;
  range: Range;
  network: number;
}

export function checkBlockCode(
  networks: string[],
  ctx: AwlContext,
  mnemonic: Mnemonic,
): AwlDiagnostic[] {
  const out: AwlDiagnostic[] = [];
  const parsed = networks.map((n) => parseDetailed(n, mnemonic));

  // Le etichette valgono in tutto il blocco: prima si raccolgono quelle definite.
  const defs: LabelDef[] = [];
  const counts = new Map<string, number>();
  parsed.forEach((p, network) => {
    for (const st of p.statements) {
      if (!st.label) continue;
      defs.push({ name: st.label.name, range: st.label.range, network });
      const k = labelKey(st.label.name);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  });

  let mcrDepth = 0;
  parsed.forEach((p, network) => {
    const rep: Report = (code, range, params) => {
      out.push({ severity: 'error', code, network, range, ...(params ? { params } : {}) });
    };
    for (const e of p.errors) {
      const isLongLabel =
        e.code === 'SYNTAX' &&
        e.params?.reason === 'label' &&
        e.range.to.offset - e.range.from.offset > MAX_LABEL;
      rep(isLongLabel ? 'LABEL_TOO_LONG' : e.code, e.range, e.params);
    }
    const open: Range[] = [];
    for (const st of p.statements) {
      const def = st.instruction.def;
      if (!def) continue;
      const at = st.instruction.range;
      if (def.opensBracket) {
        if (open.length >= MAX_BRACKETS) rep('BRACKET_DEPTH', at);
        open.push(at);
      } else if (def.closesBracket) {
        if (open.length === 0) rep('BRACKET_UNEXPECTED', at);
        else open.pop();
      } else if (def.id === 'MCR(') {
        if (mcrDepth >= MAX_MCR) rep('MCR_DEPTH', at);
        mcrDepth++;
      } else if (def.id === ')MCR') {
        if (mcrDepth === 0) rep('BRACKET_UNEXPECTED', at);
        else mcrDepth--;
      }
      checkStatement(st, p, ctx, rep, counts);
    }
    for (const r of open) rep('BRACKET_UNCLOSED', r);
  });

  for (const d of defs) {
    if (counts.get(labelKey(d.name))! > 1) {
      out.push({
        severity: 'error',
        code: 'DUPLICATE_LABEL',
        network: d.network,
        range: d.range,
        params: { name: d.name },
      });
    }
  }
  return out;
}

function checkStatement(
  st: Statement,
  p: ParseResult,
  ctx: AwlContext,
  rep: Report,
  labels: Map<string, number>,
): void {
  const def = st.instruction.def!;
  if (def.id === 'CALL') {
    checkCall(st, p, ctx, rep);
    return;
  }
  const op = st.operand;
  if (!op) {
    const broken = p.errors.some(
      (e) => e.range.from.line >= st.range.from.line && e.range.from.line <= st.range.to.line,
    );
    if (!def.operands.includes('none') && !broken) {
      rep('OPERAND_MISSING', st.instruction.range, { instruction: st.instruction.text });
    }
    return;
  }
  if (op.kind === 'labelRef') {
    if (op.name.length > MAX_LABEL) rep('LABEL_TOO_LONG', op.range, { name: op.name });
    else if (!labels.has(labelKey(op.name))) rep('UNKNOWN_LABEL', op.range, { name: op.name });
    return;
  }
  const r = resolveOperand(ctx, op, rep);
  if (def.operands.includes('callTarget') || def.operands.includes('ucTarget')) {
    if (op.kind === 'block' && op.blockKind !== 'DB' && op.blockKind !== 'DI') {
      if (!ctx.block({ kind: op.blockKind, number: op.number })) {
        rep('UNKNOWN_BLOCK', op.range, { name: `${op.blockKind} ${op.number}` });
        return;
      }
    }
  }
  const v = classify(def, op, r);
  if (v === 'notAllowed') rep('OPERAND_NOT_ALLOWED', op.range, { instruction: def.id });
  else if (v === 'mismatch') rep('TYPE_MISMATCH', op.range);
  else if (v === 'range') rep('CONSTANT_OUT_OF_RANGE', op.range, { instruction: def.id });
}

// ---- CALL ----

function findCallee(
  op: Operand,
  ctx: AwlContext,
  rep: Report,
): { callee: AwlBlockInfo; multi: boolean } | null {
  if (op.kind === 'block') {
    if (op.blockKind === 'DB' || op.blockKind === 'DI') {
      rep('OPERAND_NOT_ALLOWED', op.range);
      return null;
    }
    const callee = ctx.block({ kind: op.blockKind, number: op.number });
    if (!callee) rep('UNKNOWN_BLOCK', op.range, { name: `${op.blockKind} ${op.number}` });
    return callee ? { callee, multi: false } : null;
  }
  if (op.kind === 'symbol') {
    const first = op.path[0]!;
    const callee = op.path.length === 1 ? ctx.block({ name: first.name }) : undefined;
    if (!callee) {
      if (op.path.length === 1 && !ctx.symbol(first.name)) {
        rep('UNKNOWN_BLOCK', op.range, { name: first.name });
      } else rep('OPERAND_NOT_ALLOWED', op.range);
      return null;
    }
    if (!CALLABLE.has(callee.kind)) {
      rep('OPERAND_NOT_ALLOWED', op.range);
      return null;
    }
    return { callee, multi: false };
  }
  if (op.kind === 'local') {
    const first = op.path[0]!;
    const mem = localMembers(ctx).find((m) => sameName(m.name, first.name));
    if (!mem) {
      rep('UNKNOWN_LOCAL', first.range, { name: first.name });
      return null;
    }
    const callee =
      op.path.length === 1 && mem.type.kind === 'named'
        ? ctx.block({ name: mem.type.name })
        : undefined;
    if (callee?.kind !== 'FB' && callee?.kind !== 'SFB') {
      rep('OPERAND_NOT_ALLOWED', op.range);
      return null;
    }
    return { callee, multi: true };
  }
  rep('OPERAND_NOT_ALLOWED', op.range);
  return null;
}

function checkInstance(
  callee: AwlBlockInfo,
  multi: boolean,
  st: Statement,
  ctx: AwlContext,
  rep: Report,
): void {
  const inst = st.instanceDb;
  const needs = callee.kind === 'FB' || callee.kind === 'SFB';
  if (multi || !needs) {
    if (inst) rep('CALL_INSTANCE_WRONG', inst.range);
    return;
  }
  if (!inst) {
    rep('CALL_INSTANCE_MISSING', st.operand!.range);
    return;
  }
  let info: AwlBlockInfo | undefined;
  if (inst.kind === 'block' && (inst.blockKind === 'DB' || inst.blockKind === 'DI')) {
    info =
      ctx.block({ kind: 'IDB', number: inst.number }) ??
      ctx.block({ kind: 'DB', number: inst.number });
    if (!info) {
      rep('UNKNOWN_BLOCK', inst.range, { name: `DB ${inst.number}` });
      return;
    }
  } else if (inst.kind === 'symbol') {
    const r = resolveOperand(ctx, inst, rep);
    if (r.k === 'unknown') return;
    info = inst.path.length === 1 ? ctx.block({ name: inst.path[0]!.name }) : undefined;
  }
  if (info?.kind !== 'IDB' || !info.instanceOf || !sameName(info.instanceOf, callee.name)) {
    rep('CALL_INSTANCE_WRONG', inst.range, { name: callee.name });
  }
}

function checkCall(st: Statement, p: ParseResult, ctx: AwlContext, rep: Report): void {
  const target = st.operand;
  if (!target) {
    const broken = p.errors.some(
      (e) => e.range.from.line >= st.range.from.line && e.range.from.line <= st.range.to.line,
    );
    if (!broken) rep('OPERAND_MISSING', st.instruction.range, { instruction: 'CALL' });
    return;
  }
  const found = findCallee(target, ctx, rep);
  const params = st.params ?? [];
  if (!found) {
    // i valori dei parametri si controllano comunque (simboli sconosciuti)
    for (const prm of params) if (prm.value) resolveOperand(ctx, prm.value, rep);
    if (st.instanceDb) resolveOperand(ctx, st.instanceDb, rep);
    return;
  }
  const { callee, multi } = found;
  checkInstance(callee, multi, st, ctx, rep);
  checkParams(callee, params, st, ctx, rep);
}

function checkParams(
  callee: AwlBlockInfo,
  params: CallParam[],
  st: Statement,
  ctx: AwlContext,
  rep: Report,
): void {
  const iface = callee.iface;
  const ret =
    (callee.kind === 'FC' || callee.kind === 'SFC') &&
    iface?.returnType &&
    iface.returnType.kind !== 'void'
      ? [{ name: 'RET_VAL', type: iface.returnType }]
      : [];
  const known = iface
    ? [
        ...iface.input.map((m) => ({ ...m, input: true })),
        ...iface.output.map((m) => ({ ...m, input: false })),
        ...iface.inOut.map((m) => ({ ...m, input: false })),
        ...ret.map((m) => ({ ...m, input: false })),
      ]
    : [];
  const seen = new Set<string>();
  for (const prm of params) {
    const r = prm.value ? resolveOperand(ctx, prm.value, rep) : null;
    if (!iface) continue;
    const name = unquote(prm.name);
    const decl = known.find((m) => sameName(m.name, name));
    if (!decl) {
      rep('CALL_PARAM_UNKNOWN', prm.nameRange, { name });
      continue;
    }
    seen.add(labelKey(decl.name));
    if (prm.arrow === '=>' && decl.input) rep('CALL_PARAM_DIRECTION', prm.nameRange, { name });
    if (prm.value && r && !paramCompatible(decl.type, r)) {
      rep('CALL_PARAM_TYPE', prm.value.range, { name });
    }
  }
  if (iface && (callee.kind === 'FC' || callee.kind === 'SFC')) {
    for (const m of known) {
      if (!seen.has(labelKey(m.name)))
        rep('CALL_PARAM_MISSING', st.instruction.range, { name: m.name });
    }
  }
}
