import type { Operand } from '@baaportal/awl';
import { SimError } from '../errors';
import type { ExecState, OpHandler } from '../executor';
import { readBits, resolveOperand, writeBits } from '../operands';

/** Profondità dello stack di annidamento delle parentesi (S7-300: 7 livelli). */
export const NEST_DEPTH = 7;
/** Profondità dello stack MCR (8 livelli). */
export const MCR_DEPTH = 8;

export type ChainFn = 'A' | 'O' | 'X';

/**
 * Riallinea la catena interna all'RLO della parola di stato. Se un'altra istruzione (confronto,
 * L STW, ...) ha scritto l'RLO, la catena riparte da quel valore.
 */
function sync(st: ExecState): void {
  const c = st.chain;
  if (st.regs.stw.rlo !== (c.done || c.term)) {
    c.done = false;
    c.term = st.regs.stw.rlo;
  }
}

/** Imposta RLO e catena insieme; `done` falso. */
function setRlo(st: ExecState, v: boolean): void {
  st.chain.done = false;
  st.chain.term = v;
  st.regs.stw.rlo = v;
}

/**
 * Logica di prima interrogazione (/FC) per A, O e X, condivisa con i confronti.
 * Manuale AWL, «Operazioni di combinazione logica a bit» e «Parola di stato»:
 * - /FC = 0: il risultato dell'interrogazione diventa l'RLO (inizio catena);
 * - /FC = 1: A fa l'AND con il termine in corso; O chiude il termine e ne apre uno nuovo
 *   (l'AND precede l'OR); X fa l'OR esclusivo con l'RLO.
 * Poi /FC = 1; STA = `sta` (di norma il bit interrogato, non negato); OR = termini OR già chiusi.
 */
export function checkBit(st: ExecState, fn: ChainFn, v: boolean, sta: boolean): void {
  sync(st);
  combine(st, fn, v, sta);
}

function combine(st: ExecState, fn: ChainFn, v: boolean, sta: boolean): void {
  const c = st.chain;
  const s = st.regs.stw;
  if (fn === 'A') c.term = s.fc ? c.term && v : v;
  else if (fn === 'O') {
    if (s.fc) c.done = c.done || c.term;
    c.term = v;
  } else {
    const x = s.fc ? c.done || c.term !== v : v;
    c.done = false;
    c.term = x;
  }
  s.fc = true;
  s.rlo = c.done || c.term;
  s.sta = sta;
  s.or = c.done;
}

/** Valore di un operando a bit: bit di memoria o condizione di stato (`A ==0`, `A OV`, ...). */
function bitValue(st: ExecState, op: Operand | undefined): boolean {
  if (!op) throw new SimError('MC7_NON_ESEGUIBILE', 'operando mancante');
  const s = st.regs.stw;
  switch (op.kind) {
    case 'status':
      // Manuale AWL, «Parola di stato»: decodifica di CC0/CC1 (==0, >0, <0, <>0, >=0, <=0, UO).
      switch (op.condition) {
        case '==0':
          return !s.cc0 && !s.cc1;
        case '>0':
          return !s.cc0 && s.cc1;
        case '<0':
          return s.cc0 && !s.cc1;
        case '<>0':
          return s.cc0 !== s.cc1;
        case '>=0':
          return !s.cc0;
        case '<=0':
          return !s.cc1;
        case 'UO':
          return s.cc0 && s.cc1;
        case 'OV':
          return s.ov;
        case 'OS':
          return s.os;
        case 'BR':
          return s.br;
        default:
          throw new SimError('MC7_NON_ESEGUIBILE', `condizione ${op.condition}`);
      }
    case 'timerCounter':
      throw new SimError('NON_SIMULATA_2B', `${op.area}${op.number}`);
    case 'address':
    case 'indirect':
      return readBits(st.mem, resolveOperand(op, st.regs, st.mem, st.frame), 'X') === 1;
    default:
      throw new SimError('MC7_NON_ESEGUIBILE', `operando ${op.kind}`);
  }
}

function bitLocation(st: ExecState, op: Operand | undefined): ReturnType<typeof resolveOperand> {
  if (!op) throw new SimError('MC7_NON_ESEGUIBILE', 'operando mancante');
  if (op.kind === 'timerCounter') throw new SimError('NON_SIMULATA_2B', `${op.area}${op.number}`);
  return resolveOperand(op, st.regs, st.mem, st.frame);
}

/** Vero con MCR attivo (MCRA) e dentro una zona MCR( con RLO 0: le scritture diventano 0. */
export function mcrOff(st: ExecState): boolean {
  return st.mcr.active && st.mcr.stack.some((v) => !v);
}

function interrogation(fn: ChainFn, negate: boolean): OpHandler {
  return (st, stmt) => {
    const b = bitValue(st, stmt.operand);
    checkBit(st, fn, negate ? !b : b, b);
  };
}

/** Fine della catena: /FC = 0, OR = 0; l'RLO resta com'è. */
function endChain(st: ExecState): void {
  const s = st.regs.stw;
  s.fc = false;
  s.or = false;
  setRlo(st, s.rlo);
}

function open(fn: ChainFn, negate: boolean): OpHandler {
  return (st) => {
    sync(st);
    if (st.nest.length >= NEST_DEPTH)
      throw new SimError('STACK_ANNIDAMENTO_PIENO', 'parentesi annidate');
    const s = st.regs.stw;
    st.nest.push({ done: st.chain.done, term: st.chain.term, fc: s.fc, fn, negate });
    // Dentro la parentesi la catena riparte con /FC = 0.
    st.chain.done = false;
    st.chain.term = false;
    s.fc = false;
    s.or = false;
  };
}

const close: OpHandler = (st) => {
  const e = st.nest.pop();
  if (!e) throw new SimError('MC7_NON_ESEGUIBILE', 'parentesi chiusa senza apertura');
  sync(st);
  const s = st.regs.stw;
  const inner = e.negate ? !s.rlo : s.rlo;
  // Si ricompone con la catena salvata come farebbe l'interrogazione corrispondente.
  st.chain.done = e.done;
  st.chain.term = e.term;
  s.fc = e.fc;
  combine(st, e.fn, inner, true);
};

const OR_BLOCKS: OpHandler = (st) => {
  // Manuale AWL, «O»: AND prima di OR. Chiude il termine AND in corso; la catena riparte.
  sync(st);
  const c = st.chain;
  c.done = c.done || c.term;
  c.term = false;
  st.regs.stw.fc = false;
  st.regs.stw.or = c.done;
};

function edge(rising: boolean): OpHandler {
  return (st, stmt) => {
    // Manuale AWL, «FP»/«FN»: l'RLO corrente è confrontato col merker di fronte, che poi lo memorizza.
    sync(st);
    const cur = st.regs.stw.rlo;
    const loc = bitLocation(st, stmt.operand);
    const prev = readBits(st.mem, loc, 'X') === 1;
    writeBits(st.mem, loc, 'X', cur ? 1 : 0);
    const out = rising ? cur && !prev : !cur && prev;
    const s = st.regs.stw;
    setRlo(st, out);
    s.fc = true;
    s.sta = out;
    s.or = false;
  };
}

function setReset(value: 0 | 1): OpHandler {
  return (st, stmt) => {
    sync(st);
    const s = st.regs.stw;
    const loc = bitLocation(st, stmt.operand);
    // Manuale AWL, «S»/«R»: agiscono solo con RLO = 1 (e fuori da una zona MCR spenta).
    if (s.rlo && !mcrOff(st)) writeBits(st.mem, loc, 'X', value);
    s.sta = readBits(st.mem, loc, 'X') === 1;
    endChain(st);
  };
}

export const BIT_OPS: Record<string, OpHandler> = {
  A: interrogation('A', false),
  AN: interrogation('A', true),
  O: (st, stmt) => (stmt.operand ? interrogation('O', false)(st, stmt) : OR_BLOCKS(st, stmt)),
  ON: interrogation('O', true),
  X: interrogation('X', false),
  XN: interrogation('X', true),
  'A(': open('A', false),
  'AN(': open('A', true),
  'O(': open('O', false),
  'ON(': open('O', true),
  'X(': open('X', false),
  'XN(': open('X', true),
  ')': close,
  '=': (st, stmt) => {
    sync(st);
    const loc = bitLocation(st, stmt.operand);
    // Con MCR attivo e RLO dell'MCR a 0, `=` scrive 0.
    const v = st.regs.stw.rlo && !mcrOff(st);
    writeBits(st.mem, loc, 'X', v ? 1 : 0);
    st.regs.stw.sta = v;
    endChain(st);
  },
  S: setReset(1),
  R: setReset(0),
  NOT: (st) => {
    sync(st);
    const s = st.regs.stw;
    setRlo(st, !s.rlo);
    s.fc = true;
    s.sta = true;
    s.or = false;
  },
  SET: (st) => setConst(st, true),
  CLR: (st) => setConst(st, false),
  SAVE: (st) => {
    st.regs.stw.br = st.regs.stw.rlo;
  },
  FP: edge(true),
  FN: edge(false),
  // Manuale AWL, «MCR»: pila di 8 livelli degli RLO salvati.
  'MCR(': (st) => {
    sync(st);
    if (st.mcr.stack.length >= MCR_DEPTH)
      throw new SimError('STACK_ANNIDAMENTO_PIENO', 'MCR annidati');
    st.mcr.stack.push(st.regs.stw.rlo);
    endChain(st);
  },
  ')MCR': (st) => {
    if (st.mcr.stack.pop() === undefined)
      throw new SimError('MC7_NON_ESEGUIBILE', ')MCR senza MCR(');
  },
  MCRA: (st) => {
    st.mcr.active = true;
  },
  MCRD: (st) => {
    st.mcr.active = false;
  },
};

function setConst(st: ExecState, v: boolean): void {
  const s = st.regs.stw;
  setRlo(st, v);
  s.fc = false;
  s.sta = v;
  s.or = false;
}
