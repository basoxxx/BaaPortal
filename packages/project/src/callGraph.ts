// Struttura di chiamata e dipendenze (tappa 7A): chi chiama chi, ricavato dai riferimenti incrociati
// (le CALL, UC e CC, multi-istanze comprese) senza rileggere il codice.
import type { PlcDevice } from './model';
import { COMPUTED_CALL, crossReferences, type XrefOperand, type XrefUse } from './crossRef';

/** Un blocco del grafo: del progetto (`blockId`) o di sistema/mancante (solo la chiave). */
export interface CallBlock {
  /** `OB1`, `FC5`, `SFC20`, `DB2`. */
  key: string;
  name?: string;
  blockId?: string;
}

/** Una chiamata: dove sta (`use`, nel blocco che chiama) e il blocco chiamato. */
export interface CallEdge {
  caller: string;
  callee: string;
  use: XrefUse;
}

export interface CallGraph {
  blocks: Map<string, CallBlock>;
  /** Chiamate per blocco che chiama, nell'ordine del codice. */
  calls: Map<string, CallEdge[]>;
  /** Chiamate per blocco chiamato (le dipendenze: chi lo chiama). */
  callers: Map<string, CallEdge[]>;
  /** Gli OB del progetto, in ordine di numero: le radici della struttura. */
  roots: string[];
  /** Blocchi del progetto (non OB) che nessuno chiama, apre o usa. */
  unreferenced: string[];
  /** Blocchi che, seguendo le chiamate, richiamano sé stessi. */
  recursive: Set<string>;
  /** `UC`/`CC` con destinazione calcolata: il blocco chiamato non si conosce (`callee` è il testo scritto). */
  computed: CallEdge[];
}

const CODE = new Set(['FC', 'FB', 'SFC', 'SFB']);
const keyOf = (b: { kind: string; number: number }) =>
  `${b.kind === 'IDB' ? 'DB' : b.kind}${b.number}`;
const byNumber = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

/** Il grafo delle chiamate del dispositivo; `xref` evita di ricalcolare i riferimenti incrociati. */
export function callGraph(dev: PlcDevice, xref: XrefOperand[] = crossReferences(dev)): CallGraph {
  const blocks = new Map<string, CallBlock>();
  for (const b of dev.blocks) blocks.set(keyOf(b), { key: keyOf(b), name: b.name, blockId: b.id });
  const calls = new Map<string, CallEdge[]>();
  const callers = new Map<string, CallEdge[]>();
  const referenced = new Set<string>();
  const computed: CallEdge[] = [];
  for (const op of xref) {
    if (op.type === COMPUTED_CALL)
      computed.push(...op.uses.map((use) => ({ caller: use.block, callee: op.address, use })));
    if (op.db !== undefined) referenced.add(`DB${op.db}`);
    if (op.kind !== 'block') continue;
    referenced.add(op.key);
    if (!CODE.has(op.type ?? '')) continue;
    if (!blocks.has(op.key))
      blocks.set(op.key, { key: op.key, ...(op.symbol ? { name: op.symbol } : {}) });
    for (const use of op.uses) {
      if (use.access !== 'call') continue;
      const edge = { caller: use.block, callee: op.key, use };
      calls.set(use.block, [...(calls.get(use.block) ?? []), edge]);
      callers.set(op.key, [...(callers.get(op.key) ?? []), edge]);
    }
  }
  const at = (e: CallEdge) => e.use.network * 1e6 + e.use.line;
  for (const list of calls.values()) list.sort((a, b) => at(a) - at(b));
  const project = dev.blocks.map(keyOf);
  const roots = project.filter((k) => k.startsWith('OB')).sort(byNumber);
  const unreferenced = project
    .filter((k) => !k.startsWith('OB') && !referenced.has(k))
    .sort(byNumber);
  // Un blocco è ricorsivo se dalle sue chiamate si torna a lui.
  const recursive = new Set<string>();
  for (const start of calls.keys()) {
    const seen = new Set<string>();
    const stack = (calls.get(start) ?? []).map((e) => e.callee);
    while (stack.length) {
      const k = stack.pop()!;
      if (k === start) {
        recursive.add(start);
        break;
      }
      if (seen.has(k)) continue;
      seen.add(k);
      for (const e of calls.get(k) ?? []) stack.push(e.callee);
    }
  }
  return { blocks, calls, callers, roots, unreferenced, recursive, computed };
}
