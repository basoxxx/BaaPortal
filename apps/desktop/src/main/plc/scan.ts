import { connectTcp, probePort } from '@baaportal/s7comm/node';
import { S7Error } from '@baaportal/s7comm';
import type { FoundDevice, PlcIdentity, PlcMode } from '@baaportal/ui';
import { toPlcIdentity, toPlcMode } from './plcMap';

export type { FoundDevice };

export const SCAN_PORT = 102;
export const PROBE_TIMEOUT_MS = 400;
export const IDENTIFY_TIMEOUT_MS = 2000;
export const MAX_CONCURRENCY = 32;

export type ProbeFn = (host: string, signal: AbortSignal) => Promise<boolean>;
export type IdentifyFn = (
  host: string,
  signal: AbortSignal,
) => Promise<PlcIdentity & { mode: PlcMode }>;

/** Probe vero: connessione TCP alla porta 102 con 400 ms di attesa, senza traffico S7. */
export function createProbe(port = SCAN_PORT, timeoutMs = PROBE_TIMEOUT_MS): ProbeFn {
  return (host, signal) => probePort(host, port, timeoutMs, signal);
}

/**
 * Identify vero: collegamento in sola lettura (rack 0, slot 2, PG), legge identità e stato e
 * chiude sempre. Se la ricerca viene interrotta il socket è chiuso subito.
 */
export function createIdentify(port = SCAN_PORT, timeoutMs = IDENTIFY_TIMEOUT_MS): IdentifyFn {
  return async (host, signal) => {
    const client = await connectTcp({
      host,
      port,
      rack: 0,
      slot: 2,
      connectionType: 'pg',
      timeoutMs,
      mode: 'read-only',
      signal,
    });
    try {
      const identity = toPlcIdentity(await client.identity());
      const mode = toPlcMode(await client.mode());
      return { ...identity, mode };
    } finally {
      await client.close().catch(() => undefined);
    }
  };
}

/** Il motivo, in italiano, per cui un host che apre la 102 non è stato riconosciuto come CPU. */
export function unknownReason(err: unknown): string {
  if (err instanceof S7Error) {
    if (err.code === 'COTP_REJECTED') {
      return 'Risponde sulla porta 102 ma rifiuta il collegamento S7 (rack 0, slot 2)';
    }
    if (['TIMEOUT', 'CONNECT_TIMEOUT'].includes(err.code)) {
      return 'Risponde sulla porta 102 ma non come una CPU S7 (nessuna risposta)';
    }
    return `Risponde sulla porta 102 ma non come una CPU S7: ${err.message}`;
  }
  return `Risponde sulla porta 102 ma non come una CPU S7: ${err instanceof Error ? err.message : String(err)}`;
}

export interface ScanOptions {
  probe: ProbeFn;
  identify: IdentifyFn;
  concurrency?: number;
  signal: AbortSignal;
  onFound: (d: FoundDevice) => void;
  onProgress: (done: number, total: number) => void;
}

const ABORTED = Symbol('aborted');

/**
 * Scandisce gli host con al più `concurrency` prove insieme. Dopo l'interruzione ritorna subito
 * (le prove in corso ricevono il segnale e chiudono i loro socket) e non chiama più né `onFound`
 * né `onProgress`. Un host che apre la 102 ma non risponde come una CPU S7 compare come `unknown`
 * e la ricerca prosegue.
 */
export async function scanSubnet(hosts: string[], opts: ScanOptions): Promise<void> {
  const { signal } = opts;
  const total = hosts.length;
  const width = Math.max(1, Math.min(opts.concurrency ?? MAX_CONCURRENCY, MAX_CONCURRENCY));
  let next = 0;
  let done = 0;

  const aborted = new Promise<typeof ABORTED>((resolve) => {
    if (signal.aborted) resolve(ABORTED);
    else signal.addEventListener('abort', () => resolve(ABORTED), { once: true });
  });
  // Corre contro l'interruzione; un rifiuto arrivato dopo non resta «non gestito».
  const raced = <T>(p: Promise<T>): Promise<T | typeof ABORTED> => {
    p.catch(() => undefined);
    return Promise.race([p, aborted]);
  };

  const one = async (host: string): Promise<void> => {
    let open: boolean | typeof ABORTED;
    try {
      open = await raced(opts.probe(host, signal));
    } catch {
      open = false;
    }
    if (signal.aborted || open === ABORTED) return;
    if (!open) return;
    let device: FoundDevice;
    try {
      const r = await raced(opts.identify(host, signal));
      if (r === ABORTED) return;
      const { mode, ...identity } = r;
      device = { host, status: 'cpu', identity, mode };
    } catch (err) {
      device = { host, status: 'unknown', reason: unknownReason(err) };
    }
    if (!signal.aborted) opts.onFound(device);
  };

  const worker = async (): Promise<void> => {
    while (!signal.aborted && next < total) {
      const host = hosts[next++]!;
      await one(host);
      if (signal.aborted) return;
      done++;
      opts.onProgress(done, total);
    }
  };

  await Promise.race([Promise.all(Array.from({ length: width }, worker)), aborted]);
}
