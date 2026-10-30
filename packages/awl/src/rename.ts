// Rinomina dei riferimenti nel codice AWL, lavorando solo sui token analizzati.
import { sameName } from '@baaportal/s7-types';
import type { CallParam, Operand, PathSegment, Statement } from './ast';
import type { Mnemonic } from './instructions';
import type { Range } from './lexer';
import { parseDetailed } from './parser';

export type RenameTarget =
  | { kind: 'symbol'; oldName: string }
  | {
      kind: 'member';
      root: 'symbol' | 'local';
      /** null = qualsiasi radice. */
      rootName: string | null;
      path: string[];
      oldName: string;
    }
  | { kind: 'local'; oldName: string }
  | {
      kind: 'callParam';
      block: string;
      oldName: string;
      /** Chiama anche per numero: `CALL FB 3`. */
      number?: { kind: 'FB' | 'FC'; number: number };
      /** Nomi di multi-istanze locali: `CALL #inst`. */
      instances?: string[];
    };

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const bareOrQuoted = (name: string): string => (IDENT.test(name) ? name : `"${name}"`);

interface Edit {
  start: number;
  end: number;
  text: string;
}

function operandsOf(st: Statement): Operand[] {
  const out: Operand[] = [];
  if (st.operand) out.push(st.operand);
  if (st.instanceDb) out.push(st.instanceDb);
  for (const p of st.params ?? []) if (p.value) out.push(p.value);
  return out;
}

/** L'operando stesso e quelli annidati negli accessi indiretti. */
function* walk(op: Operand): Generator<Operand> {
  yield op;
  if (op.kind === 'indirect' && op.via.kind === 'memory') yield* walk(op.via.location);
}

const edit = (r: Range, text: string): Edit => ({ start: r.from.offset, end: r.to.offset, text });

function pathEdits(op: Operand, target: RenameTarget, newName: string, out: Edit[]): void {
  if (op.kind === 'address' && op.dbSymbol && target.kind === 'symbol') {
    if (sameName(op.dbSymbol.name, target.oldName))
      out.push(edit(op.dbSymbol.range, `"${newName}"`));
    return;
  }
  // `P##nome` punta al locale `#nome`: si rinomina come un locale.
  const path =
    op.kind === 'constant' && op.pointerTo
      ? { kind: 'local' as const, path: op.pointerTo }
      : op.kind === 'symbol' || op.kind === 'local'
        ? op
        : null;
  if (!path) return;
  const segs: PathSegment[] = path.path;
  const first = segs[0]!;
  switch (target.kind) {
    case 'symbol':
      if (path.kind === 'symbol' && first.quoted && sameName(first.name, target.oldName)) {
        out.push(edit(first.range, `"${newName}"`));
      }
      return;
    case 'local':
      if (path.kind === 'local' && sameName(first.name, target.oldName)) {
        out.push(edit(first.range, bareOrQuoted(newName)));
      }
      return;
    case 'member': {
      if (path.kind !== target.root) return;
      if (target.rootName !== null && !sameName(first.name, target.rootName)) return;
      const at = 1 + target.path.length;
      const seg = segs[at];
      if (!seg || !sameName(seg.name, target.oldName)) return;
      // Solo i nomi: gli indici di array non contano (il tipo e' lo stesso per ogni elemento).
      if (!target.path.every((n, i) => sameName(n, segs[1 + i]!.name))) return;
      out.push(edit(seg.range, bareOrQuoted(newName)));
      return;
    }
    case 'callParam':
      return;
  }
}

function isTargetCall(callee: Operand, target: RenameTarget): boolean {
  if (target.kind !== 'callParam') return false;
  if (callee.kind === 'symbol') {
    return callee.path.length === 1 && sameName(callee.path[0]!.name, target.block);
  }
  if (callee.kind === 'block') {
    const n = target.number;
    return !!n && callee.blockKind === n.kind && callee.number === n.number;
  }
  if (callee.kind === 'local') {
    return (
      callee.path.length === 1 && !!target.instances?.some((i) => sameName(i, callee.path[0]!.name))
    );
  }
  return false;
}

function paramEdit(
  st: Statement,
  p: CallParam,
  target: RenameTarget,
  newName: string,
  out: Edit[],
): void {
  if (target.kind !== 'callParam' || st.instruction.def?.id !== 'CALL') return;
  const callee = st.operand;
  if (!callee || !isTargetCall(callee, target)) return;
  const name = p.name.startsWith('"') ? p.name.slice(1, -1) : p.name;
  if (sameName(name, target.oldName)) out.push(edit(p.nameRange, bareOrQuoted(newName)));
}

/** Riscrive `source` sostituendo solo i token che si riferiscono a `target`. */
export function renameInSource(
  source: string,
  target: RenameTarget,
  newName: string,
  mnemonic: Mnemonic,
): string {
  // Un nome con virgolette, caratteri di controllo o a capo romperebbe il codice.
  if (/["\u0000-\u001f\u007f\u2028\u2029]/.test(newName)) return source;
  const { statements } = parseDetailed(source, mnemonic);
  const edits: Edit[] = [];
  for (const st of statements) {
    for (const top of operandsOf(st))
      for (const op of walk(top)) pathEdits(op, target, newName, edits);
    for (const p of st.params ?? []) paramEdit(st, p, target, newName, edits);
  }
  return applyEdits(source, edits);
}

function applyEdits(source: string, edits: Edit[]): string {
  if (edits.length === 0) return source;
  edits.sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  for (const e of edits) {
    if (e.start < pos) continue;
    out += source.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  return out + source.slice(pos);
}

/** Famiglia di numerazione: i DB di istanza (e il registro DI) contano come DB. */
export type BlockFamily = 'FB' | 'FC' | 'DB';
/** Il numero nuovo di un blocco; undefined se resta com'è. */
export type Renumber = (family: BlockFamily, n: number) => number | undefined;

/**
 * Riscrive i riferimenti assoluti ai blocchi (`CALL FB 1, DB 2`, `UC FC 3`, `OPN DI 4`, `DB5.DBW 0`,
 * `P#DB5.DBX0.0`) con i numeri di `renumber`. `unsafe`: il testo apre o chiama blocchi in modo
 * indiretto (`OPN DB [MW 10]`) o ha righe non analizzabili (`UC FC [MW 10]`), che non si riscrivono.
 */
export function renumberInSource(
  source: string,
  renumber: Renumber,
  mnemonic: Mnemonic,
): { source: string; unsafe: boolean } {
  const { statements, errors } = parseDetailed(source, mnemonic);
  let unsafe = errors.length > 0;
  const edits: Edit[] = [];
  // Il numero è la prima sequenza di cifre del testo dell'operando, da `skip` in poi.
  const renumbered = (r: Range, family: BlockFamily, n: number, skip = 0) => {
    const to = renumber(family, n);
    if (to === undefined || to === n) return;
    const m = /\d+/.exec(source.slice(r.from.offset + skip, r.to.offset));
    if (m) {
      const start = r.from.offset + skip + m.index;
      edits.push({ start, end: start + m[0].length, text: String(to) });
    }
  };
  for (const st of statements) {
    for (const top of operandsOf(st)) {
      for (const op of walk(top)) {
        if (op.kind === 'block' && op.blockKind !== 'SFB' && op.blockKind !== 'SFC') {
          renumbered(op.range, op.blockKind === 'DI' ? 'DB' : op.blockKind, op.number);
        } else if (op.kind === 'address' && op.db !== undefined) {
          renumbered(op.range, 'DB', op.db);
        } else if (op.kind === 'constant') {
          const p = /^P#DB(\d+)\./i.exec(op.text);
          if (p) renumbered(op.range, 'DB', Number(p[1]), 4);
        } else if (op.kind === 'indirect' && (op.area === 'DB' || op.area === 'DI') && !op.size) {
          unsafe = true;
        }
      }
    }
  }
  return { source: applyEdits(source, edits), unsafe };
}
