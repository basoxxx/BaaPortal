import type { AwlContext, Operand, Statement } from '@baaportal/awl';
import type { TypedMember } from '@baaportal/s7-types';
import type { CallEnv } from './callExpand';
import type { Mc7Diagnostic } from './encode';
import { callBase } from './localData';
import {
  instanceLayout,
  resolveValue,
  structLayout,
  type Value,
  type LayoutTools,
  type Sections,
  type SymbolEnv,
} from './resolveSymbols';

/**
 * Ambiente di compilazione del codice di un blocco: simboli (`resolveSymbols.ts`) e CALL
 * (`callExpand.ts`). Lo usano il compilatore (`compile.ts`) e la verifica delle CALL ricostruite
 * nella decodifica (`callRebuild.ts`): stesse regole, quindi stessi byte.
 */

export function toolsOf(ctx: AwlContext): LayoutTools {
  return {
    resolve: ctx.resolve,
    blockNumber: (name) => {
      const b = ctx.block({ name });
      if (b && (b.kind === 'FB' || b.kind === 'SFB')) return { block: b.kind, number: b.number };
      const m = /^(FB|SFB)(\d+)$/i.exec(name);
      return m ? { block: m[1]!.toUpperCase() as 'FB' | 'SFB', number: Number(m[2]) } : undefined;
    },
  };
}

/**
 * Primo byte libero dopo i TEMP dichiarati (senza i temporanei delle CALL): la stessa misura da cui
 * `codeEnvironment` ricava `base`. Serve a chi genera codice AWL che usa dati locali (KOP).
 */
export function tempEndByte(temp: TypedMember[], ctx: AwlContext): number {
  return Math.ceil(structLayout(temp, toolsOf(ctx)).endBits / 8);
}

export interface CodeEnvironment {
  env: SymbolEnv;
  callEnv: CallEnv;
  /** Primo byte libero per i temporanei delle CALL (`localData.ts`, regola 1). */
  base: number;
  /** Avvisi delle CALL espanse (`CALL_NON_VERIFICATO`). */
  warnings: Mc7Diagnostic[];
}

/**
 * Layout dei TEMP e dell'istanza, parametri formali delle FC (ordine della lista dei puntatori:
 * IN, RET_VAL, OUT, IN_OUT, mc7 §2.2.6, §2.5), base dei temporanei delle CALL su tutte le reti
 * `parsed`. Lancia se l'interfaccia non ha un layout.
 */
export function codeEnvironment(
  kind: 'OB' | 'FB' | 'FC',
  s: Sections,
  ctx: AwlContext,
  parsed: readonly (readonly Statement[])[],
): CodeEnvironment {
  const tools = toolsOf(ctx);
  const env: SymbolEnv = {
    ctx,
    owner: kind,
    sections: s,
    tools,
    temp: structLayout(s.temp, tools),
    formals: new Map(),
    cache: new Map(),
  };
  if (kind === 'FB') env.instance = instanceLayout(s, tools);
  if (kind === 'FC') {
    const ret = s.ret.filter((m) => m.type.kind !== 'void');
    [...s.in, ...ret, ...s.out, ...s.inOut].forEach((m, index) =>
      env.formals.set(m.name.normalize('NFC').toLowerCase(), { name: m.name, index, type: m.type }),
    );
  }
  const firstAt = parsed.map((st) => st[0]?.range.from.offset);
  const base = Math.max(Math.ceil(env.temp.endBits / 8), callBase(parsed));
  const warnings: Mc7Diagnostic[] = [];
  const callEnv: CallEnv = {
    sym: env,
    ownerHasInstance:
      kind === 'FB' && s.in.length + s.out.length + s.inOut.length + s.stat.length > 0,
    base,
    first: (st, net) => firstAt[net - 1] === st.range.from.offset,
    ends: [],
    warn: (d) => warnings.push(d),
  };
  return { env, callEnv, base, warnings };
}

/**
 * Risolve un operando fuori da un blocco (tabelle di controllo): simboli globali, DB e indirizzi
 * assoluti, senza variabili locali. Stessa risoluzione del compilatore; lancia `SymbolError`.
 */
export function resolveGlobalOperand(op: Operand, ctx: AwlContext): Value {
  const tools = toolsOf(ctx);
  const env: SymbolEnv = {
    ctx,
    owner: 'OB',
    sections: { in: [], out: [], inOut: [], stat: [], temp: [], ret: [] },
    tools,
    temp: structLayout([], tools),
    formals: new Map(),
    cache: new Map(),
  };
  return resolveValue(op, env);
}
