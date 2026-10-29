import { describe, expect, it } from 'vitest';
import { FakeCpu, serveMpiAdapter } from '@baaportal/s7-server';
import { S7Client, hex, memoryTransportPair, mpiAdapterLink, type TransportFactory } from '../src';

const noTcp: TransportFactory = () => Promise.reject(new Error('il link MPI non usa il TCP'));

describe('S7Connection con mpiAdapterLink contro l’adattatore finto', () => {
  it.each(['v1', 'v2'] as const)(
    'adattatore %s: setup, identità e lettura; la chiusura stacca CPU e adattatore',
    async (variant) => {
      const cpu = new FakeCpu();
      cpu.setMemory('M', 0, Uint8Array.of(1, 2, 3, 4));
      let fake: ReturnType<typeof serveMpiAdapter> | undefined;
      const link = mpiAdapterLink(
        async () => {
          const [a, b] = memoryTransportPair();
          fake = serveMpiAdapter(cpu, b, { variant });
          return a;
        },
        { localAddress: 0, cpuAddress: 2, highestAddress: 31, busSpeed: '187.5k', variant },
      );
      const c = await S7Client.connect({ host: 'mpi', transport: noTcp, link, proposedPdu: 240 });
      expect(c.pduLength).toBe(240);
      expect((await c.identity()).orderNumber).toBe('6ES7 315-2EH14-0AB0');
      expect(await c.readArea('M', 0, 0, 4)).toEqual(Uint8Array.of(1, 2, 3, 4));
      const before = fake!.received.length;
      await c.close();
      await new Promise((r) => setTimeout(r, 20));
      expect(c.closed).toBe(true);
      // dopo la richiesta di disconnessione dalla CPU arriva la chiusura dell'adattatore
      const tail = fake!.received.slice(before).map(hex).join('');
      expect(tail).toContain('010402100314');
    },
  );
});
