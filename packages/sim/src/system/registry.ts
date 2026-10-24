import { findSystemBlock, type SystemBlock } from '@baaportal/catalog';
import { pointerLocation } from '../calls';
import { SimError, StopRequest } from '../errors';
import type { ExecContext, ExecState } from '../executor';
import { SFB_TABLE } from './sfb';
import { SFC_TABLE } from './sfc';
import {
  SysError,
  paramRef,
  type SystemCall,
  type SystemHandler,
  type SystemServices,
} from './params';

/** Gestori delle SFC simulate, per numero. Un numero assente dal registro dà l'avviso «non simulata». */
export const SFC_HANDLERS: Record<number, SystemHandler> = SFC_TABLE;

/** Gestori degli SFB simulati, per numero (SFB 0–5; leggono il DB di istanza in DI e AR2). */
export const SFB_HANDLERS: Record<number, SystemHandler> = SFB_TABLE;

/** Ordine dei puntatori nella lista di una SFC (come lo genera il compilatore): IN, RET_VAL, OUT, IN_OUT. */
interface Layout {
  names: string[];
  /** Numero del parametro per i codici 16#8xyy (da 1, RET_VAL esclusa). */
  numbers: number[];
}

const LAYOUTS = new WeakMap<SystemBlock, Layout>();

function layoutOf(b: SystemBlock): Layout {
  let l = LAYOUTS.get(b);
  if (l) return l;
  const names: string[] = [];
  const numbers: number[] = [];
  let n = 0;
  const add = (list: readonly { name: string }[]): void => {
    for (const m of list) {
      names.push(m.name);
      numbers.push(++n);
    }
  };
  add(b.input);
  if (b.returnType !== undefined) {
    names.push('RET_VAL');
    numbers.push(0);
  }
  add(b.output);
  add(b.inOut);
  LAYOUTS.set(b, (l = { names, numbers }));
  return l;
}

/** Servizi per un'esecuzione senza CPU (prove): orologio dall'`now()` del contesto, nessuna SZL. */
function standaloneServices(ctx: ExecContext): SystemServices {
  const boot = ctx.now();
  let offset = 0;
  let waitedUs = 0;
  const now = (): number => ctx.now() + Math.floor(waitedUs / 1000);
  return {
    clockMs: () => now() + offset,
    setClockMs: (ms) => {
      offset = ms - now();
    },
    tickMs: () => (((now() - boot) % 2 ** 31) + 2 ** 31) % 2 ** 31,
    wait: (us) => {
      waitedUs += us;
    },
    stop: (reason) => {
      throw new StopRequest(reason);
    },
    warnNotSimulated: () => undefined,
    sfbState: new Map(),
    szl: () => undefined,
    maxDb: 16000,
  };
}

/** Servizi di sistema del contesto: quelli della CPU, o (senza CPU) quelli isolati, creati una volta. */
export function servicesOf(ctx: ExecContext): SystemServices {
  return (ctx.sys ??= standaloneServices(ctx));
}

/**
 * UC/CC di una SFC o di un SFB. Numero assente dal catalogo: errore di programmazione (SFC/SFB non
 * caricata, OB121 16#3D/16#3F). Senza gestore: avviso «non simulata», BR = 0, uscite intatte, la CPU
 * prosegue. Un errore del parametro (area, DB, lunghezza) dà RET_VAL negativo e BR = 0, senza scritture.
 */
export function callSystem(
  st: ExecState,
  kind: 'SFC' | 'SFB',
  number: number,
  pointers: readonly Uint8Array[] | undefined,
): void {
  const block = findSystemBlock({ kind, number });
  if (!block)
    throw new SimError('BLOCCO_NON_CARICATO', `${kind}${number}`, {
      missingBlock: kind,
      faultReg: number,
    });
  const services = servicesOf(st.ctx);
  const handler = (kind === 'SFC' ? SFC_HANDLERS : SFB_HANDLERS)[number];
  const stw = st.regs.stw;
  if (!handler) {
    services.warnNotSimulated(kind, number);
    stw.br = false;
    return;
  }
  const layout = layoutOf(block);
  if (kind === 'SFC' && (pointers?.length ?? 0) !== layout.names.length)
    throw new SimError(
      'MC7_NON_ESEGUIBILE',
      `${block.name}: ${pointers?.length ?? 0} puntatori, attesi ${layout.names.length}`,
    );
  const locs = (pointers ?? []).map((p) => pointerLocation(st, p));
  const call: SystemCall = {
    ctx: st,
    kind,
    number,
    block,
    services,
    param(name) {
      const canonical = block.paramAliases?.[name] ?? name;
      const i = layout.names.findIndex((n) => n.toLowerCase() === canonical.toLowerCase());
      if (i < 0 || (kind === 'SFB' && !pointers))
        throw new SimError('MC7_NON_ESEGUIBILE', `${block.name}: parametro ${name} sconosciuto`);
      return paramRef(st, locs[i] ?? null, layout.names[i]!, layout.numbers[i]!);
    },
    ret(value) {
      // RET_VAL di tipo INT: errore se negativo; TIME (TIME_TCK) non è un codice d'errore.
      const isInt = block.returnType === 'Int';
      if (block.returnType !== undefined)
        call.param('RET_VAL').write(isInt ? 'W' : 'D', value >>> 0);
      stw.br = isInt ? (value & 0x8000) === 0 : true;
    },
  };
  stw.br = true;
  try {
    handler(call);
  } catch (e) {
    if (!(e instanceof SysError)) throw e;
    call.ret(e.retVal);
  }
}
