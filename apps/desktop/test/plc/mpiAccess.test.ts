import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryTransportPair } from '@baaportal/s7comm';
import { FakeCpu, serveMpiAdapter } from '@baaportal/s7-server';
import type { MpiLink, PlcAccess, PlcEvent } from '@baaportal/ui';

// La porta seriale vera non c'è nei test: `openSerial` apre l'adattatore MPI finto.
const serial = vi.hoisted(() => ({
  opened: [] as { path: string; baudRate: number; parity: string }[],
  cpu: undefined as unknown,
  nodes: undefined as number[] | undefined,
}));
vi.mock('@baaportal/s7comm/node', async (orig) => ({
  ...(await orig<typeof import('@baaportal/s7comm/node')>()),
  openSerial: (o: { path: string; baudRate: number; parity: string }) => async () => {
    serial.opened.push(o);
    const [a, b] = memoryTransportPair();
    serveMpiAdapter(serial.cpu as FakeCpu, b, serial.nodes ? { nodes: serial.nodes } : {});
    return a;
  },
}));

const { connectOptions } = await import('../../src/main/plc/access');
const { PlcService, connectMessage } = await import('../../src/main/plc/plcService');
const { mpiNodes, parsePlcAccess } = await import('../../src/main/plc/plcIpc');
const { S7Error } = await import('@baaportal/s7comm');

const LINK: MpiLink = {
  kind: 'mpi',
  port: 'COM3',
  baudRate: 38400,
  parity: 'odd',
  localAddress: 0,
  cpuAddress: 2,
  highestAddress: 31,
  busSpeed: '187.5k',
  variant: 'auto',
};
const TCP: PlcAccess = { host: '192.0.2.10', rack: 0, slot: 2, connectionType: 'PG' };

const owner = () => ({
  events: [] as PlcEvent[],
  isDestroyed: () => false,
  send(_c: string, e: PlcEvent) {
    this.events.push(e);
  },
  once: () => undefined,
  removeListener: () => undefined,
});

afterEach(() => {
  serial.opened = [];
  serial.nodes = undefined;
});

describe('accesso con l’adattatore MPI', () => {
  it('senza link: le opzioni TCP di sempre, niente link e PDU predefinita', () => {
    expect(connectOptions(TCP, 3000)).toEqual({
      host: '192.0.2.10',
      port: 102,
      rack: 0,
      slot: 2,
      connectionType: 'pg',
      timeoutMs: 3000,
    });
  });

  it('con link MPI: link dell’adattatore e PDU 240', () => {
    const o = connectOptions({ ...TCP, link: LINK }, 3000);
    expect(o.link).toBeTypeOf('function');
    expect(o.proposedPdu).toBe(240);
  });

  it('PlcService si collega attraverso l’adattatore (porta, velocità e parità del progetto)', async () => {
    serial.cpu = new FakeCpu();
    const service = new PlcService({ intervalMs: 50 });
    const r = await service.connect(owner(), { ...TCP, host: '', link: LINK });
    expect(r).toMatchObject({ ok: true, identity: { orderNumber: '6ES7 315-2EH14-0AB0' } });
    expect(serial.opened).toEqual([{ path: 'COM3', baudRate: 38400, parity: 'odd' }]);
    await service.closeAll();
  });

  it('CPU a un altro indirizzo: errore MPI_NO_CPU con i nodi visti, così com’è', async () => {
    serial.cpu = new FakeCpu();
    const service = new PlcService({ connectTimeoutMs: 500 });
    const r = await service.connect(owner(), { ...TCP, link: { ...LINK, cpuAddress: 5 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/indirizzo MPI 5.*nodi sul bus/);
    await service.closeAll();
  });

  it('connectMessage: gli errori dell’adattatore e della porta passano com’è', () => {
    const mpi = { ...TCP, link: LINK };
    const busy = new S7Error('SERIAL_BUSY', 'La porta COM3 è usata da un altro programma');
    expect(connectMessage(busy, mpi)).toBe('La porta COM3 è usata da un altro programma');
    expect(connectMessage(new S7Error('TIMEOUT', 'x'), mpi)).toBe(
      'Nessuna risposta da COM3, MPI 2',
    );
    expect(connectMessage(new S7Error('TIMEOUT', 'x'), TCP)).toBe(
      'Nessuna risposta da 192.0.2.10:102',
    );
  });

  it('«Cerca»: mpiNodes elenca i nodi del bus', async () => {
    serial.cpu = new FakeCpu();
    serial.nodes = [0, 2, 6];
    expect(await mpiNodes(LINK)).toEqual({ ok: true, nodes: [0, 2, 6] });
    expect(await mpiNodes({ ...LINK, highestAddress: 30 })).toEqual({
      ok: false,
      error: 'Indirizzo più alto (HSA) non valido',
    });
  });

  it('parsePlcAccess: link MPI valido passa, fuori campo si rifiuta', () => {
    const mpi = { ...TCP, host: '', link: LINK };
    expect(parsePlcAccess(mpi)).toEqual(mpi);
    expect(parsePlcAccess({ ...TCP, link: { kind: 'tcp' } })).toEqual({
      ...TCP,
      link: { kind: 'tcp' },
    });
    expect(parsePlcAccess({ ...TCP, host: '' })).toBe('Indirizzo non valido');
    expect(parsePlcAccess({ ...mpi, link: { ...LINK, cpuAddress: 127 } })).toBe(
      'Indirizzo MPI non valido',
    );
    expect(parsePlcAccess({ ...mpi, link: { ...LINK, busSpeed: '12M' } })).toBe(
      'Velocità del bus non valida',
    );
    expect(parsePlcAccess({ ...mpi, link: { ...LINK, parity: 'mark' } })).toBe('Parità non valida');
    expect(parsePlcAccess({ ...mpi, link: { ...LINK, baudRate: 0 } })).toBe(
      'Velocità di trasmissione non valida',
    );
    expect(parsePlcAccess({ ...TCP, link: { kind: 'usb' } })).toBe(
      'Tipo di collegamento non valido',
    );
  });
});
