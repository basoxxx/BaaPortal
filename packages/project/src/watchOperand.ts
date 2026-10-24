// Risoluzione degli operandi delle tabelle di controllo: stessi servizi del compilatore AWL
// (parser degli operandi, tabella dei simboli, layout dei DB), poi area, byte, bit e dimensione.
import { parseNetwork, type AwlContext, type Mnemonic } from '@baaportal/awl';
import { resolveGlobalOperand, SymbolError } from '@baaportal/mc7';
import type { CpuType } from '@baaportal/catalog';
import { createAwlContext } from './awlContext';
import type { PlcDevice, WatchFormat } from './model';

/** Operando risolto: dove sta nella memoria della CPU. Stessa forma della richiesta `watch` del simulatore. */
export interface WatchTarget {
  area: 'I' | 'Q' | 'M' | 'DB' | 'PI' | 'PQ' | 'T' | 'C';
  db?: number;
  /** Byte; per T e C il numero. */
  byte: number;
  bit?: number;
  size: 'X' | 'B' | 'W' | 'D';
}

export type WatchResolveCode =
  'EMPTY' | 'SYNTAX' | 'UNKNOWN' | 'NOT_OPERAND' | 'UNSUPPORTED' | 'RANGE';

export type WatchResolution =
  | {
      ok: true;
      target: WatchTarget;
      /** Nome del tipo elementare del simbolo, se c'e (`Int`, `Real`...). */
      typeName?: string;
      /** Formato predefinito: segue il tipo, o la dimensione per un indirizzo nudo. */
      format: WatchFormat;
      /** DEC con segno (INT, DINT), senza (BYTE, WORD, DWORD, CHAR) o non noto (indirizzo nudo). */
      sign: 'signed' | 'unsigned' | 'any';
    }
  | { ok: false; code: WatchResolveCode; detail?: string };

const FORMAT_OF_TYPE: Record<string, WatchFormat> = {
  Bool: 'BOOL',
  Byte: 'HEX',
  Char: 'CHAR',
  Word: 'HEX',
  Int: 'DEC',
  DWord: 'HEX',
  DInt: 'DEC',
  Real: 'FLOAT',
  S5Time: 'S5TIME',
  Time: 'TIME',
  Date: 'DEC',
  Time_Of_Day: 'DEC',
};
const FORMAT_OF_SIZE: Record<WatchTarget['size'], WatchFormat> = {
  X: 'BOOL',
  B: 'HEX',
  W: 'DEC',
  D: 'DEC',
};
const UNSIGNED_TYPES = new Set(['Byte', 'Word', 'DWord', 'Char']);

/** Formato predefinito di un operando di dimensione `size` e tipo `typeName` (se noto). */
export function defaultWatchFormat(size: WatchTarget['size'], typeName?: string): WatchFormat {
  const byType = typeName ? FORMAT_OF_TYPE[typeName] : undefined;
  return byType ?? FORMAT_OF_SIZE[size];
}

const WATCH_AREAS = new Set(['I', 'Q', 'M', 'DB', 'PI', 'PQ']);

function parseOperandText(text: string) {
  // Gli indirizzi dei tag hanno il '%' davanti (`%MW10`): l'AWL non lo conosce.
  const body = text.replace(/^%(?=[A-Za-z])/, '');
  for (const mnemonic of ['international', 'german'] as Mnemonic[]) {
    const { statements, errors } = parseNetwork(`L ${body}`, mnemonic);
    const op = statements[0]?.operand;
    if (errors.length === 0 && statements.length === 1 && op) return op;
  }
  return undefined;
}

/**
 * Risolve l'operando `text` (simbolo, indirizzo assoluto, DB, T o C) nel contesto `ctx`.
 * Aree L e DI, puntatori, costanti e blocchi non sono osservabili.
 */
export function resolveWatchOperand(ctx: AwlContext, text: string): WatchResolution {
  const t = text.trim();
  if (t === '') return { ok: false, code: 'EMPTY' };
  const op = parseOperandText(t);
  if (!op) return { ok: false, code: 'SYNTAX' };
  let v;
  try {
    v = resolveGlobalOperand(op, ctx);
  } catch (e) {
    if (e instanceof SymbolError) {
      const code =
        e.code === 'UNKNOWN_SYMBOL' || e.code === 'UNKNOWN_MEMBER' ? 'UNKNOWN' : 'UNSUPPORTED';
      return { ok: false, code, detail: e.message };
    }
    throw e;
  }
  if (v.k === 'tc') {
    const limit = (v.area === 'T' ? ctx.limits?.timers : ctx.limits?.counters) ?? Infinity;
    if (v.number >= limit) return { ok: false, code: 'RANGE', detail: `${v.area}${v.number}` };
    return {
      ok: true,
      target: { area: v.area, byte: v.number, size: 'W' },
      format: v.area === 'T' ? 'S5TIME' : 'BCD',
      sign: 'unsigned',
    };
  }
  if (v.k !== 'area') return { ok: false, code: 'NOT_OPERAND' };
  if (!WATCH_AREAS.has(v.area)) {
    return { ok: false, code: 'UNSUPPORTED', detail: v.area };
  }
  if (!v.size) return { ok: false, code: 'UNSUPPORTED', detail: 'type' };
  if (v.area === 'DB' && v.db === undefined) {
    return { ok: false, code: 'UNSUPPORTED', detail: 'DB' };
  }
  const target: WatchTarget = {
    area: v.area as WatchTarget['area'],
    byte: v.bit >> 3,
    size: v.size,
  };
  if (v.size === 'X') target.bit = v.bit & 7;
  else if (v.bit % 8 !== 0) return { ok: false, code: 'UNSUPPORTED', detail: 'align' };
  if (v.db !== undefined) target.db = v.db;
  const typeName = v.type && v.type.kind === 'elementary' ? v.type.name : undefined;
  return {
    ok: true,
    target,
    ...(typeName ? { typeName } : {}),
    format: defaultWatchFormat(v.size, typeName),
    sign: !typeName ? 'any' : UNSIGNED_TYPES.has(typeName) ? 'unsigned' : 'signed',
  };
}

/** Risolve gli operandi di un dispositivo; il contesto si costruisce una volta sola. */
export function watchResolverFor(
  device: PlcDevice,
  cpu: CpuType | undefined,
): (text: string) => WatchResolution {
  const ctx = createAwlContext(device, '', cpu);
  return (text) => resolveWatchOperand(ctx, text);
}
