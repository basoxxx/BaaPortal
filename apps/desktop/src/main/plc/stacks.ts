import {
  S7Error,
  decodeBStack,
  decodeIStack,
  decodeLStack,
  hex,
  modeFrom,
  type ConnectOptions,
  type S7TestClient,
} from '@baaportal/s7comm';
import { connectTestTcp } from '@baaportal/s7comm/node';
import type { Decoded, PlcAccess, PlcMode, PlcStacksResult, Wire } from '@baaportal/ui';
import { cpuCode } from './blockStatus';
import { connectMessage, type PlcOwner, type PlcService } from './plcService';
import { toPlcMode } from './plcMap';
import { connectOptions } from './access';

const MAX_LSTACK = 16;

export type StacksClient = Pick<
  S7TestClient,
  'identity' | 'close' | 'readSzl' | 'tisFunctions' | 'readStack'
>;
export type StacksConnectFn = (
  o: Omit<ConnectOptions, 'transport' | 'mode'>,
) => Promise<StacksClient>;

export interface StacksOptions {
  /** L'impostazione sperimentale: senza `true` non si apre nessun collegamento. */
  experimental: boolean;
  connect?: StacksConnectFn;
  connectTimeoutMs?: number;
}

/** I `Uint8Array` diventano esadecimale, il resto passa com'è. */
function toWire<T>(v: T): Wire<T> {
  if (v instanceof Uint8Array) return hex(v) as Wire<T>;
  if (Array.isArray(v)) return v.map((x) => toWire(x)) as Wire<T>;
  if (typeof v === 'object' && v !== null) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toWire(x)])) as Wire<T>;
  }
  return v as Wire<T>;
}

const wired = <T>(
  r: { ok: true; value: T } | { ok: false; why: string; hex: string },
): Decoded<Wire<T>> => (r.ok ? { ok: true, value: toWire(r.value) } : r);

const fail = (
  reason: 'run' | 'unsupported' | 'offline' | 'error',
  error: string,
): PlcStacksResult => ({
  ok: false,
  reason,
  error,
});

const RUN_TEXT = 'Gli stack si leggono solo con la CPU in STOP';
const isStopped = (m: PlcMode): boolean => m === 'STOP' || m === 'HOLD';

type PlcStackBStack = Extract<PlcStacksResult, { ok: true }>['bstack'];

/** Una lettura che dà `run` (D081, la CPU non è più ferma) o un errore del servizio di lettura. */
class RunError extends Error {}

/**
 * Stack di chiamata (proto §18.6, formato da una sola fonte). Solo con l'impostazione sperimentale
 * e solo con la CPU in STOP o HOLD, controllato qui oltre che nell'interfaccia: il modo noto al
 * servizio, poi un collegamento `online-test` a parte con l'identità ricontrollata e il modo
 * riletto (0x0424). Mai eccezioni.
 */
export async function readStacks(
  service: Pick<PlcService, 'target' | 'modeOf'>,
  owner: PlcOwner,
  opts: StacksOptions,
): Promise<PlcStacksResult> {
  if (opts.experimental !== true) {
    return fail('error', 'Funzioni sperimentali disattivate (Opzioni, Impostazioni)');
  }
  const target = service.target(owner);
  if (!target) return fail('offline', 'Nessun collegamento online');
  const known = service.modeOf(owner);
  if (known === undefined || !isStopped(known)) return fail('run', RUN_TEXT);
  const access: PlcAccess = target.access;
  const connect: StacksConnectFn = opts.connect ?? connectTestTcp;
  let client: StacksClient;
  try {
    client = await connect(connectOptions(access, opts.connectTimeoutMs ?? 3000));
  } catch (err) {
    return fail('error', connectMessage(err, access));
  }
  try {
    const id = await client.identity();
    const want = target.identity;
    const serialDiffers =
      id.serialNumber !== undefined && want.serial !== undefined && id.serialNumber !== want.serial;
    if (id.orderNumber !== want.orderNumber || serialDiffers) {
      return fail(
        'error',
        'La CPU raggiunta non è quella collegata (numero di ordinazione o di serie diverso)',
      );
    }
    // il modo si rilegge sulla CPU: fra la sorveglianza e ora può essere ripartita
    const mode = toPlcMode(modeFrom(await client.readSzl(0x0424, 0)));
    if (!isStopped(mode)) return fail('run', RUN_TEXT);
    const fns = await client.tisFunctions();
    if (!fns.bstack || !fns.istack || !fns.lstack) {
      return fail('unsupported', 'Questa CPU non supporta la lettura degli stack');
    }
    /** Byte di uno stack; D081 e D0C5 fermano tutto, un altro errore resta di quello stack. */
    const fetchStack = async (
      kind: 'ISTACK' | 'BSTACK' | 'LSTACK',
      args?: { priority: number; depth: number },
    ): Promise<{ data: Uint8Array } | { error: string }> => {
      try {
        return { data: await client.readStack(kind, args) };
      } catch (err) {
        const code = cpuCode(err);
        if (code === 0xd081) throw new RunError(RUN_TEXT);
        if (code === 0xd0c5) throw new Error('Stack incoerente: blocchi ricaricati dopo lo STOP');
        if (err instanceof S7Error && (err.code === 'CLOSED' || err.code === 'TIMEOUT')) throw err;
        return { error: err instanceof Error ? err.message : String(err) };
      }
    };
    const decoded = <T>(
      r: { data: Uint8Array } | { error: string },
      decode: (b: Uint8Array) => { ok: true; value: T } | { ok: false; why: string; hex: string },
    ): Decoded<Wire<T>> =>
      'error' in r ? { ok: false, why: r.error, hex: '' } : wired(decode(r.data));

    const braw = await fetchStack('BSTACK');
    const bd = 'error' in braw ? undefined : decodeBStack(braw.data);
    // una voce incompleta e nient'altro: il formato non torna, si mostrano i byte
    const bstack: PlcStackBStack =
      'error' in braw
        ? { ok: false, why: braw.error, hex: '' }
        : bd?.ok && bd.value.entries.length === 0 && bd.value.rest !== undefined
          ? { ok: false, why: 'BSTACK incompleto', hex: hex(braw.data) }
          : decoded(braw, decodeBStack);
    const ustack = decoded(await fetchStack('ISTACK'), decodeIStack);
    const entries = bd?.ok ? bd.value.entries.slice(0, MAX_LSTACK) : [];
    const priority = entries.find((e) => e.ob)?.ob?.priority ?? 0;
    const lstack: Extract<PlcStacksResult, { ok: true }>['lstack'] = [];
    for (let depth = 0; depth < entries.length; depth++) {
      lstack.push({
        depth,
        value: decoded(await fetchStack('LSTACK', { priority, depth }), decodeLStack),
      });
    }
    return { ok: true, mode, bstack, ustack, lstack };
  } catch (err) {
    if (err instanceof RunError) return fail('run', err.message);
    return fail('error', err instanceof Error ? err.message : String(err));
  } finally {
    await client.close().catch(() => undefined);
  }
}
