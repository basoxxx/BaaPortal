import { describe, expect, it } from 'vitest';
import {
  S7Connection,
  S7WriteClient,
  encodeWriteRequest,
  memoryTransportPair,
  mpiAdapterLink,
  type ConnectOptions,
  type MpiOptions,
  type TransportFactory,
} from '@baaportal/s7comm';
import { FakeCpu, serve, serveMpiAdapter, type FakeMpiAdapterOptions } from '../src';
import { blockFile, seq, settle } from './helpers';
import { SMALL_DB, smallWorld } from './rig';

const MPI: MpiOptions = {
  localAddress: 0,
  cpuAddress: 2,
  highestAddress: 31,
  busSpeed: '187.5k',
  variant: 'auto',
};

const noTcp: TransportFactory = () => Promise.reject(new Error('il link MPI non usa il TCP'));

function viaTcp(cpu: FakeCpu): ConnectOptions {
  const transport: TransportFactory = async () => {
    const [a, b] = memoryTransportPair();
    serve(cpu, b);
    return a;
  };
  return { host: 'finto', transport, timeoutMs: 1000, proposedPdu: 240 };
}

function viaMpi(cpu: FakeCpu, adapter: FakeMpiAdapterOptions = {}, timeoutMs = 1000) {
  const fakes: ReturnType<typeof serveMpiAdapter>[] = [];
  const link = mpiAdapterLink(async () => {
    const [a, b] = memoryTransportPair();
    fakes.push(serveMpiAdapter(cpu, b, adapter));
    return a;
  }, MPI);
  const opts: ConnectOptions = { host: 'mpi', transport: noTcp, link, timeoutMs, proposedPdu: 240 };
  return { opts, fakes };
}

const CLOCK = () => ({
  year: 2026,
  month: 10,
  day: 29,
  hour: 9,
  minute: 0,
  second: 0,
  ms: 0,
  weekday: 5,
});
const FC = blockFile('FC', 7, seq(600, 3));

/** La stessa sequenza dei test in TCP: identità, blocchi, upload, download, STOP/RUN. */
async function scenario(o: ConnectOptions) {
  const c = await S7WriteClient.connect(o);
  try {
    const identity = await c.identity();
    const obs = (await c.listBlocks('OB')).map((b) => b.number);
    const db1 = await c.upload('DB', 1);
    await c.downloadBlock(FC);
    const fc7 = await c.upload('FC', 7);
    const fcs = (await c.listBlocks('FC')).map((b) => b.number);
    const stop = await c.stop();
    const stopped = await c.mode();
    const start = await c.start();
    const running = await c.mode();
    return { identity, obs, db1, fc7, fcs, stop, stopped, start, running };
  } finally {
    await c.close();
  }
}

describe('collegamento MPI attraverso l’adattatore finto', () => {
  it.each(['v1', 'v2'] as const)(
    'adattatore %s, variant auto: stessi risultati della stessa prova in TCP',
    async (variant) => {
      const tcpCpu = new FakeCpu({ clock: CLOCK });
      smallWorld(tcpCpu);
      const mpiCpu = new FakeCpu({ clock: CLOCK });
      smallWorld(mpiCpu);
      const tcp = await scenario(viaTcp(tcpCpu));
      const mpi = await scenario(viaMpi(mpiCpu, { variant }, 200).opts);
      expect(mpi).toEqual(tcp);
      expect(mpi.identity.orderNumber).toBe('6ES7 315-2EH14-0AB0');
      expect(mpi.db1.length).toBe(36 + SMALL_DB.length + 36);
      expect(mpi.fcs).toContain(7);
      expect([mpi.stopped, mpi.running]).toEqual(['STOP', 'RUN']);
    },
  );

  it('porta che si chiude a metà di un carica nel dispositivo: errore chiaro, niente blocco', async () => {
    const cpu = new FakeCpu();
    const { opts } = viaMpi(cpu, { dropOn: (s7) => s7[1] === 3 }); // primo ack-data del PG
    const c = await S7WriteClient.connect(opts);
    const t0 = Date.now();
    await expect(c.downloadBlock(FC)).rejects.toMatchObject({
      name: 'S7Error',
      code: 'CLOSED',
      message: expect.stringContaining('adattatore MPI'),
    });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(c.closed).toBe(true);
    expect(cpu.block('FC', 7)).toBeUndefined();
    await expect(c.identity()).rejects.toMatchObject({ code: 'CLOSED' });
  });

  it('adattatore che smette di rispondere a metà download: «Adattatore MPI non risponde»', async () => {
    const cpu = new FakeCpu();
    const { opts } = viaMpi(cpu, { muteOn: (s7) => s7[1] === 3 }, 100);
    const c = await S7WriteClient.connect(opts);
    await expect(c.downloadBlock(FC)).rejects.toMatchObject({
      code: 'MPI_NO_ADAPTER',
      message: expect.stringContaining('Adattatore MPI non risponde'),
    });
    expect(c.closed).toBe(true);
    expect(cpu.block('FC', 7)).toBeUndefined();
  });

  it('read-only: la scrittura si rifiuta e all’adattatore non arriva nessun byte', async () => {
    const cpu = new FakeCpu();
    cpu.setMemory('M', 0, seq(4));
    const { opts, fakes } = viaMpi(cpu);
    const conn = await S7Connection.open({ ...opts, mode: 'read-only' });
    await settle();
    const before = fakes[0]!.received.length;
    const w = encodeWriteRequest([
      { area: 'M', db: 0, start: 0, size: 'BYTE', count: 1, data: Uint8Array.of(0xaa) },
    ]);
    await expect(conn.request(w.param, w.data, 1)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await settle();
    await settle();
    expect(fakes[0]!.received.length).toBe(before);
    expect(conn.refusedCount).toBe(1);
    expect((JSON.parse(cpu.snapshot()) as { M: string }).M.startsWith('00010203')).toBe(true);
    await conn.close();
  });

  it('CPU a un altro indirizzo: MPI_NO_CPU con i nodi del bus', async () => {
    const cpu = new FakeCpu();
    const { opts } = viaMpi(cpu, { cpuAddress: 3, nodes: [0, 3] }, 50);
    await expect(S7Connection.open(opts)).rejects.toMatchObject({
      code: 'MPI_NO_CPU',
      message: expect.stringContaining('nodi sul bus: 0, 3'),
    });
  });
});
