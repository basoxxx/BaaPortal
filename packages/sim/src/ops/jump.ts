import { SimError } from '../errors';
import type { ExecState, OpHandler } from '../executor';

function target(stmt: Parameters<OpHandler>[1]): { jump: number } {
  if (stmt.jumpTo === undefined)
    throw new SimError('MC7_NON_ESEGUIBILE', `${stmt.id} senza destinazione`);
  return { jump: stmt.jumpTo };
}

/**
 * Manuale AWL, «JC», «JCN», «JCB», «JNB», «JBI», «JNBI»: dopo l'istruzione (saltata o no)
 * OR = 0, STA = 1, RLO = 1, /FC = 0.
 */
function endJump(st: ExecState): void {
  const s = st.regs.stw;
  s.or = false;
  s.sta = true;
  s.rlo = true;
  s.fc = false;
}

/** Salto condizionato dall'RLO (JC/JCN) o dal bit BR (JBI/JNBI); `copyBr` per JCB/JNB. */
function onRlo(when: boolean, copyBr: boolean): OpHandler {
  return (st, stmt) => {
    const s = st.regs.stw;
    const take = s.rlo === when;
    if (copyBr) s.br = s.rlo;
    endJump(st);
    return take ? target(stmt) : undefined;
  };
}

function onBr(when: boolean): OpHandler {
  return (st, stmt) => {
    const take = st.regs.stw.br === when;
    endJump(st);
    return take ? target(stmt) : undefined;
  };
}

/** Salti sul codice di condizione CC1/CC0 (manuale AWL, «Parola di stato»); non toccano la parola di stato. */
function onCc(test: (cc0: boolean, cc1: boolean) => boolean): OpHandler {
  return (st, stmt) => (test(st.regs.stw.cc0, st.regs.stw.cc1) ? target(stmt) : undefined);
}

export const JUMP_OPS: Record<string, OpHandler> = {
  JU: (_st, stmt) => target(stmt),
  JC: onRlo(true, false),
  JCN: onRlo(false, false),
  // Manuale AWL, «JCB» e «JNB»: l'RLO passa in BR.
  JCB: onRlo(true, true),
  JNB: onRlo(false, true),
  JBI: onBr(true),
  JNBI: onBr(false),
  JO: (st, stmt) => (st.regs.stw.ov ? target(stmt) : undefined),
  // Manuale AWL, «JOS»: salta se OS = 1 e azzera OS.
  JOS: (st, stmt) => {
    const take = st.regs.stw.os;
    st.regs.stw.os = false;
    return take ? target(stmt) : undefined;
  },
  JZ: onCc((c0, c1) => !c0 && !c1),
  JN: onCc((c0, c1) => c0 !== c1),
  JP: onCc((c0, c1) => !c0 && c1),
  JM: onCc((c0, c1) => c0 && !c1),
  JPZ: onCc((c0) => !c0),
  JMZ: onCc((_c0, c1) => !c1),
  JUO: onCc((c0, c1) => c0 && c1),
  // Manuale AWL, «JL»: ACCU1-LL sceglie la voce della lista di JU che segue; fuori lista salta
  // all'etichetta (JL + 4 + 4·voci). Non tocca la parola di stato.
  JL: (st, stmt) => {
    const end = target(stmt).jump;
    const entries = (end - st.offset - 4) / 4;
    const v = st.regs.accu1 & 0xff;
    return v < entries ? { jump: st.offset + 4 + 4 * v } : { jump: end };
  },
  // Manuale AWL, «LOOP»: ACCU1-L - 1; salta se il risultato non è 0.
  LOOP: (st, stmt) => {
    const low = ((st.regs.accu1 & 0xffff) - 1) & 0xffff;
    st.regs.accu1 = ((st.regs.accu1 & 0xffff0000) | low) >>> 0;
    return low !== 0 ? target(stmt) : undefined;
  },
};
