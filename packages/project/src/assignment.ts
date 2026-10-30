// Elenco di assegnazione (tappa 7A): per I, Q, M, T e C quali bit e byte usa il programma (dai
// riferimenti incrociati), quali hanno un tag nella tabella dei simboli e dove gli operandi si sovrappongono.
import { parseAddress } from '@baaportal/s7-types';
import type { PlcDevice } from './model';
import type { XrefAccess, XrefOperand } from './crossRef';

export type AssignArea = 'I' | 'Q' | 'M' | 'T' | 'C';
export const ASSIGN_AREAS: readonly AssignArea[] = ['I', 'Q', 'M', 'T', 'C'];
export type UseAccess = 'read' | 'write' | 'readWrite';

/** Un bit (per T e C: un elemento) con ciò che lo tocca. */
export interface AssignCell {
  access?: UseAccess;
  /** Tag della tabella dei simboli che coprono il bit. */
  tags: string[];
  /** Chiavi degli operandi del programma che coprono il bit. */
  keys: string[];
  /** Più operandi (di dimensione diversa) toccano il bit: MW10 con M10.3. */
  overlap: boolean;
}

/** Un byte dell'area (per T e C: otto elementi). */
export interface AssignRow {
  byte: number;
  cells: AssignCell[];
  /** Accesso degli operandi a byte, parola e doppia parola che coprono il byte. */
  sizes: { B?: UseAccess; W?: UseAccess; D?: UseAccess };
  /** Il byte è oltre il limite della CPU. */
  beyondLimit: boolean;
}

export interface AssignAreaList {
  area: AssignArea;
  /** Limite della CPU: byte per I, Q, M; elementi per T e C. */
  limit: number;
  /** Solo i byte usati dal programma o con un tag, per indirizzo. */
  rows: AssignRow[];
  /** Byte (T, C: elementi) usati dal programma. */
  used: number;
}

export interface AssignLimits {
  mBytes: number;
  timers: number;
  counters: number;
  inputBytes: number;
  outputBytes: number;
}

const merge = (a: UseAccess | undefined, b: XrefAccess): UseAccess | undefined => {
  if (b !== 'read' && b !== 'write' && b !== 'readWrite') return a;
  return !a || a === b ? b : 'readWrite';
};

const BYTES = { X: 1, B: 1, W: 2, D: 4 } as const;

/** Le aree dai riferimenti incrociati e dai tag di `dev`; `limits` è `cpu.limits` del catalogo. */
export function assignmentList(
  dev: PlcDevice,
  xref: XrefOperand[],
  limits: AssignLimits,
): AssignAreaList[] {
  const limit: Record<AssignArea, number> = {
    I: limits.inputBytes,
    Q: limits.outputBytes,
    M: limits.mBytes,
    T: limits.timers,
    C: limits.counters,
  };
  const unit = (a: AssignArea) => (a === 'T' || a === 'C' ? 8 : 1);
  const rows = new Map<AssignArea, Map<number, AssignRow>>(ASSIGN_AREAS.map((a) => [a, new Map()]));
  const rowOf = (area: AssignArea, byte: number): AssignRow => {
    let r = rows.get(area)!.get(byte);
    if (!r) {
      const cells = Array.from({ length: 8 }, (): AssignCell => ({
        tags: [],
        keys: [],
        overlap: false,
      }));
      r = { byte, cells, sizes: {}, beyondLimit: byte * unit(area) >= limit[area] };
      rows.get(area)!.set(byte, r);
    }
    return r;
  };
  /** Chiama `fn` per ogni cella toccata dall'indirizzo `text`. */
  const touch = (text: string, fn: (c: AssignCell, r: AssignRow, size: string) => void) => {
    const p = parseAddress(text);
    if (!p.ok) return;
    const a = p.address;
    if (a.area !== 'I' && a.area !== 'Q' && a.area !== 'M' && a.area !== 'T' && a.area !== 'C')
      return;
    if ('number' in a) {
      const r = rowOf(a.area, a.number >> 3);
      fn(r.cells[a.number & 7]!, r, 'X');
      return;
    }
    for (let b = a.byte; b < a.byte + BYTES[a.size]; b++) {
      const r = rowOf(a.area, b);
      if (a.size === 'X') fn(r.cells[a.bit]!, r, 'X');
      else for (const c of r.cells) fn(c, r, a.size);
    }
  };
  for (const op of xref) {
    if (!['I', 'Q', 'M', 'T', 'C'].includes(op.kind)) continue;
    touch(op.address, (c, r, size) => {
      for (const u of op.uses) {
        c.access = merge(c.access, u.access);
        if (size !== 'X') {
          const s = size as 'B' | 'W' | 'D';
          r.sizes[s] = merge(r.sizes[s], u.access);
        }
      }
      if (!c.keys.includes(op.key)) c.keys.push(op.key);
    });
  }
  for (const t of dev.tagTables.flatMap((x) => x.tags)) {
    touch(t.address, (c) => void c.tags.push(t.name));
  }
  return ASSIGN_AREAS.map((area) => {
    const list = [...rows.get(area)!.values()].sort((a, b) => a.byte - b.byte);
    let used = 0;
    for (const r of list) {
      for (const c of r.cells) c.overlap = c.keys.length > 1;
      used +=
        unit(area) === 8
          ? r.cells.filter((c) => c.keys.length).length
          : r.cells.some((c) => c.keys.length)
            ? 1
            : 0;
    }
    return { area, limit: limit[area], rows: list, used };
  });
}
