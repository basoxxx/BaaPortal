import { SimError } from '../errors';
import type { OpHandler } from '../executor';
import { fromReal, toReal } from './float';
import { setOverflow, setSignCc } from './integer';

/** Decodifica `digits` cifre BCD (da bit 0) di `v`; una cifra > 9 è un errore. */
function bcdDigits(v: number, digits: number): number {
  let n = 0;
  for (let i = digits - 1; i >= 0; i--) {
    const d = (v >>> (i * 4)) & 0xf;
    if (d > 9) throw new SimError('BCD_NON_VALIDO', `cifra ${d.toString(16).toUpperCase()}`);
    n = n * 10 + d;
  }
  return n;
}

function toBcd(n: number, digits: number): number {
  let r = 0;
  for (let i = 0; i < digits; i++) {
    r += (n % 10) * 16 ** i;
    n = Math.floor(n / 10);
  }
  return r;
}

const low = (st: { regs: { accu1: number } }): number => st.regs.accu1 & 0xffff;
const withLow = (a: number, w: number): number => ((a & 0xffff0000) | (w & 0xffff)) >>> 0;

/** Arrotondamento al pari più vicino (x.5 → pari). */
function roundEven(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/** Manuale AWL, «RND», «TRUNC», «RND+», «RND-»: fuori dal campo DINT o NaN → OV = OS = 1, ACCU1 invariato. */
function toDint(fn: (x: number) => number): OpHandler {
  return (st) => {
    const r = fn(toReal(st.regs.accu1));
    if (Number.isNaN(r) || r < -2147483648 || r > 2147483647) {
      setOverflow(st, true);
      return;
    }
    st.regs.accu1 = r >>> 0;
    setOverflow(st, false);
  };
}

export const CONVERSION_OPS: Record<string, OpHandler> = {
  // Manuale AWL, «BTI»: BCD a 3 cifre con segno nel bit 15 → INT in ACCU1-L; ACCU1-H invariata.
  BTI: (st) => {
    const w = low(st);
    const n = bcdDigits(w & 0x0fff, 3);
    st.regs.accu1 = withLow(st.regs.accu1, (w & 0x8000 ? -n : n) & 0xffff);
  },
  // «BTD»: BCD a 7 cifre con segno nel bit 31 → DINT.
  BTD: (st) => {
    const a = st.regs.accu1;
    const n = bcdDigits(a & 0x0fffffff, 7);
    st.regs.accu1 = ((a & 0x80000000 ? -n : n) | 0) >>> 0;
  },
  // «ITB»: INT → BCD a 3 cifre e segno (0xF), fuori da ±999 OV = OS = 1 e ACCU1 invariato.
  ITB: (st) => {
    const v = (low(st) << 16) >> 16;
    if (Math.abs(v) > 999) return setOverflow(st, true);
    st.regs.accu1 = withLow(st.regs.accu1, (v < 0 ? 0xf000 : 0) | toBcd(Math.abs(v), 3));
    setOverflow(st, false);
  },
  // «ITD»: estensione del segno.
  ITD: (st) => {
    st.regs.accu1 = (((low(st) << 16) >> 16) | 0) >>> 0;
  },
  // «DTB»: DINT → BCD a 7 cifre e segno (0xF nei bit 28–31), fuori da ±9 999 999 OV = OS = 1.
  DTB: (st) => {
    const v = st.regs.accu1 | 0;
    if (Math.abs(v) > 9999999) return setOverflow(st, true);
    st.regs.accu1 = ((v < 0 ? 0xf0000000 : 0) | toBcd(Math.abs(v), 7)) >>> 0;
    setOverflow(st, false);
  },
  // «DTR»: DINT → REAL a 32 bit.
  DTR: (st) => {
    st.regs.accu1 = fromReal(Math.fround(st.regs.accu1 | 0));
  },
  // «INVI», «INVD»: complemento a uno.
  INVI: (st) => {
    st.regs.accu1 = withLow(st.regs.accu1, ~low(st));
  },
  INVD: (st) => {
    st.regs.accu1 = ~st.regs.accu1 >>> 0;
  },
  // «NEGI», «NEGD»: complemento a due, CC dal risultato avvolto; -32768 / -2^31 → OV = OS = 1.
  NEGI: (st) => {
    const v = (low(st) << 16) >> 16;
    const w = (-v << 16) >> 16;
    st.regs.accu1 = withLow(st.regs.accu1, w);
    setSignCc(st, w);
    setOverflow(st, v === -32768);
  },
  NEGD: (st) => {
    const v = st.regs.accu1 | 0;
    const w = -v | 0;
    st.regs.accu1 = w >>> 0;
    setSignCc(st, w);
    setOverflow(st, v === -2147483648);
  },
  // «NEGR»: inverte il bit di segno; CC dal risultato, nessun OV per valori finiti.
  NEGR: (st) => {
    const a = (st.regs.accu1 ^ 0x80000000) >>> 0;
    st.regs.accu1 = a;
    const r = toReal(a);
    const s = st.regs.stw;
    s.cc0 = r < 0 || Number.isNaN(r);
    s.cc1 = r > 0 || Number.isNaN(r);
    s.ov = !Number.isFinite(r);
    if (s.ov) s.os = true;
  },
  // «CAW», «CAD»: inversione dei byte, la parola di stato non cambia.
  CAW: (st) => {
    const w = low(st);
    st.regs.accu1 = withLow(st.regs.accu1, ((w & 0xff) << 8) | (w >>> 8));
  },
  CAD: (st) => {
    const a = st.regs.accu1;
    st.regs.accu1 =
      (((a & 0xff) << 24) | ((a & 0xff00) << 8) | ((a >>> 8) & 0xff00) | (a >>> 24)) >>> 0;
  },
  RND: toDint(roundEven),
  TRUNC: toDint(Math.trunc),
  'RND+': toDint(Math.ceil),
  'RND-': toDint(Math.floor),
};
