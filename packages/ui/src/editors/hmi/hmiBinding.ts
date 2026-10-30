// Collegamento degli oggetti HMI alle variabili: risoluzione, testo dei valori e byte da scrivere.
// Formati e conversioni sono quelli delle tabelle di controllo (`watchRows`).
import {
  HMI_TAG_KINDS,
  hmiTagProblem,
  type HmiFormat,
  type HmiObject,
  type WatchFormat,
  type WatchResolution,
  type WatchTarget,
} from '@baaportal/project';
import type { WatchValue } from '../../sim/protocol';
import { formatValue, parseCommand, type WatchSource } from '../watch/watchRows';

export type HmiBinding =
  | {
      ok: true;
      target: WatchTarget;
      format: WatchFormat;
      sign: 'signed' | 'unsigned' | 'any';
    }
  /** `code`: codice della risoluzione (`UNKNOWN`…), di `hmiTagProblem` o `EMPTY`/`ONLINE_UNSUPPORTED`. */
  | { ok: false; code: string };

const WATCH_FORMAT: Record<HmiFormat, WatchFormat> = {
  INT: 'DEC',
  DINT: 'DEC',
  REAL: 'FLOAT',
  HEX: 'HEX',
  BOOL: 'BOOL',
};

/** La variabile dell'oggetto risolta e controllata; `null` per gli oggetti senza variabile. */
export function bindObject(
  resolve: (text: string) => WatchResolution,
  o: HmiObject,
  source: WatchSource = 'sim',
): HmiBinding | null {
  if (!HMI_TAG_KINDS.has(o.kind)) return null;
  const tag = o.tag?.trim() ?? '';
  if (tag === '') return { ok: false, code: 'EMPTY' };
  const r = resolve(tag);
  if (!r.ok) return { ok: false, code: r.code };
  const problem = hmiTagProblem(o, r);
  if (problem) return { ok: false, code: problem };
  // PQ non si legge online (come nelle tabelle di controllo).
  if (source === 'plc' && r.target.area === 'PQ') return { ok: false, code: 'ONLINE_UNSUPPORTED' };
  if (o.kind === 'ioField') {
    const f = o.format ?? 'INT';
    return {
      ok: true,
      target: r.target,
      format: WATCH_FORMAT[f],
      sign: f === 'INT' || f === 'DINT' ? 'signed' : r.sign,
    };
  }
  return { ok: true, target: r.target, format: r.format, sign: r.sign };
}

export const targetKey = (t: WatchTarget): string => JSON.stringify(t);

/** Il testo del valore nel formato del legame; `undefined` se il valore non c'è ancora. */
export function valueText(
  b: Extract<HmiBinding, { ok: true }>,
  v: WatchValue | undefined,
): { text: string } | { error: string } | undefined {
  if (!v) return undefined;
  if ('error' in v) return { error: v.error };
  const f = formatValue(v.bytes, b.format, b.target.size, b.sign);
  return 'text' in f ? f : { error: f.error.key };
}

export const bitOf = (v: WatchValue | undefined): boolean | undefined =>
  v && 'bytes' in v ? v.bytes[0] !== 0 : undefined;

/** Il valore numerico (per la barra): reale o intero secondo il tipo della variabile. */
export function numberOf(
  b: Extract<HmiBinding, { ok: true }>,
  v: WatchValue | undefined,
): number | undefined {
  if (!v || 'error' in v) return undefined;
  const f = formatValue(v.bytes, b.format === 'FLOAT' ? 'FLOAT' : 'DEC', b.target.size, b.sign);
  if (!('text' in f)) return undefined;
  const n = Number(f.text);
  return Number.isFinite(n) ? n : undefined;
}

export type HmiWrite = { ok: true; data: Uint8Array } | { ok: false; code: string };

/**
 * I byte che il pulsante scrive alla pressione. «Commuta» parte dall'ultimo valore letto: senza
 * un valore non scrive.
 */
export function pressData(
  o: HmiObject,
  b: Extract<HmiBinding, { ok: true }>,
  last: WatchValue | undefined,
): HmiWrite {
  switch (o.action ?? 'set') {
    case 'set':
    case 'jog':
      return { ok: true, data: Uint8Array.of(1) };
    case 'reset':
      return { ok: true, data: Uint8Array.of(0) };
    case 'toggle': {
      const bit = bitOf(last);
      return bit === undefined
        ? { ok: false, code: 'NO_VALUE' }
        : { ok: true, data: Uint8Array.of(bit ? 0 : 1) };
    }
    case 'write':
      return inputData(b, o.value ?? '');
  }
}

/** Il pulsante «a impulsi» rimette il bit a 0 al rilascio; gli altri non scrivono nulla. */
export const releaseData = (o: HmiObject): Uint8Array | null =>
  o.kind === 'button' && o.action === 'jog' ? Uint8Array.of(0) : null;

/** I byte di un valore scritto nel campo di immissione (o del valore fisso di un pulsante). */
export function inputData(b: Extract<HmiBinding, { ok: true }>, text: string): HmiWrite {
  const p = parseCommand(text, b.format, b.target.size, b.sign);
  return p.ok ? { ok: true, data: p.data } : { ok: false, code: p.error.key };
}
