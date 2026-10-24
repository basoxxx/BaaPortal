/** Parola di stato (manuale AWL S7-300/400, «Parola di stato»): bit 0 /FC … bit 8 BR. */
export interface StatusWord {
  fc: boolean;
  rlo: boolean;
  sta: boolean;
  or: boolean;
  os: boolean;
  ov: boolean;
  cc0: boolean;
  cc1: boolean;
  br: boolean;
}

const FIELDS: (keyof StatusWord)[] = ['fc', 'rlo', 'sta', 'or', 'os', 'ov', 'cc0', 'cc1', 'br'];

export function stwToWord(s: StatusWord): number {
  return FIELDS.reduce((w, f, i) => (s[f] ? w | (1 << i) : w), 0);
}

export function wordToStw(w: number): StatusWord {
  const s = {} as StatusWord;
  FIELDS.forEach((f, i) => (s[f] = ((w >> i) & 1) === 1));
  return s;
}

/** Registri della CPU (S7-300: 2 accumulatori). Accumulatori e AR sono uint32. */
export interface Registers {
  stw: StatusWord;
  accu1: number;
  accu2: number;
  ar1: number;
  ar2: number;
  db: number;
  di: number;
}
