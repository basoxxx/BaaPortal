import type { Operand, Statement } from '@baaportal/awl';

/**
 * Dati locali di un blocco di codice (header byte 32–33, mc7 §1.2, §6.3) e temporanei delle CALL.
 *
 * ⚠️ Le fonti non documentano la regola di STEP 7. Questa è la regola **conservativa** del piano
 * (mc7 §6.3), ricavata e verificata sui 12 blocchi di codice reali (`compile.test.ts`):
 *
 * 1. **Base** = max(fine dei TEMP dichiarati, fine del più alto accesso assoluto all'area L del
 *    sorgente in tutto il blocco), in byte e **senza** arrotondare: FB101 ha un BOOL TEMP in L0.0 e
 *    la copia del parametro della CALL in LW1. Gli accessi assoluti contano perché un dato locale
 *    usato dal sorgente non deve mai essere sovrascritto da una CALL (FB41, SCL: TEMP fino a 60,
 *    accessi del compilatore fino a LD62 → 66). Non contano i temporanei delle CALL già espanse
 *    nel testo (`callBase`).
 * 2. **Temporanei di una CALL**, dalla base, in quest'ordine: il salvataggio di AR2 (4 byte: FB80
 *    LD30, OB1 LD20), il bit del RLO e le copie dei parametri BOOL nello stesso byte (FC1 L0.0 e
 *    L0.1, FC100 L46.0 e L46.1), poi le copie degli altri parametri una dopo l'altra, senza
 *    allineamento (FC1 LW1, FB80 LD35…LD51, FC100 l'ANY da LW47). Le CALL non sono mai attive
 *    insieme: ognuna riparte dalla base.
 * 3. **Dati locali** = max(base, fine del più alto accesso assoluto all'area L, fine dei
 *    temporanei di ogni CALL), arrotondato a un numero pari (FC1 5 → 6, FC21 1 → 2, FB101 3 → 4,
 *    FB80 55 → 56, FC100 57 → 58, OB1 26).
 *
 * TIA calcola la base rete per rete (OB1 reale: LD20 nella rete 1, LD21 nella rete 2 dove il FUP
 * usa L20.0): qui la base vale per tutto il blocco, che è più prudente e dà lo stesso valore finale.
 */

const SIZE_BYTES = { X: 1, B: 1, W: 2, D: 4 } as const;

/** Fine del più alto accesso all'area L di un'istruzione; gli accessi da `from` in su non contano. */
function statementLocalEnd(st: Statement, from = Infinity): number {
  let end = 0;
  const visit = (op: Operand | null | undefined): void => {
    if (!op) return;
    if (op.kind === 'address' && op.area === 'L' && op.size && op.db === undefined) {
      if (op.byte < from) end = Math.max(end, op.byte + SIZE_BYTES[op.size]);
    } else if (op.kind === 'indirect' && op.via.kind === 'memory') {
      visit(op.via.location);
    }
  };
  visit(st.operand);
  visit(st.instanceDb);
  for (const p of st.params ?? []) visit(p.value);
  return end;
}

/** Fine (byte successivo) del più alto accesso assoluto all'area L nelle istruzioni date. */
export function absoluteLocalEnd(statements: readonly Statement[]): number {
  return statements.reduce((end, st) => Math.max(end, statementLocalEnd(st)), 0);
}

/** `BLD n` che apre l'espansione di una CALL (mc7 §2.5): FC, FB, SFC, SFB, multi-istanze. */
const CALL_OPEN = new Set([1, 3, 7, 9, 14, 16]);
const bldOf = (st: Statement): number | undefined =>
  st.instruction.def?.id === 'BLD' && st.operand?.kind === 'constant'
    ? Number(st.operand.text)
    : undefined;
const localAt = (op: Operand | undefined, size: 'X' | 'D'): number | undefined =>
  op?.kind === 'address' && op.area === 'L' && op.size === size && op.db === undefined
    ? op.byte
    : undefined;

/**
 * Base dei temporanei dal sorgente (regola 1) senza i temporanei delle CALL **già espanse** nel
 * testo (un blocco importato con chiamati sconosciuti): dentro `BLD n` … `BLD n+1` il salvataggio
 * del RLO (`= L r` subito dopo `BLD n`) e di AR2 (`TAR2 LD a`) segnano l'inizio `t` dei temporanei
 * di quella CALL, e gli accessi a L da `t` in su sono temporanei suoi, non dati del sorgente: non
 * spostano la base, come in STEP 7 (FC100: base 46 = fine dei TEMP, mentre le CALL espanse usano
 * L46.0…LD53). Gli accessi sotto `t` (OB1 TIA: `A L20.0` dentro la CALL SFB 0) e una CALL espansa
 * senza RLO né AR2 salvati (FB101) contano tutti. La lunghezza dei dati locali li conta sempre.
 */
export function callBase(networks: readonly (readonly Statement[])[]): number {
  let end = 0;
  for (const sts of networks) {
    const from: number[] = sts.map(() => Infinity);
    for (let i = 0; i < sts.length; i++) {
      const n = bldOf(sts[i]!);
      if (n === undefined || !CALL_OPEN.has(n)) continue;
      let j = i + 1;
      while (j < sts.length) {
        const m = bldOf(sts[j]!);
        if (m === n + 1 || (m !== undefined && CALL_OPEN.has(m))) break;
        j++;
      }
      if (j >= sts.length || bldOf(sts[j]!) !== n + 1) continue;
      let t = Infinity;
      const next = sts[i + 1]!;
      const rlo = next.instruction.def?.id === '=' ? localAt(next.operand, 'X') : undefined;
      if (rlo !== undefined) t = rlo;
      for (let k = i + 1; k < j; k++) {
        const a =
          sts[k]!.instruction.def?.id === 'TAR2' ? localAt(sts[k]!.operand, 'D') : undefined;
        if (a !== undefined) t = Math.min(t, a);
      }
      for (let k = i + 1; k < j; k++) from[k] = t;
      i = j;
    }
    sts.forEach((st, k) => (end = Math.max(end, statementLocalEnd(st, from[k]))));
  }
  return end;
}

/** Un posto nei dati locali: byte, e bit per i BOOL. */
export interface LocalSlot {
  byte: number;
  bit?: number;
}

/** Cosa chiede una CALL: salvataggio di AR2, bit del RLO, bit per i BOOL, byte per gli altri. */
export interface CallNeeds {
  ar2: boolean;
  rlo: boolean;
  bits: number;
  bytes: number[];
}

export interface CallSlots {
  ar2?: number;
  rlo?: LocalSlot;
  bits: LocalSlot[];
  bytes: number[];
  /** Primo byte libero dopo i temporanei della CALL. */
  end: number;
}

/** Temporanei di una CALL a partire da `base` (regola 2). */
export function allocateCall(base: number, need: CallNeeds): CallSlots {
  let cur = base;
  const out: CallSlots = { bits: [], bytes: [], end: base };
  if (need.ar2) {
    out.ar2 = cur;
    cur += 4;
  }
  const nbits = (need.rlo ? 1 : 0) + need.bits;
  for (let i = 0; i < nbits; i++) {
    const slot = { byte: cur + Math.floor(i / 8), bit: i % 8 };
    if (need.rlo && i === 0) out.rlo = slot;
    else out.bits.push(slot);
  }
  cur += Math.ceil(nbits / 8);
  for (const size of need.bytes) {
    out.bytes.push(cur);
    cur += size;
  }
  out.end = cur;
  return out;
}

/** Lunghezza dei dati locali (regola 3). */
export function localDataLength(base: number, callEnds: readonly number[]): number {
  const end = Math.max(base, ...callEnds);
  return end + (end & 1);
}
