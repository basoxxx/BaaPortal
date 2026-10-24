import { SimError } from './errors';
import { execBlock, newExecState, type ExecState } from './executor';
import type { FrameView, Location } from './operands';

/** Profondità massima dei blocchi annidati: costante 16 (R6); nel manuale delle CPU 31x il valore varia con la CPU (vedi sim.md §3). */
export const MAX_BLOCK_STACK = 16;

const ADDR_MASK = 0x7ffff;

/**
 * Puntatore della lista dei parametri di una FC (mc7 §2.2.4, §2.5) → posizione assoluta.
 * `L` e `V` indicano i dati locali del blocco che contiene la chiamata. Puntatori senza area
 * (TIMER, COUNTER, BLOCK) non sono in memoria: `null`.
 */
export function pointerLocation(st: ExecState, p: Uint8Array): Location | null {
  const a = p[0]!;
  if (a < 0x80 || a > 0x87) return null;
  const bit = ((p[1]! << 16) | (p[2]! << 8) | p[3]!) & ADDR_MASK;
  switch (a & 7) {
    case 0:
      return { area: 'P', db: null, bit };
    case 1:
      return { area: 'I', db: null, bit };
    case 2:
      return { area: 'Q', db: null, bit };
    case 3:
      return { area: 'M', db: null, bit };
    case 4:
      return { area: 'DB', db: st.regs.db || null, bit };
    case 5:
      return { area: 'DI', db: st.regs.di || null, bit };
    default: {
      const size = st.frame.lSize ?? st.block.localBytes;
      return { area: 'L', db: null, bit: bit + st.frame.lBase * 8, limit: st.frame.lBase + size };
    }
  }
}

/**
 * Richiama un FC o un FB con un nuovo stato di esecuzione: stack di annidamento e MCR propri (il
 * richiamato parte con MCR inattivo; quelli del chiamante restano nel suo stato), finestra L nuova
 * subito dopo quella del chiamante, DB e DI ripristinati al ritorno. Il codice dell'FB apre il DI e
 * carica AR2 da sé (mc7 §2.5): l'esecutore non fa altro.
 */
export function callBlock(
  st: ExecState,
  kind: 'FC' | 'FB',
  number: number,
  pointers?: readonly Uint8Array[],
): void {
  const callee = st.ctx.program.get(kind, number);
  if (!callee)
    throw new SimError('BLOCCO_NON_CARICATO', `${kind}${number}`, {
      missingBlock: kind,
      faultReg: number,
    });
  if (st.depth + 1 > MAX_BLOCK_STACK)
    throw new SimError('STACK_BLOCCHI_PIENO', `oltre ${MAX_BLOCK_STACK} blocchi annidati`);
  const callerSize = st.frame.lSize ?? st.block.localBytes;
  const lBase = st.frame.lBase + callerSize;
  if (lBase + callee.localBytes > st.mem.L.length)
    throw new SimError('STACK_L_PIENO', `${kind}${number}: ${callee.localBytes} byte`);
  const frame: FrameView = {
    lBase,
    prevLBase: st.frame.lBase,
    lSize: callee.localBytes,
    prevLSize: callerSize,
    ...(pointers
      ? { params: pointers.map((p) => pointerLocation(st, p)), rawParams: pointers }
      : {}),
  };
  const { db, di } = st.regs;
  execBlock(newExecState(st.ctx, callee, frame, st.depth + 1));
  st.regs.db = db;
  st.regs.di = di;
}
