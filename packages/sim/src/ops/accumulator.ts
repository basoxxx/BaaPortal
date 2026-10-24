import type { Operand } from '@baaportal/awl';
import { SimError } from '../errors';
import type { ExecState, OpHandler } from '../executor';
import { resolveOperand, writeBits } from '../operands';
import { constantValue, readMem } from './loadTransfer';

type Ar = 'ar1' | 'ar2';

/** Parte indirizzo di AR1/AR2: bit 0–23 (manuale AWL, «Formato dei puntatori»). */
const ADDR = 0xffffff;

function loadAr(ar: Ar): OpHandler {
  return (st, stmt) => {
    const op = stmt.operand;
    let v: number;
    if (!op) v = st.regs.accu1;
    else if (op.kind === 'constant') v = constantValue(op);
    else if (op.kind === 'special' && op.name === 'AR2') v = st.regs.ar2;
    else {
      if (op.kind !== 'address' && op.kind !== 'indirect')
        throw new SimError('MC7_NON_ESEGUIBILE', 'LAR: operando non valido');
      if (op.size !== 'D') throw new SimError('MC7_NON_ESEGUIBILE', 'LAR: serve una doppia parola');
      v = readMem(st, op);
    }
    st.regs[ar] = v >>> 0;
  };
}

function transferAr(ar: Ar): OpHandler {
  return (st, stmt) => {
    const op = stmt.operand;
    const v = st.regs[ar];
    if (!op) {
      // Manuale AWL, «TAR1»/«TAR2» senza operando: ACCU1 passa in ACCU2, poi riceve l'AR.
      st.regs.accu2 = st.regs.accu1;
      st.regs.accu1 = v;
    } else if (op.kind === 'special' && op.name === 'AR2') st.regs.ar2 = v;
    else writeD(st, op, v);
  };
}

function writeD(st: ExecState, op: Operand, v: number): void {
  if (op.kind !== 'address' && op.kind !== 'indirect')
    throw new SimError('MC7_NON_ESEGUIBILE', 'TAR: operando non valido');
  if (op.size !== 'D') throw new SimError('MC7_NON_ESEGUIBILE', 'TAR: serve una doppia parola');
  writeBits(st.mem, resolveOperand(op, st.regs, st.mem, st.frame), 'D', v);
}

function addAr(ar: Ar): OpHandler {
  return (st, stmt) => {
    // Manuale AWL, «+AR1», «+AR2»: senza operando si somma ACCU1-L con segno, con P#x.y quel
    // puntatore; l'offset è esteso a 24 bit e si somma ai bit 0–23, area e bit 31 non cambiano.
    const add = stmt.operand ? constantValue(stmt.operand) : ((st.regs.accu1 & 0xffff) << 16) >> 16;
    const cur = st.regs[ar];
    st.regs[ar] = ((cur & ~ADDR) | ((cur + add) & ADDR)) >>> 0;
  };
}

function incDec(sign: 1 | -1): OpHandler {
  return (st, stmt) => {
    // Manuale AWL, «INC», «DEC»: solo ACCU1-LL, senza riporto; la parola di stato non cambia.
    const n = constantValue(stmt.operand) & 0xff;
    const a = st.regs.accu1;
    st.regs.accu1 = ((a & 0xffffff00) | ((a + sign * n) & 0xff)) >>> 0;
  };
}

const nonS7300: OpHandler = (_st, stmt) => {
  throw new SimError('ISTRUZIONE_NON_S7300', stmt.id);
};

export const ACCUMULATOR_OPS: Record<string, OpHandler> = {
  LAR1: loadAr('ar1'),
  LAR2: loadAr('ar2'),
  TAR1: transferAr('ar1'),
  TAR2: transferAr('ar2'),
  CAR: (st) => {
    [st.regs.ar1, st.regs.ar2] = [st.regs.ar2, st.regs.ar1];
  },
  TAK: (st) => {
    [st.regs.accu1, st.regs.accu2] = [st.regs.accu2, st.regs.accu1];
  },
  PUSH: (st) => {
    st.regs.accu2 = st.regs.accu1;
  },
  POP: (st) => {
    st.regs.accu1 = st.regs.accu2;
  },
  ENT: nonS7300,
  LEAVE: nonS7300,
  INC: incDec(1),
  DEC: incDec(-1),
  '+AR1': addAr('ar1'),
  '+AR2': addAr('ar2'),
};
