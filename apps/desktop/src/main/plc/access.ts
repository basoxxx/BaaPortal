import type { ConnectOptions, PduLinkFactory } from '@baaportal/s7comm';
import { mpiSerialLink } from '@baaportal/s7comm/node';
import type { PlcAccess } from '@baaportal/ui';

const DEFAULT_PORT = 102;
const CONNECTION_TYPES = { PG: 'pg', OP: 'op', S7_BASIC: 'basic' } as const;
/** PDU proposta con l'adattatore MPI (libnodave gettingStarted.html; da verificare su adattatore reale). */
const MPI_PDU = 240;

/** Una sorveglianza (`PlcService`) che tiene aperta una porta MPI e sa farsi da parte. */
export interface PortHolder {
  /** Chiude il suo collegamento; si risolve a porta libera. */
  pause(): Promise<void>;
  /** Riapre il collegamento dopo una `pause`. */
  resume(): Promise<void>;
}

/**
 * Sorveglianze per porta MPI. La porta è una sola per tutto il processo e l'adattatore regge una
 * sessione alla volta: ogni altro collegamento sulla stessa porta (scrittura, download, osservazione,
 * stack, caricamento) prima ferma queste e alla sua chiusura le fa ripartire.
 */
const holders = new Map<string, Set<PortHolder>>();

const portKey = (access: PlcAccess): string | undefined =>
  access.link?.kind === 'mpi' ? access.link.port.trim().toLowerCase() : undefined;

/** Registra la sorveglianza sulla porta MPI dell'accesso; restituisce come toglierla. */
export function holdPort(access: PlcAccess, h: PortHolder): () => void {
  const key = portKey(access);
  if (key === undefined) return () => undefined;
  let set = holders.get(key);
  if (!set) holders.set(key, (set = new Set()));
  set.add(h);
  return () => {
    set.delete(h);
    if (set.size === 0 && holders.get(key) === set) holders.delete(key);
  };
}

/** Link che ferma le sorveglianze della porta prima di aprirsi e le riavvia a porta di nuovo libera. */
function yielding(key: string, inner: PduLinkFactory): PduLinkFactory {
  return async (o) => {
    const paused = [...(holders.get(key) ?? [])];
    await Promise.all(paused.map((h) => h.pause()));
    let resumed: Promise<void> | undefined;
    const resume = (): Promise<void> =>
      (resumed ??= Promise.all(paused.map((h) => h.resume())).then(() => undefined));
    let link;
    try {
      link = await inner(o);
    } catch (e) {
      await resume();
      throw e;
    }
    const l = link;
    return {
      sendPdu: (s7) => l.sendPdu(s7),
      onPdu: (cb) => l.onPdu(cb),
      onClose: (cb) => l.onClose(cb),
      // `S7Connection` chiude il link sia con `close()` sia dopo un errore: la ripresa c'è sempre
      close: async () => {
        try {
          await l.close();
        } finally {
          await resume();
        }
      },
    };
  };
}

/**
 * Opzioni di collegamento da un accesso del progetto, per TCP o adattatore MPI. Il trasporto TCP lo
 * mettono le funzioni di `@baaportal/s7comm/node`; con un link MPI non si usa. `monitor`: è la
 * sorveglianza stessa, che non ferma nessuno (una seconda sorveglianza sulla porta trova la porta
 * occupata).
 */
export function connectOptions(
  access: PlcAccess,
  timeoutMs: number,
  monitor = false,
): Omit<ConnectOptions, 'transport' | 'mode'> {
  const base = {
    host: access.host,
    port: access.port ?? DEFAULT_PORT,
    rack: access.rack,
    slot: access.slot,
    connectionType: CONNECTION_TYPES[access.connectionType],
    ...(access.remoteTsap !== undefined ? { remoteTsap: access.remoteTsap } : {}),
    timeoutMs,
  };
  const l = access.link;
  if (l?.kind !== 'mpi') return base;
  const link = mpiSerialLink(
    { path: l.port, baudRate: l.baudRate, parity: l.parity },
    {
      localAddress: l.localAddress,
      cpuAddress: l.cpuAddress,
      highestAddress: l.highestAddress,
      busSpeed: l.busSpeed,
      variant: l.variant,
    },
  );
  return {
    ...base,
    proposedPdu: MPI_PDU,
    link: monitor ? link : yielding(portKey(access)!, link),
  };
}

/** Dove sta la CPU, per i messaggi e le conferme: `192.0.2.1`, `192.0.2.1:10102` o `COM3, MPI 2`. */
export function accessLabel(access: PlcAccess): string {
  const l = access.link;
  if (l?.kind === 'mpi') return `${l.port}, MPI ${l.cpuAddress}`;
  const port = access.port !== undefined && access.port !== DEFAULT_PORT ? `:${access.port}` : '';
  return `${access.host}${port}`;
}

/** Chiave della CPU per l'adattatore MPI (porta e indirizzo); `undefined` per il TCP, che ha la sua. */
export function mpiKey(access: PlcAccess): string | undefined {
  const l = access.link;
  return l?.kind === 'mpi' ? `mpi:${l.port.trim().toLowerCase()}/${l.cpuAddress}` : undefined;
}
