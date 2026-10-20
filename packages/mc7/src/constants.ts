import { parseLiteral } from '@baaportal/s7-types';
import { Mc7Error } from './blockFile';
import { parsePointer, pointerText } from './operands';

/**
 * Costanti dell'MC7 (mc7 §2.3): testo AWL ↔ byte, S5TIME e durate.
 * Tutti i valori nei byte delle istruzioni sono big-endian.
 */

export const DAY0 = Date.UTC(1990, 0, 1);
const DAY_MS = 86_400_000;

/** `1H2M3S` / `500MS` (forma canonica di `parseLiteral`) in millisecondi. */
export function unitsToMs(body: string): number {
  const mult: Record<string, number> = { D: 86_400_000, H: 3_600_000, M: 60_000, S: 1000, MS: 1 };
  let total = 0;
  for (const m of body.matchAll(/(\d+)(MS|D|H|M|S)/g)) total += Number(m[1]) * mult[m[2]!]!;
  return total;
}

/**
 * S5TIME (mc7 §1.4.6, §2.3): bit 12–13 base (10 ms / 100 ms / 1 s / 10 s), bit 0–11 tre cifre BCD.
 *
 * Regola unica per l'istruzione `L S5T#…` e per i valori iniziali dell'SSB: la base più piccola in
 * cui il valore sta in tre cifre; il resto si tronca. Provata sulle costanti S5T dei blocchi reali
 * (FC1: 1 s = `01 00`, base 10 ms; 10 min = `26 00`, base 1 s), dove la base minima è anche l'unica
 * scelta coerente con entrambi i valori: STEP 7 non usa «la base più grande che tiene la
 * risoluzione piena».
 */
export function s5TimeWord(ms: number): number {
  let base = 0;
  let value = Math.floor(ms / 10);
  while (value > 999 && base < 3) {
    base++;
    value = Math.floor(ms / (10 * 10 ** base));
  }
  value = Math.min(value, 999);
  return (
    (base << 12) |
    ((Math.floor(value / 100) % 10) << 8) |
    ((Math.floor(value / 10) % 10) << 4) |
    (value % 10)
  );
}

/** Valore di una parola S5TIME; `valid` è falso con cifre non BCD o bit 14–15 accesi. */
export function s5TimeMs(word: number): { ms: number; base: number; valid: boolean } {
  const d = [(word >> 8) & 15, (word >> 4) & 15, word & 15];
  const base = (word >> 12) & 3;
  const valid = d.every((x) => x <= 9) && (word & 0xc000) === 0;
  return { ms: (d[0]! * 100 + d[1]! * 10 + d[2]!) * 10 * 10 ** base, base, valid };
}

/** Una costante caricata da `L`: `28 nn`, `30 tt vvvv` o `38 tt dddddddd`. */
export interface LoadConstant {
  op: 0x28 | 0x30 | 0x38;
  /** Byte di tipo `tt` (0 per `28`). */
  type: number;
  data: number[];
}
export const loadConstantBytes = (c: LoadConstant): number[] =>
  c.op === 0x28 ? [0x28, c.data[0]!] : [c.op, c.type, ...c.data];

const be = (v: number, n: number): number[] =>
  Array.from({ length: n }, (_, i) => Math.floor(v / 2 ** (8 * (n - 1 - i))) & 255);
const u = (d: number[]): number => d.reduce((a, b) => a * 256 + b, 0);
const range = (what: string): never => {
  throw new Mc7Error('COMPILE', `costante fuori intervallo: ${what}`);
};
const hexDigits = (s: string): string => s.replace(/_/g, '');

function printable(b: number): boolean {
  return b >= 0x20 && b <= 0x7e && b !== 0x27 && b !== 0x24;
}

const REAL = /^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/;
const lit = (name: 'S5Time' | 'Time' | 'Date' | 'Time_Of_Day', text: string): string => {
  const r = parseLiteral({ kind: 'elementary', name }, text);
  if (!r.ok) return range(text);
  return r.canonical;
};

/**
 * Costante AWL → forma MC7. `undefined` se il testo non è una costante nota; `Mc7Error('COMPILE')`
 * se lo è ma il valore esce dal tipo. La sintassi sceglie il tipo (mc7 §3.3): `5` INT, `L#5` DINT,
 * `5.0` REAL, `W#16#5` WORD.
 */
export function parseConstant(text: string): LoadConstant | undefined {
  const t = text.trim();
  let m: RegExpExecArray | null;
  if ((m = /^B#16#([0-9a-f](?:_?[0-9a-f])?)$/i.exec(t))) {
    return { op: 0x28, type: 0, data: [parseInt(hexDigits(m[1]!), 16)] };
  }
  if ((m = /^W#16#([0-9a-f](?:_?[0-9a-f])*)$/i.exec(t))) {
    const h = hexDigits(m[1]!);
    return h.length > 4 ? range(t) : { op: 0x30, type: 7, data: be(parseInt(h, 16), 2) };
  }
  if ((m = /^DW#16#([0-9a-f](?:_?[0-9a-f])*)$/i.exec(t))) {
    const h = hexDigits(m[1]!);
    return h.length > 8 ? range(t) : { op: 0x38, type: 7, data: be(parseInt(h, 16), 4) };
  }
  if ((m = /^2#([01](?:_?[01])*)$/.exec(t))) {
    const bits = hexDigits(m[1]!);
    if (bits.length > 32) return range(t);
    const v = parseInt(bits, 2);
    return bits.length <= 16
      ? { op: 0x30, type: 2, data: be(v, 2) }
      : { op: 0x38, type: 2, data: be(v, 4) };
  }
  if ((m = /^B#\(\s*(\d+(?:\s*,\s*\d+){1,3})\s*\)$/i.exec(t))) {
    const parts = m[1]!.split(',').map((x) => Number(x.trim()));
    if (parts.length === 3) return undefined;
    if (parts.some((x) => x > 255)) return range(t);
    return { op: parts.length === 2 ? 0x30 : 0x38, type: 6, data: parts };
  }
  if ((m = /^L#([+-]?\d+)$/i.exec(t))) {
    const v = BigInt(m[1]!);
    if (v < -(2n ** 31n) || v >= 2n ** 31n) return range(t);
    return { op: 0x38, type: 3, data: be(Number(BigInt.asUintN(32, v)), 4) };
  }
  if ((m = /^C#(\d{1,3})$/i.exec(t))) {
    const v = Number(m[1]);
    return {
      op: 0x30,
      type: 8,
      data: [Math.floor(v / 100), ((Math.floor(v / 10) % 10) << 4) | (v % 10)],
    };
  }
  if (/^D#/i.test(t)) {
    const days = (Date.UTC(...ymd(lit('Date', t).slice(2))) - DAY0) / DAY_MS;
    return { op: 0x30, type: 0x0a, data: be(days, 2) };
  }
  if (/^S5T#/i.test(t)) {
    const ms = unitsToMs(lit('S5Time', t).slice(4));
    return { op: 0x30, type: 0x0c, data: be(s5TimeWord(ms), 2) };
  }
  if (/^T#/i.test(t)) {
    const canon = lit('Time', t);
    const neg = canon.startsWith('T#-');
    const ms = unitsToMs(canon.slice(neg ? 3 : 2));
    return { op: 0x38, type: 9, data: be(Number(BigInt.asUintN(32, BigInt(neg ? -ms : ms))), 4) };
  }
  if (/^TOD#/i.test(t)) {
    const mm = /^TOD#(\d\d):(\d\d):(\d\d)\.(\d{3})$/.exec(lit('Time_Of_Day', t))!;
    const ms = ((Number(mm[1]) * 60 + Number(mm[2])) * 60 + Number(mm[3])) * 1000 + Number(mm[4]);
    return { op: 0x38, type: 0x0b, data: be(ms, 4) };
  }
  if (/^P#/i.test(t)) {
    const p = parsePointer(t);
    return p ? { op: 0x38, type: 4, data: p } : undefined;
  }
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 3) {
    const chars = Array.from(t.slice(1, -1));
    if (chars.some((c) => c === "'" || c === '$') || chars.length > 4) return undefined;
    const codes = chars.map((c) => c.codePointAt(0)!);
    if (codes.some((c) => c > 0xff)) return range(t);
    if (codes.length <= 2) {
      return { op: 0x30, type: 5, data: codes.length === 1 ? [0, codes[0]!] : codes };
    }
    return { op: 0x38, type: 5, data: [...Array<number>(4 - codes.length).fill(0), ...codes] };
  }
  if (/^[+-]?\d+$/.test(t)) {
    const v = Number(t);
    if (!Number.isSafeInteger(v) || v < -32768 || v > 32767) return range(t);
    return { op: 0x30, type: 3, data: be(v & 0xffff, 2) };
  }
  if (REAL.test(t) && /[.eE]/.test(t)) {
    const f = Math.fround(Number(t));
    if (!Number.isFinite(f)) return range(t);
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, f);
    return { op: 0x38, type: 1, data: Array.from(new Uint8Array(dv.buffer)) };
  }
  return undefined;
}

function ymd(body: string): [number, number, number] {
  const [y, mo, d] = body.split('-').map(Number);
  return [y!, mo! - 1, d!];
}

const hex = (v: number): string => v.toString(16).toUpperCase();
const pad2 = (n: number): string => String(n).padStart(2, '0');

function binary(v: number, bits: 16 | 32): string {
  const s = v.toString(2).padStart(bits, '0');
  return `2#${s.match(/.{4}/g)!.join('_')}`;
}

function components(ms: number, units: [string, number][]): string {
  let rest = ms;
  let out = '';
  for (const [name, size] of units) {
    const n = Math.floor(rest / size);
    rest -= n * size;
    if (n > 0) out += `${n}${name}`;
  }
  return out === '' ? '0MS' : out;
}
const TIME_UNITS: [string, number][] = [
  ['D', 86_400_000],
  ['H', 3_600_000],
  ['M', 60_000],
  ['S', 1000],
  ['MS', 1],
];

function realText(data: number[]): string | undefined {
  const dv = new DataView(new ArrayBuffer(4));
  data.forEach((b, i) => dv.setUint8(i, b));
  const v = dv.getFloat32(0);
  if (!Number.isFinite(v)) return undefined;
  if (Object.is(v, -0)) return '-0.0';
  for (let p = 1; p <= 9; p++) {
    const back = Number(v.toPrecision(p));
    if (Math.fround(back) === v) {
      const s = String(back);
      return /[.eE]/.test(s) ? s : `${s}.0`;
    }
  }
  return undefined;
}

/** Il testo naturale di una costante: quello che, riletto da `parseConstant`, dà la stessa. */
function naturalText(c: LoadConstant): string | undefined {
  const d = c.data;
  if (c.op === 0x28) return `B#16#${hex(d[0]!)}`;
  const v = u(d);
  if (c.op === 0x30) {
    switch (c.type) {
      case 2:
        return binary(v, 16);
      case 3:
        return String(v >= 0x8000 ? v - 0x10000 : v);
      case 5: {
        const cs = d[0] === 0 ? [d[1]!] : d;
        return cs.every(printable) ? `'${String.fromCharCode(...cs)}'` : undefined;
      }
      case 6:
        return `B#(${d.join(',')})`;
      case 7:
        return `W#16#${hex(v)}`;
      case 8: {
        const digits = [d[0]! & 15, d[1]! >> 4, d[1]! & 15];
        return d[0]! <= 9 && digits.every((x) => x <= 9)
          ? `C#${digits[0]! * 100 + digits[1]! * 10 + digits[2]!}`
          : undefined;
      }
      case 0x0a: {
        const dt = new Date(DAY0 + v * DAY_MS);
        return `D#${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
      }
      case 0x0c: {
        const s = s5TimeMs(v);
        return s.valid ? `S5T#${components(s.ms, TIME_UNITS.slice(1))}` : undefined;
      }
      default:
        return undefined;
    }
  }
  switch (c.type) {
    case 1:
      return realText(d);
    case 2:
      return binary(v, 32);
    case 3:
      return `L#${v >= 2 ** 31 ? v - 2 ** 32 : v}`;
    case 4:
      return pointerText(d);
    case 5: {
      let i = 0;
      while (i < 3 && d[i] === 0) i++;
      const cs = d.slice(i);
      return cs.every(printable) ? `'${String.fromCharCode(...cs)}'` : undefined;
    }
    case 6:
      return `B#(${d.join(',')})`;
    case 7:
      return `DW#16#${hex(v)}`;
    case 9: {
      const ms = v >= 2 ** 31 ? v - 2 ** 32 : v;
      return `T#${ms < 0 ? '-' : ''}${components(Math.abs(ms), TIME_UNITS)}`;
    }
    case 0x0b:
      return v < DAY_MS
        ? `TOD#${pad2(Math.floor(v / 3_600_000))}:${pad2(Math.floor(v / 60_000) % 60)}:${pad2(Math.floor(v / 1000) % 60)}.${String(v % 1000).padStart(3, '0')}`
        : undefined;
    default:
      return undefined;
  }
}

/**
 * Costante letta da `L`. `text` è la forma naturale se riscritta dà gli stessi byte; altrimenti
 * (REAL non finito, base S5TIME non minima, tipo `00`, tipi ignoti…) è una forma `W#16#`/`DW#16#`
 * che porta il valore e `constantType` porta il byte di tipo, da ridare a `encodeLoadConstant`.
 */
export function decodeLoadConstant(c: LoadConstant): { text: string; constantType?: number } {
  const nat = naturalText(c);
  if (nat !== undefined) {
    let back: LoadConstant | undefined;
    try {
      back = parseConstant(nat);
    } catch {
      back = undefined;
    }
    if (back && back.op === c.op && back.type === c.type && back.data.join() === c.data.join()) {
      return { text: nat };
    }
  }
  const v = hex(u(c.data));
  return { text: c.op === 0x30 ? `W#16#${v}` : `DW#16#${v}`, constantType: c.type };
}

/** Testo → byte di `L <costante>`; `constantType` sostituisce il byte di tipo (non per `28`). */
export function encodeLoadConstant(text: string, constantType?: number): number[] | undefined {
  const c = parseConstant(text);
  if (!c) return undefined;
  if (constantType !== undefined) {
    if (c.op === 0x28) throw new Mc7Error('COMPILE', 'B#16# non ha byte di tipo');
    c.type = constantType;
  }
  return loadConstantBytes(c);
}
