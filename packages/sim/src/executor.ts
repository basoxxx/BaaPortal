import { decodeInstruction, type DecodedStatement } from '@baaportal/mc7';
import { SimError } from './errors';
import type { SimMemory } from './memory';
import type { FrameView } from './operands';
import { OPS } from './ops';
import type { LoadedBlock, Program } from './program';
import { stwToWord, type Registers } from './registers';

export interface TraceStep {
  block: { kind: string; number: number };
  offset: number;
  id: string;
  stw: number;
  accu1: number;
  accu2: number;
}

export interface ExecContext {
  mem: SimMemory;
  regs: Registers;
  program: Program;
  now(): number;
  maxCycleMs: number;
  cycleStart: number;
  trace?: (t: TraceStep) => void;
}

/** Elemento dello stack di annidamento (manuale AWL, «Parola di stato»): catena salvata e funzione. */
export interface NestEntry {
  rlo: boolean;
  or: boolean;
  fc: boolean;
  fn: 'A' | 'O' | 'X';
  negate: boolean;
}

/** Stato MCR del blocco: attivo (MCRA/MCRD) e pila degli RLO salvati da `MCR(`. */
export interface McrState {
  active: boolean;
  stack: boolean[];
}

/**
 * Stato di esecuzione di un blocco. `nest` è lo stack di annidamento; `mcr` va salvato e ripristinato
 * attorno ai richiami (Task 5).
 */
export interface ExecState {
  ctx: ExecContext;
  regs: Registers;
  mem: SimMemory;
  block: LoadedBlock;
  frame: FrameView;
  /** Offset MC7 dell'istruzione in corso. */
  offset: number;
  nest: NestEntry[];
  mcr: McrState;
  /** Blocchi annidati sopra questo (l'OB è 0). */
  depth: number;
}

export type OpHandler = (
  st: ExecState,
  stmt: DecodedStatement,
) => void | { jump: number } | 'return';

type Decoded = ReturnType<typeof decodeInstruction>;
const CACHE = new WeakMap<LoadedBlock, Map<number, Decoded>>();

function decodeAt(block: LoadedBlock, at: number): Decoded {
  let m = CACHE.get(block);
  if (!m) CACHE.set(block, (m = new Map()));
  let d = m.get(at);
  if (!d) m.set(at, (d = decodeInstruction(block.code, at)));
  return d;
}

function networkOf(block: LoadedBlock, offset: number): number {
  let n = 0;
  block.networkStarts.forEach((s, i) => {
    if (s <= offset) n = i + 1;
  });
  return n;
}

export function newExecState(
  ctx: ExecContext,
  block: LoadedBlock,
  frame?: FrameView,
  depth = 0,
): ExecState {
  return {
    ctx,
    regs: ctx.regs,
    mem: ctx.mem,
    block,
    frame: frame ?? { lBase: 0, prevLBase: 0 },
    offset: 0,
    nest: [],
    mcr: { active: false, stack: [] },
    depth,
  };
}

/** Inizi delle istruzioni del blocco (scansione lineare), per validare le destinazioni dei salti. */
const STARTS = new WeakMap<LoadedBlock, Set<number>>();

function instructionStarts(block: LoadedBlock): Set<number> {
  let set = STARTS.get(block);
  if (set) return set;
  STARTS.set(block, (set = new Set()));
  try {
    for (let at = 0; at < block.code.length;) {
      set.add(at);
      const d = decodeAt(block, at);
      at += Math.max(1, d.length);
    }
  } catch {
    // Byte non decodificabili: le istruzioni oltre non sono raggiungibili con un salto.
  }
  return set;
}

const FORMAL_SIZE: Partial<Record<string, 'X' | 'B' | 'W' | 'D'>> = {
  Bool: 'X',
  Byte: 'B',
  Word: 'W',
  DWord: 'D',
};

/** Parametro formale: la dimensione dell'accesso viene dal tipo della forma dell'istruzione. */
function withFormal(stmt: DecodedStatement): DecodedStatement {
  const f = stmt.formal;
  if (!f) return stmt;
  const size = FORMAL_SIZE[f.type];
  if (!size || stmt.operand?.kind !== 'local')
    throw new SimError('NON_SIMULATA_2B', `parametro formale ${f.name} di tipo ${f.type}`);
  return { ...stmt, operand: { ...stmt.operand, size } as typeof stmt.operand };
}

/** Esegue il codice del blocco dall'inizio fino a `BE` o alla fine; gli errori portano blocco e offset. */
export function execBlock(st: ExecState): void {
  const { block, ctx } = st;
  const code = block.code;
  let at = 0;
  try {
    while (at < code.length) {
      st.offset = at;
      const d = decodeAt(block, at);
      if (!('stmt' in d)) throw new SimError('MC7_NON_ESEGUIBILE', `byte grezzi a ${at}`);
      const handler = OPS[d.stmt.id];
      if (!handler)
        throw new SimError('MC7_NON_ESEGUIBILE', `operazione non implementata: ${d.stmt.id}`);
      const r = handler(st, withFormal(d.stmt));
      ctx.trace?.({
        block: { kind: block.kind, number: block.number },
        offset: at,
        id: d.stmt.id,
        stw: stwToWord(st.regs.stw),
        accu1: st.regs.accu1,
        accu2: st.regs.accu2,
      });
      if (r === 'return') break;
      if (r && typeof r === 'object') {
        if (!instructionStarts(block).has(r.jump))
          throw new SimError(
            'MC7_NON_ESEGUIBILE',
            `salto a ${r.jump}: non è un inizio di istruzione`,
          );
        at = r.jump;
      } else at += d.length;
    }
  } catch (e) {
    if (e instanceof SimError && e.offset === undefined) {
      e.block = { kind: block.kind, number: block.number };
      e.offset = st.offset;
      e.network = networkOf(block, st.offset);
    }
    throw e;
  }
}

/** Esegue un blocco caricato. Lancia SimError (BLOCCO_NON_CARICATO se manca). */
export function runBlock(ctx: ExecContext, kind: 'OB' | 'FB' | 'FC', number: number): void {
  const block = ctx.program.get(kind, number);
  if (!block) throw new SimError('BLOCCO_NON_CARICATO', `${kind}${number}`);
  // L'OB occupa la base dello stack L; senza chiamante, V non ha dati.
  if (block.localBytes > ctx.mem.L.length)
    throw new SimError('STACK_L_PIENO', `${kind}${number}: ${block.localBytes} byte`);
  execBlock(
    newExecState(ctx, block, {
      lBase: 0,
      prevLBase: 0,
      lSize: block.localBytes,
      prevLSize: 0,
    }),
  );
}
