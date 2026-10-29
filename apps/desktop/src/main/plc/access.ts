import { mpiAdapterLink, type ConnectOptions } from '@baaportal/s7comm';
import { openSerial } from '@baaportal/s7comm/node';
import type { PlcAccess } from '@baaportal/ui';

const DEFAULT_PORT = 102;
const CONNECTION_TYPES = { PG: 'pg', OP: 'op', S7_BASIC: 'basic' } as const;
/** PDU proposta con l'adattatore MPI (libnodave gettingStarted.html; da verificare su adattatore reale). */
const MPI_PDU = 240;

/**
 * Opzioni di collegamento da un accesso del progetto, per TCP o adattatore MPI. Il trasporto TCP lo
 * mettono le funzioni di `@baaportal/s7comm/node`; con un link MPI non si usa.
 */
export function connectOptions(
  access: PlcAccess,
  timeoutMs: number,
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
  return {
    ...base,
    proposedPdu: MPI_PDU,
    link: mpiAdapterLink(openSerial({ path: l.port, baudRate: l.baudRate, parity: l.parity }), {
      localAddress: l.localAddress,
      cpuAddress: l.cpuAddress,
      highestAddress: l.highestAddress,
      busSpeed: l.busSpeed,
      variant: l.variant,
    }),
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
