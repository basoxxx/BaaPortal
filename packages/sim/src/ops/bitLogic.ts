import type { Operand } from '@baaportal/awl';
import { SimError } from '../errors';
import type { ExecState, OpHandler } from '../executor';
import { readBits, resolveOperand, writeBits } from '../operands';
import { timerNumber } from './timer';

/** Profondità dello stack di annidamento delle parentesi (S7-300: 7 livelli). */
export const NEST_DEPTH = 7;
/** Profondità dello stack MCR (8 livelli). */
export const MCR_DEPTH = 8;

export type ChainFn = 'A' | 'O' | 'X';

/**
 * Logica di prima interrogazione (/FC) per A, O e X, condivisa con i confronti.
 * manuale AWL S7-300/400, operazioni logiche a bit e «Parola di stato» (solo bit reali):
 * - A: RLO = (/FC ? RLO AND v : v) OR OR-bit; l'OR-bit resta;
 * - O: RLO = /FC ? RLO OR v : v; OR-bit = 0;
 * - X: RLO = /FC ? RLO XOR v : v; OR-bit = 0.
 * Poi /FC = 1 e STA = `sta` (di norma il bit interrogato, non negato).
 */
export function checkBit(st: ExecState, fn: ChainFn, v: boolean, sta: boolean): void {
  const s = st.regs.stw;
  if (fn === 'A') s.rlo = (s.fc ? s.rlo && v : v) || s.or;
  else {
    s.rlo = s.fc ? (fn === 'O' ? s.rlo || v : s.rlo !== v) : v;
    s.or = false;
  }
  s.fc = true;
  s.sta = sta;
}

/** Valore di un operando a bit: bit di memoria o condizione di stato (`A ==0`, `A OV`, ...). */
function bitValue(st: ExecState, op: Operand | undefined): boolean {
  if (!op) throw new SimError('MC7_NON_ESEGUIBILE', 'operando mancante');
  const s = st.regs.stw;
  switch (op.kind) {
    case 'status':
      // Manuale AWL S7-300/400, parola di stato: decodifica di CC0/CC1 (==0, >0, <0, <>0, >=0, <=0, UO).
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
    case 'indirect':
      if (op.area === 'T') return st.ctx.timers.q(timerNumber(st, op));
      if (op.area === 'C') throw new SimError('NON_SIMULATA_2B', 'contatore');
      return readBits(st.mem, resolveOperand(op, st.regs, st.mem, st.frame), 'X') === 1;
    case 'address':
    case 'local':
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

/** Fine della catena (=, S, R): /FC = 0, OR = 0; l'RLO resta com'è. */
function endChain(st: ExecState): void {
  st.regs.stw.fc = false;
  st.regs.stw.or = false;
}

function open(fn: ChainFn, negate: boolean): OpHandler {
  return (st) => {
    if (st.nest.length >= NEST_DEPTH)
      throw new SimError('STACK_ANNIDAMENTO_PIENO', 'parentesi annidate');
    const s = st.regs.stw;
    st.nest.push({ rlo: s.rlo, or: s.or, fc: s.fc, fn, negate });
    // Manuale AWL S7-300/400, «A(»: OR = 0, STA = 1, /FC = 0; RLO invariato.
    s.or = false;
    s.sta = true;
    s.fc = false;
  };
}

const close: OpHandler = (st) => {
  const e = st.nest.pop();
  if (!e) throw new SimError('MC7_NON_ESEGUIBILE', 'parentesi chiusa senza apertura');
  const s = st.regs.stw;
  const inner = e.negate ? !s.rlo : s.rlo;
  // Si combina l'RLO salvato con quello interno secondo la funzione salvata (senza catena prima
  // della parentesi, il risultato è l'RLO interno). Per A( / AN( si aggiunge l'OR salvato.
  if (e.fn === 'A') s.rlo = (e.fc ? e.rlo && inner : inner) || e.or;
  else if (e.fn === 'O') s.rlo = e.fc ? e.rlo || inner : inner;
  else s.rlo = e.fc ? e.rlo !== inner : inner;
  s.or = e.or;
  s.sta = true;
  s.fc = true;
};

const OR_BLOCKS: OpHandler = (st) => {
  // Manuale AWL S7-300/400, «O» (AND prima di OR): OR := RLO, STA = 1, /FC = 0; RLO invariato.
  const s = st.regs.stw;
  s.or = s.rlo;
  s.sta = true;
  s.fc = false;
};

function edge(rising: boolean): OpHandler {
  return (st, stmt) => {
    // Manuale AWL S7-300/400, «FP»/«FN»: l'RLO corrente è confrontato col merker di fronte, che poi lo memorizza.
    const cur = st.regs.stw.rlo;
    const loc = bitLocation(st, stmt.operand);
    const prev = readBits(st.mem, loc, 'X') === 1;
    writeBits(st.mem, loc, 'X', cur ? 1 : 0);
    const out = rising ? cur && !prev : !cur && prev;
    const s = st.regs.stw;
    s.rlo = out;
    s.fc = true;
    s.sta = out;
    s.or = false;
  };
}

function isTimerOperand(op: Operand | undefined): boolean {
  return (op?.kind === 'timerCounter' || op?.kind === 'indirect') && op.area === 'T';
}

function setReset(value: 0 | 1): OpHandler {
  return (st, stmt) => {
    const s = st.regs.stw;
    if (value === 0 && isTimerOperand(stmt.operand)) {
      // Manuale AWL S7-300/400, «R» su temporizzatore: con RLO = 1 azzera tempo e Q.
      st.ctx.timers.resetOp(timerNumber(st, stmt.operand), s.rlo);
      s.sta = s.rlo;
      endChain(st);
      return;
    }
    const loc = bitLocation(st, stmt.operand);
    // Manuale AWL S7-300/400, «S»/«R»: agiscono solo con RLO = 1 (e fuori da una zona MCR spenta).
    if (s.rlo && !mcrOff(st)) writeBits(st.mem, loc, 'X', value);
    s.sta = s.rlo;
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
    const loc = bitLocation(st, stmt.operand);
    // Con MCR attivo e RLO dell'MCR a 0, `=` scrive 0.
    const v = st.regs.stw.rlo && !mcrOff(st);
    writeBits(st.mem, loc, 'X', v ? 1 : 0);
    st.regs.stw.sta = v;
    endChain(st);
  },
  S: setReset(1),
  R: setReset(0),
  // Manuale AWL S7-300/400, «NOT»: RLO invertito, STA = 1; /FC e OR restano.
  NOT: (st) => {
    st.regs.stw.rlo = !st.regs.stw.rlo;
    st.regs.stw.sta = true;
  },
  SET: (st) => setConst(st, true),
  CLR: (st) => setConst(st, false),
  SAVE: (st) => {
    st.regs.stw.br = st.regs.stw.rlo;
  },
  FP: edge(true),
  FN: edge(false),
  // Manuale AWL S7-300/400, «MCR»: pila di 8 livelli degli RLO salvati.
  'MCR(': (st) => {
    if (st.mcr.stack.length >= MCR_DEPTH)
      throw new SimError('STACK_ANNIDAMENTO_PIENO', 'MCR annidati');
    st.mcr.stack.push(st.regs.stw.rlo);
    mcrStatus(st);
  },
  ')MCR': (st) => {
    if (st.mcr.stack.pop() === undefined)
      throw new SimError('MC7_NON_ESEGUIBILE', ')MCR senza MCR(');
    mcrStatus(st);
  },
  MCRA: (st) => {
    st.mcr.active = true;
  },
  MCRD: (st) => {
    st.mcr.active = false;
  },
};

/** Manuale AWL S7-300/400, «MCR(» e «)MCR»: OR = 0, STA = 1, RLO = 1, /FC = 0. */
function mcrStatus(st: ExecState): void {
  const s = st.regs.stw;
  s.or = false;
  s.sta = true;
  s.rlo = true;
  s.fc = false;
}

function setConst(st: ExecState, v: boolean): void {
  const s = st.regs.stw;
  s.rlo = v;
  s.fc = false;
  s.sta = v;
  s.or = false;
}
