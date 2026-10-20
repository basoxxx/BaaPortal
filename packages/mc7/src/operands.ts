import type { AddressSize, AreaId, Operand } from '@baaportal/awl';

/**
 * Operandi AWL già risolti (indirizzi assoluti) e loro codifica MC7 (mc7 §2.2).
 * Questo modulo non conosce le istruzioni: dà i mattoni (codici d'area, puntatori, testo canonico).
 */

const POS = { line: 0, col: 0, offset: 0 };
/** Intervallo fittizio degli operandi costruiti dal decodificatore (non vengono dal sorgente). */
export const NO_RANGE = { from: POS, to: POS };

export const address = (
  area: AreaId,
  size: AddressSize,
  byte: number,
  bit?: number,
  db?: number,
): Operand => ({
  kind: 'address',
  area,
  size,
  byte,
  ...(bit !== undefined ? { bit } : {}),
  ...(db !== undefined ? { db } : {}),
  range: NO_RANGE,
});
export const timerCounter = (area: 'T' | 'C', number: number): Operand => ({
  kind: 'timerCounter',
  area,
  number,
  range: NO_RANGE,
});
export const blockRef = (
  blockKind: 'FB' | 'FC' | 'SFB' | 'SFC' | 'DB' | 'DI',
  number: number,
): Operand => ({ kind: 'block', blockKind, number, range: NO_RANGE });
export const constant = (text: string): Operand => ({ kind: 'constant', text, range: NO_RANGE });
export const statusOp = (condition: string): Operand => ({
  kind: 'status',
  condition,
  range: NO_RANGE,
});
export const specialOp = (name: 'STW' | 'DBLG' | 'DBNO' | 'DILG' | 'DINO' | 'AR2'): Operand => ({
  kind: 'special',
  name,
  range: NO_RANGE,
});
export const labelRef = (name: string): Operand => ({ kind: 'labelRef', name, range: NO_RANGE });
export const indirectReg = (
  area: AreaId | null,
  size: AddressSize | null,
  ar: 1 | 2,
  offset: string,
): Operand => ({
  kind: 'indirect',
  area,
  size,
  via: { kind: 'register', ar, offset },
  range: NO_RANGE,
});
export const indirectMem = (
  area: AreaId | null,
  size: AddressSize | null,
  location: Operand,
): Operand => ({
  kind: 'indirect',
  area,
  size,
  via: { kind: 'memory', location },
  range: NO_RANGE,
});

/** Codice d'area `z` (mc7 §2.2.1): 0 periferia, 1 I, 2 Q, 3 M, 4 DB, 5 DI, 6 L. */
export const AREA_CODE: Partial<Record<AreaId, number>> = {
  PI: 0,
  PQ: 0,
  I: 1,
  Q: 2,
  M: 3,
  DB: 4,
  DI: 5,
  L: 6,
};
export const AREA_OF_CODE: AreaId[] = ['PI', 'I', 'Q', 'M', 'DB', 'DI', 'L'];
/** Area in cui sta il puntatore di un accesso indiretto da memoria (codice `p`): M, DB, DI, L. */
export const POINTER_AREAS: AreaId[] = ['M', 'DB', 'DI', 'L'];
export const pointerAreaCode = (area: AreaId): number | undefined => {
  const i = POINTER_AREAS.indexOf(area);
  return i < 0 ? undefined : i + 3;
};
export const SIZE_CODE: Record<string, number> = { B: 1, W: 2, D: 3 };
export const SIZE_OF_CODE: (AddressSize | undefined)[] = [undefined, 'B', 'W', 'D'];

const num = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/** Indirizzo assoluto senza DB qualificato né simbolo: l'unico che sta in un solo operando MC7. */
export function plainAddress(
  op: Operand | undefined,
): Extract<Operand, { kind: 'address' }> | undefined {
  return op && op.kind === 'address' && op.db === undefined && !op.dbSymbol ? op : undefined;
}

/** Il puntatore di un accesso indiretto da memoria: area M/DB/DI/L, dimensione `size`, byte < 65536. */
export function locationOf(
  op: Operand | undefined,
  size: 'W' | 'D',
): { p: number; byte: number } | undefined {
  const a = plainAddress(op);
  if (!a || a.size !== size || a.bit !== undefined) return undefined;
  const p = pointerAreaCode(a.area);
  if (p === undefined || !num(a.byte) || a.byte > 0xffff) return undefined;
  return { p, byte: a.byte };
}
export const locationOperand = (p: number, size: 'W' | 'D', byte: number): Operand =>
  address(POINTER_AREAS[p - 3]!, size, byte);

/** `P#14.0` (offset di un registro d'indirizzo, 16 bit): byte·8 + bit. */
export function parseOffset(text: string): number | undefined {
  const m = /^P#(\d+)(?:\.(\d+))?$/i.exec(text.trim());
  if (!m) return undefined;
  const bit = m[2] === undefined ? 0 : Number(m[2]);
  const v = Number(m[1]) * 8 + bit;
  return bit > 7 || v > 0xffff ? undefined : v;
}
export const offsetText = (v: number): string => `P#${v >> 3}.${v & 7}`;

// Puntatore d'area a 32 bit (mc7 §2.2.4): byte 0 = area, byte 1–3 = byte·8 + bit.
const POINTER_NAMES: [number, string][] = [
  [0x80, 'P'],
  [0x81, 'I'],
  [0x82, 'Q'],
  [0x83, 'M'],
  [0x84, 'DBX'],
  [0x85, 'DIX'],
  [0x86, 'L'],
  [0x87, 'V'],
];
const POINTER_ALIASES: Record<string, number> = {
  P: 0x80,
  I: 0x81,
  Q: 0x82,
  M: 0x83,
  DB: 0x84,
  DBX: 0x84,
  DI: 0x85,
  DIX: 0x85,
  L: 0x86,
  V: 0x87,
};

/** `P#M 10.3`, `P#L36.0`, `P#0.0` → 4 byte; undefined se non è un puntatore senza numero di DB. */
export function parsePointer(text: string): number[] | undefined {
  const m = /^P#(?:([A-Za-z]+)[ \t]*)?(\d+)(?:\.(\d+))?$/i.exec(text.trim());
  if (!m) return undefined;
  const area = m[1] === undefined ? 0 : POINTER_ALIASES[m[1].toUpperCase()];
  if (area === undefined) return undefined;
  const bit = m[3] === undefined ? 0 : Number(m[3]);
  const v = Number(m[2]) * 8 + bit;
  if (bit > 7 || v > 0xffffff) return undefined;
  return [area, v >> 16, (v >> 8) & 255, v & 255];
}
export function pointerText(b: ArrayLike<number>): string | undefined {
  const area = b[0]!;
  const v = (b[1]! << 16) | (b[2]! << 8) | b[3]!;
  const at = `${v >> 3}.${v & 7}`;
  if (area === 0) return `P#${at}`;
  const name = POINTER_NAMES.find(([c]) => c === area)?.[1];
  return name ? `P#${name} ${at}` : undefined;
}

// Parametri formali di FC (mc7 §2.2.6).
export type FormalType =
  'Bool' | 'Byte' | 'Word' | 'DWord' | 'Timer' | 'Counter' | 'Block_FB' | 'Block_FC' | 'Block_DB';

/** Un parametro formale risolto: `offset` = 2·(indice + 1), il campo `wwww` dell'istruzione. */
export interface FormalParam {
  offset: number;
  type: FormalType;
}
/** Nome generato per un parametro formale senza nome (mc7 §3.2). */
export const formalName = (offset: number): string =>
  offset >= 2 && offset % 2 === 0 ? `PAR${offset / 2 - 1}` : `PARW${offset}`;

export function formatOperand(op: Operand): string {
  switch (op.kind) {
    case 'address': {
      const at = op.bit === undefined ? `${op.byte}` : `${op.byte}.${op.bit}`;
      const size = op.size === 'X' || op.size === null ? '' : op.size;
      if (op.area === 'DB' || op.area === 'DI') {
        const prefix = `${op.area}${op.size ?? ''}`;
        return op.db !== undefined ? `%${op.area}${op.db}.${prefix}${at}` : `%${prefix}${at}`;
      }
      return `%${op.area}${size}${at}`;
    }
    case 'timerCounter':
      return `%${op.area}${op.number}`;
    case 'block':
      return `%${op.blockKind}${op.number}`;
    case 'indirect': {
      const plain = op.size === 'X' || op.size === null ? '' : op.size;
      const head =
        op.area === null
          ? `%${plain}`
          : op.area === 'DB' || op.area === 'DI'
            ? `%${op.area}${op.size ?? ''}`
            : `%${op.area}${plain}`;
      const inner =
        op.via.kind === 'register'
          ? `AR${op.via.ar},${op.via.offset}`
          : formatOperand(op.via.location).replace(/^%/, '');
      return `${head}[${inner}]`;
    }
    case 'labelRef':
      return op.name;
    case 'status':
      return op.condition;
    case 'special':
      return op.name;
    case 'constant':
      return op.text;
    case 'local':
      return `#${op.path.map((p) => p.name).join('.')}`;
    case 'symbol':
      return op.path.map((p) => `"${p.name}"`).join('.');
  }
}
