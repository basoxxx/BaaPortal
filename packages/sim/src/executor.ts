import { decodeInstruction, type DecodedStatement } from '@baaportal/mc7';
import { SimError } from './errors';
import type { SimMemory } from './memory';
import type { FrameView } from './operands';
import { OPS } from './ops';
import type { LoadedBlock, Program } from './program';
import { newRegisters, stwToWord, type Registers } from './registers';
import type { CounterBank } from './counters';
import type { TimerBank } from './timers';

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
  /** Temporizzatori S5 della CPU. */
  timers: TimerBank;
  /** Contatori S5 della CPU. */
  counters: CounterBank;
  maxCycleMs: number;
  cycleStart: number;
  trace?: (t: TraceStep) => void;
  /** Istruzioni eseguite dal ciclo (contatore condiviso fra i blocchi). */
  instructions?: number;
  /**
   * Chiamato ogni `TICK_EVERY` istruzioni, al confine fra due istruzioni del blocco `st`: controllo del
   * tempo di ciclo, merker di clock, interruzioni (OB35, OB82, OB86).
   */
  onTick?: (st: ExecState) => void;
  /** Limite di istruzioni per ciclo (predefinito `MAX_INSTRUCTIONS`). */
  maxInstructions?: number;
  /**
   * Limite di istruzioni superato. Se c'è e ritorna, il ciclo prosegue (OB80 richiamato, contatore
   * azzerato); se manca, l'esecutore lancia TEMPO_CICLO_SUPERATO.
   */
  onOverrun?: (st: ExecState, reason: string) => void;
  /**
   * Errore di un'istruzione del blocco `st` (già con blocco e offset). `true` = gestito al posto
   * dell'istruzione (OB121/OB122 richiamato): i registri si ripristinano e si prosegue con l'istruzione
   * successiva. Se c'è, prima di ogni istruzione si salvano i registri.
   */
  onError?: (e: SimError, st: ExecState) => boolean;
}

/** Istruzioni che scrivono il loro operando: un DB non aperto vi conta come errore in scrittura. */
const WRITES = new Set(['T', '=', 'S', 'R', 'TAR1', 'TAR2']);

/**
 * Stato del blocco salvato prima di un'istruzione, per ripristinarlo se OB121/OB122 la sostituisce.
 * La finestra L (frame) non cambia dentro un'istruzione: un richiamo ne crea una nuova per il
 * richiamato e lascia intatta quella del blocco, quindi non serve salvarla.
 */
interface Saved {
  regs: Registers;
  nest: number;
  mcrActive: boolean;
  mcrDepth: number;
}

function newSaved(): Saved {
  return { regs: newRegisters(), nest: 0, mcrActive: false, mcrDepth: 0 };
}

/** Copia sul posto (un solo oggetto per blocco in esecuzione). */
function save(st: ExecState, s: Saved): void {
  const stw = Object.assign(s.regs.stw, st.regs.stw);
  Object.assign(s.regs, st.regs);
  s.regs.stw = stw;
  s.nest = st.nest.length;
  s.mcrActive = st.mcr.active;
  s.mcrDepth = st.mcr.stack.length;
}

/**
 * Ripristina registri, stack di annidamento e MCR. Gli stack si accorciano soltanto: un'istruzione che
 * fallisce può avere aggiunto un elemento (`A(`, `MCR(`), non toglierlo e poi fallire.
 */
function restore(st: ExecState, s: Saved): void {
  const stw = { ...s.regs.stw };
  Object.assign(st.regs, s.regs);
  st.regs.stw = stw;
  st.nest.length = Math.min(st.nest.length, s.nest);
  st.mcr.active = s.mcrActive;
  st.mcr.stack.length = Math.min(st.mcr.stack.length, s.mcrDepth);
}

/** Ogni quante istruzioni si controlla il tempo di ciclo (Global Constraints, piano 2A). */
export const TICK_EVERY = 1024;

/** Limite fisso di istruzioni per ciclo (e per OB100), indipendente dall'orologio. */
export const MAX_INSTRUCTIONS = 10_000_000;

/** Elemento dello stack di annidamento (manuale AWL S7-300/400, parola di stato): catena salvata e funzione. */
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

/** Stato lasciato al chiamante a fine blocco: OS = OR = 0, STA = 1, /FC = 0; RLO e BR restano. */
export function endBlock(st: ExecState): void {
  // L'OB di primo livello non ha chiamante: il suo stato finale resta ispezionabile.
  if (st.depth === 0) return;
  const s = st.regs.stw;
  s.os = false;
  s.or = false;
  s.sta = true;
  s.fc = false;
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
  // TIMER e COUNTER: il parametro porta un numero, non una posizione di memoria.
  if (f.type === 'Timer' || f.type === 'Counter') return stmt;
  const size = FORMAL_SIZE[f.type];
  if (!size || stmt.operand?.kind !== 'local')
    throw new SimError('NON_SIMULATA_2B', `parametro formale ${f.name} di tipo ${f.type}`);
  return { ...stmt, operand: { ...stmt.operand, size } as typeof stmt.operand };
}

/**
 * Chiede a `ctx.onError` di gestire l'errore. Un errore nuovo lanciato dal gestore (per esempio
 * STACK_L_PIENO se OB121 non entra nello stack L) prende la posizione dell'istruzione che ha sbagliato:
 * così i chiamanti non lo riattribuiscono a sé e non richiamano il gestore una seconda volta.
 */
function handled(ctx: ExecContext, e: SimError, st: ExecState): boolean {
  try {
    return ctx.onError?.(e, st) ?? false;
  } catch (e2) {
    if (e2 instanceof SimError && e2.offset === undefined) {
      e2.block = e.block;
      e2.offset = e.offset;
      e2.network = e.network;
    }
    throw e2;
  }
}

/**
 * Esegue il codice del blocco dall'inizio fino a `BE` o alla fine; gli errori portano blocco e offset.
 * Un errore di un'istruzione passa a `ctx.onError`, che può gestirlo al posto dell'istruzione.
 */
export function execBlock(st: ExecState): void {
  const { block, ctx } = st;
  const code = block.code;
  const max = ctx.maxInstructions ?? MAX_INSTRUCTIONS;
  const scratch = ctx.onError ? newSaved() : undefined;
  let at = 0;
  while (at < code.length) {
    st.offset = at;
    let d: Decoded | undefined;
    let saved = false;
    try {
      const n = (ctx.instructions = (ctx.instructions ?? 0) + 1);
      if (n > max) {
        const reason = `oltre ${max} istruzioni`;
        if (!ctx.onOverrun) throw new SimError('TEMPO_CICLO_SUPERATO', reason);
        ctx.onOverrun(st, reason);
      }
      if (ctx.onTick && (n & (TICK_EVERY - 1)) === 0) ctx.onTick(st);
      d = decodeAt(block, at);
      if (!('stmt' in d)) throw new SimError('MC7_NON_ESEGUIBILE', `byte grezzi a ${at}`);
      const handler = OPS[d.stmt.id];
      if (!handler)
        throw new SimError('MC7_NON_ESEGUIBILE', `operazione non implementata: ${d.stmt.id}`);
      if (scratch) {
        save(st, scratch);
        saved = true;
      }
      const r = handler(st, withFormal(d.stmt));
      ctx.trace?.({
        block: { kind: block.kind, number: block.number },
        offset: at,
        id: d.stmt.id,
        stw: stwToWord(st.regs.stw),
        accu1: st.regs.accu1,
        accu2: st.regs.accu2,
      });
      if (r === 'return') return;
      if (r && typeof r === 'object') {
        if (!instructionStarts(block).has(r.jump))
          throw new SimError(
            'MC7_NON_ESEGUIBILE',
            `salto a ${r.jump}: non è un inizio di istruzione`,
          );
        at = r.jump;
      } else at += d.length;
    } catch (e) {
      // Un errore già localizzato viene da un blocco richiamato (o da un OB d'errore): passa oltre.
      if (!(e instanceof SimError) || e.offset !== undefined) throw e;
      e.block = { kind: block.kind, number: block.number };
      e.offset = at;
      e.network = networkOf(block, at);
      if (d && 'stmt' in d && e.access === undefined && WRITES.has(d.stmt.id)) e.access = 'write';
      // `saved` c'è solo se l'errore viene dall'istruzione (non dal tick): solo allora la si salta.
      if (!saved || !scratch || !d || !handled(ctx, e, st)) throw e;
      restore(st, scratch);
      at += d.length;
    }
  }
  // Fine del codice senza BE: come BE.
  endBlock(st);
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
