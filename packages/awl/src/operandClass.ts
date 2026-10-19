// Classi di operando: risoluzione di un operando e verifica contro le classi dell'istruzione.
import { parseLiteral, sameName, type DataType } from '@baaportal/s7-types';
import type { Operand } from './ast';
import type { AwlContext } from './context';
import type { InstructionDef, OperandClass } from './instructions';
import {
  bitsOf,
  resolveDbSymbol,
  resolveLocal,
  resolveSymbol,
  type Report,
  type Resolved,
} from './resolve';

const SIZE_BITS = { B: 8, W: 16, D: 32 } as const;
const SIZE_BYTES = { X: 1, B: 1, W: 2, D: 4 } as const;

/** Risolve un operando, segnalando simboli e membri inesistenti e indirizzi fuori dai limiti. */
export function resolveOperand(ctx: AwlContext, op: Operand, rep: Report): Resolved {
  switch (op.kind) {
    case 'address': {
      if (op.dbSymbol) resolveDbSymbol(ctx, op.dbSymbol.name, op.dbSymbol.range, rep);
      const lim = ctx.limits;
      const max =
        op.area === 'I'
          ? lim?.inputBytes
          : op.area === 'Q'
            ? lim?.outputBytes
            : op.area === 'M'
              ? lim?.mBytes
              : undefined;
      if (max !== undefined && op.size && op.byte + SIZE_BYTES[op.size] > max) {
        rep('ADDRESS_OUT_OF_RANGE', op.range);
      }
      if (op.size === 'X') return { k: 'bit', src: 'address' };
      if (op.size) return { k: 'data', bits: SIZE_BITS[op.size], src: 'address', writable: true };
      return { k: 'unknown' };
    }
    case 'timerCounter': {
      const max = op.area === 'T' ? ctx.limits?.timers : ctx.limits?.counters;
      if (max !== undefined && op.number >= max) rep('ADDRESS_OUT_OF_RANGE', op.range);
      return { k: op.area === 'T' ? 'timer' : 'counter', src: 'address' };
    }
    case 'symbol':
      return resolveSymbol(ctx, op.path, rep);
    case 'local':
      return resolveLocal(ctx, op.path, rep);
    case 'constant':
      return { k: 'const', pointer: /^p#/i.test(op.text), text: op.text };
    case 'indirect': {
      // il bersaglio di un accesso in memoria indiretta non si controlla nel tipo
      if (op.via.kind === 'memory') resolveOperand(ctx, op.via.location, rep);
      if (op.area === 'T') return { k: 'timer', src: 'indirect' };
      if (op.area === 'C') return { k: 'counter', src: 'indirect' };
      if ((op.area === 'DB' || op.area === 'DI') && op.size === null) {
        return { k: 'block', blockKind: 'DB' };
      }
      if (op.size === null || op.size === 'X') return { k: 'bit', src: 'indirect' };
      return { k: 'data', bits: SIZE_BITS[op.size], src: 'indirect', writable: true };
    }
    case 'block':
      return { k: 'block', blockKind: op.blockKind === 'DI' ? 'DB' : op.blockKind };
    case 'labelRef':
      return { k: 'label' };
    case 'status':
      return { k: 'status' };
    case 'special':
      return { k: 'special', name: op.name };
  }
}

export type Verdict = 'ok' | 'notAllowed' | 'mismatch' | 'range';

// Istruzioni a bit che non accettano T e C come operando.
const NO_TIMER_COUNTER = new Set(['=', 'FN', 'FP']);
const SHIFT_MAX: Record<string, number> = {
  SSI: 15,
  SRW: 15,
  SLW: 15,
  SSD: 31,
  SLD: 31,
  SRD: 31,
  RLD: 31,
  RRD: 31,
};

function constantClass(cls: OperandClass, def: InstructionDef, text: string): Verdict {
  const dec = /^\d+$/.test(text) ? Number(text) : null;
  switch (cls) {
    case 'byteConstant':
      return dec === null ? 'notAllowed' : dec > 255 ? 'range' : 'ok';
    case 'nopValue':
      return dec === null ? 'notAllowed' : dec > 1 ? 'range' : 'ok';
    case 'shiftCount':
      return dec === null ? 'notAllowed' : dec > (SHIFT_MAX[def.id] ?? 31) ? 'range' : 'ok';
    case 'intConstant': {
      const m = /^(?:(l#)?([+-]?\d+))$/i.exec(text);
      if (!m) return 'notAllowed';
      const v = BigInt(m[2]!);
      const lim = m[1] ? 1n << 31n : 1n << 15n;
      return v < -lim || v >= lim ? 'range' : 'ok';
    }
    case 'wordConstant':
    case 'dwordConstant': {
      const r = parseLiteral(
        { kind: 'elementary', name: cls === 'wordConstant' ? 'Word' : 'DWord' },
        text,
      );
      return r.ok ? 'ok' : r.error === 'OUT_OF_RANGE' ? 'range' : 'notAllowed';
    }
    default:
      return 'notAllowed';
  }
}

function oneClass(cls: OperandClass, def: InstructionDef, op: Operand, r: Resolved): Verdict {
  if (r.k === 'unknown') return 'ok';
  switch (cls) {
    case 'none':
      return 'notAllowed';
    case 'bit':
      return r.k === 'bit' ||
        ((r.k === 'timer' || r.k === 'counter') && !NO_TIMER_COUNTER.has(def.id))
        ? 'ok'
        : 'notAllowed';
    case 'status':
      return r.k === 'status' ? 'ok' : 'notAllowed';
    case 'loadSource':
      if (r.k === 'data' || r.k === 'const' || r.k === 'timer' || r.k === 'counter') return 'ok';
      if (r.k === 'special') return r.name === 'AR2' ? 'notAllowed' : 'ok';
      if (r.k === 'complex' || (r.k === 'bit' && r.src === 'typed')) return 'mismatch';
      return 'notAllowed';
    case 'transferTarget':
      if (r.k === 'data') return r.writable ? 'ok' : 'notAllowed';
      if (r.k === 'special') return r.name === 'STW' ? 'ok' : 'notAllowed';
      if (r.k === 'complex' || (r.k === 'bit' && r.src === 'typed')) return 'mismatch';
      return 'notAllowed';
    case 'timer':
      return r.k === 'timer' ? 'ok' : 'notAllowed';
    case 'counter':
      return r.k === 'counter' ? 'ok' : 'notAllowed';
    case 'label':
      return r.k === 'label' ? 'ok' : 'notAllowed';
    case 'dbOpen':
      return r.k === 'block' && r.blockKind === 'DB' ? 'ok' : 'notAllowed';
    case 'callTarget':
    case 'ucTarget':
      return r.k === 'block' && r.blockKind !== 'DB' && r.blockKind !== 'OB' ? 'ok' : 'notAllowed';
    case 'pointerOrDword':
      if (r.k === 'const') return r.pointer ? 'ok' : 'notAllowed';
      if (r.k === 'special') return r.name === 'AR2' ? 'ok' : 'notAllowed';
      return r.k === 'data' && r.bits === 32 ? 'ok' : 'notAllowed';
    case 'dwordLocation':
      if (r.k === 'special') return r.name === 'AR2' ? 'ok' : 'notAllowed';
      return r.k === 'data' && r.bits === 32 && r.writable ? 'ok' : 'notAllowed';
    default:
      // costanti: byteConstant, nopValue, shiftCount, intConstant, wordConstant, dwordConstant
      return r.k === 'const' && op.kind === 'constant' && !r.pointer
        ? constantClass(cls, def, r.text)
        : 'notAllowed';
  }
}

/** Verdetto complessivo: la prima alternativa che accetta vince. */
export function classify(def: InstructionDef, op: Operand, r: Resolved): Verdict {
  let worst: Verdict = 'notAllowed';
  for (const cls of def.operands) {
    if (cls === 'none') continue;
    const v = oneClass(cls, def, op, r);
    if (v === 'ok') return 'ok';
    if (v === 'range' || (v === 'mismatch' && worst !== 'range')) worst = v;
  }
  return worst;
}

// ---- Parametri di CALL ----

export function typesEqual(a: DataType, b: DataType): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'elementary':
    case 'parameter':
      return a.name === (b as typeof a).name;
    case 'string':
      return a.length === (b as typeof a).length;
    case 'named':
      return sameName(a.name, (b as typeof a).name);
    case 'array': {
      const o = b as typeof a;
      return (
        a.dims.length === o.dims.length &&
        a.dims.every((d, i) => d.lo === o.dims[i]!.lo && d.hi === o.dims[i]!.hi) &&
        typesEqual(a.element, o.element)
      );
    }
    case 'struct': {
      const o = b as typeof a;
      return (
        a.members.length === o.members.length &&
        a.members.every(
          (m, i) => sameName(m.name, o.members[i]!.name) && typesEqual(m.type, o.members[i]!.type),
        )
      );
    }
    default:
      return true;
  }
}

const SHARED_BLOCK: Record<string, string> = {
  Block_FB: 'FB',
  Block_FC: 'FC',
  Block_DB: 'DB',
  Block_SDB: 'DB',
};

/** Il valore `r` puo' essere passato a un parametro di tipo `pt`? */
export function paramCompatible(pt: DataType, r: Resolved, ctx?: AwlContext): boolean {
  if (r.k === 'unknown') return true;
  switch (pt.kind) {
    case 'struct': {
      // Struct senza membri (SFC 6, SFC 51): accetta qualsiasi Struct o UDT.
      if (pt.members.length > 0) return 'type' in r && !!r.type && typesEqual(r.type, pt);
      const t = 'type' in r ? r.type : undefined;
      if (!t) return false;
      if (t.kind === 'struct') return true;
      return t.kind === 'named' && ctx?.resolve(t.name)?.kind === 'udt';
    }
    case 'elementary': {
      if (r.k === 'const') return !r.pointer && parseLiteral(pt, r.text).ok;
      if ('type' in r && r.type) return r.type.kind === 'elementary' && r.type.name === pt.name;
      const want = bitsOf(pt);
      if (r.k === 'bit') return want === 1;
      return r.k === 'data' && r.src !== 'typed' && r.bits === want;
    }
    case 'parameter': {
      if (pt.name === 'Timer') return r.k === 'timer';
      if (pt.name === 'Counter') return r.k === 'counter';
      if (pt.name === 'Pointer') {
        const typed = 'type' in r && !!r.type;
        return (
          (r.k === 'const' && r.pointer) ||
          typed ||
          ((r.k === 'bit' || r.k === 'data') && r.src !== 'typed')
        );
      }
      if (pt.name === 'Any') {
        return r.k !== 'const'
          ? r.k !== 'special' && r.k !== 'label' && r.k !== 'status'
          : r.pointer;
      }
      return r.k === 'block' && r.blockKind === SHARED_BLOCK[pt.name];
    }
    case 'string':
    case 'dateAndTime':
      if (r.k === 'const') return !r.pointer && parseLiteral(pt, r.text).ok;
      return 'type' in r && !!r.type && typesEqual(r.type, pt);
    case 'void':
      return false;
    default:
      return 'type' in r && !!r.type && typesEqual(r.type, pt);
  }
}
