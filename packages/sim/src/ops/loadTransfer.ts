import type { Operand } from '@baaportal/awl';
import { parseConstant } from '@baaportal/mc7';
import { SimError } from '../errors';
import type { ExecState, OpHandler } from '../executor';
import { readBits, resolveOperand, writeBits } from '../operands';
import { stwToWord, wordToStw } from '../registers';
import { mcrOff } from './bitLogic';
import { timerNumber } from './timer';

/** Valore a 32 bit (big-endian) della costante AWL di un operando `constant`. */
export function constantValue(op: Operand | undefined): number {
  if (!op || op.kind !== 'constant') throw new SimError('MC7_NON_ESEGUIBILE', 'costante attesa');
  const c = parseConstant(op.text);
  if (!c) throw new SimError('MC7_NON_ESEGUIBILE', `costante ${op.text}`);
  return c.data.reduce((a, b) => a * 256 + b, 0) >>> 0;
}

const SIZE_MASK = { B: 0xff, W: 0xffff, D: 0xffffffff } as const;

function memSize(op: Operand): 'B' | 'W' | 'D' {
  // Parametro formale: l'esecutore ha messo la dimensione ricavata dal tipo dell'istruzione.
  if (op.kind === 'local' && 'size' in op && ['B', 'W', 'D'].includes(op.size as string))
    return op.size as 'B' | 'W' | 'D';
  if ((op.kind === 'address' || op.kind === 'indirect') && op.size && op.size !== 'X')
    return op.size;
  throw new SimError('MC7_NON_ESEGUIBILE', 'operando a byte, parola o doppia parola atteso');
}

/** Legge un operando di memoria (indirizzo assoluto o indiretto), a zero esteso. */
export function readMem(st: ExecState, op: Operand | undefined, formal?: { type: string }): number {
  if (!op) throw new SimError('MC7_NON_ESEGUIBILE', 'operando mancante');
  // Manuale AWL S7-300/400, «L T»: residuo binario 0–999, senza base.
  if (
    ((op.kind === 'timerCounter' || op.kind === 'indirect') && op.area === 'T') ||
    (op.kind === 'local' && formal?.type === 'Timer')
  )
    return st.ctx.timers.value(timerNumber(st, op)).units;
  if (op.kind === 'timerCounter') throw new SimError('NON_SIMULATA_2B', `${op.area}${op.number}`);
  const loc = resolveOperand(op, st.regs, st.mem, st.frame);
  return readBits(st.mem, loc, memSize(op)) >>> 0;
}

function dbLength(st: ExecState, n: number): number {
  return n === 0 ? 0 : (st.mem.dbs.get(n)?.data.length ?? 0);
}

function special(st: ExecState, name: string): number {
  const r = st.regs;
  switch (name) {
    case 'STW':
      // Manuale AWL S7-300/400, «L STW»: bit 0 /FC … bit 8 BR.
      return stwToWord(r.stw);
    case 'DBLG':
      return dbLength(st, r.db);
    case 'DBNO':
      return r.db;
    case 'DILG':
      return dbLength(st, r.di);
    case 'DINO':
      return r.di;
    default:
      throw new SimError('MC7_NON_ESEGUIBILE', `L ${name}`);
  }
}

function loadValue(st: ExecState, op: Operand | undefined, formal?: { type: string }): number {
  switch (op?.kind) {
    case 'constant':
      return constantValue(op);
    case 'special':
      return special(st, op.name);
    default:
      return readMem(st, op, formal);
  }
}

/** Manuale AWL S7-300/400, «L»: ACCU1 passa in ACCU2, poi si carica; byte e parola a zero esteso. */
const L: OpHandler = (st, stmt) => {
  const v = loadValue(st, stmt.operand, stmt.formal);
  st.regs.accu2 = st.regs.accu1;
  st.regs.accu1 = v >>> 0;
};

/** Manuale AWL S7-300/400, «T»: scrive la parte bassa dell'ACCU1; con MCR spento scrive 0. */
const T: OpHandler = (st, stmt) => {
  const op = stmt.operand;
  if (op?.kind === 'special' && op.name === 'STW') {
    // Manuale AWL S7-300/400, «T STW»: tutti i bit 0–8 tranne /FC.
    const fc = st.regs.stw.fc;
    st.regs.stw = { ...wordToStw(st.regs.accu1 & 0x1ff), fc };
    return;
  }
  if (!op || op.kind === 'special' || op.kind === 'constant')
    throw new SimError('MC7_NON_ESEGUIBILE', 'T: operando non valido');
  if (op.kind === 'timerCounter') throw new SimError('NON_SIMULATA_2B', `${op.area}${op.number}`);
  // Solo le scritture in memoria seguono l'MCR (non T STW).
  const value = mcrOff(st) ? 0 : st.regs.accu1;
  const size = memSize(op);
  writeBits(
    st.mem,
    resolveOperand(op, st.regs, st.mem, st.frame),
    size,
    (value & SIZE_MASK[size]) >>> 0,
  );
};

export const LOAD_TRANSFER_OPS: Record<string, OpHandler> = { L, T };
