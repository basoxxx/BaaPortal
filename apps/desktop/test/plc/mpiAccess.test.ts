import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBlockFile } from '@baaportal/s7comm';
import { FakeCpu } from '@baaportal/s7-server';
import type { MpiLink, PlcAccess, PlcEvent } from '@baaportal/ui';

// La porta seriale vera non c'è nei test: `serialport` finto porta all'adattatore MPI finto. Come la
// porta vera, rifiuta una seconda apertura dello stesso nome («Cannot lock port» su macOS) e si
// libera solo all'evento `close`, che arriva dopo `close()`.
const serial = vi.hoisted(() => ({
  opened: [] as { path: string; baudRate: number; parity: string }[],
  open: new Set<string>(),
  refused: 0,
  cpu: undefined as unknown,
  nodes: undefined as number[] | undefined,
}));
vi.mock('serialport', async () => {
  const { EventEmitter } = await import('node:events');
  const { memoryTransportPair } = await import('@baaportal/s7comm');
  const { serveMpiAdapter } = await import('@baaportal/s7-server');
  type End = ReturnType<typeof memoryTransportPair>[0];
  class FakePort extends EventEmitter {
    isOpen = false;
    #end: End | undefined;
    constructor(private readonly o: { path: string; baudRate: number; parity: string }) {
      super();
    }
    open(cb: (e: Error | null) => void) {
      const { path, baudRate, parity } = this.o;
      if (serial.open.has(path)) {
        serial.refused++;
        setTimeout(() => cb(new Error('Error Resource temporarily unavailable Cannot lock port')));
        return;
      }
      serial.open.add(path);
      serial.opened.push({ path, baudRate, parity });
      const [a, b] = memoryTransportPair();
      serveMpiAdapter(serial.cpu as FakeCpu, b, serial.nodes ? { nodes: serial.nodes } : {});
      a.onData((c) => this.emit('data', Buffer.from(c)));
      this.#end = a;
      this.isOpen = true;
      setTimeout(() => cb(null));
    }
    write(b: Uint8Array) {
      this.#end?.send(b);
    }
    close() {
      if (!this.isOpen) return;
      this.isOpen = false;
      this.#end?.close();
      setTimeout(() => {
        serial.open.delete(this.o.path);
        this.emit('close');
      }, 3);
    }
    static list = async () => [];
  }
  return { SerialPort: FakePort };
});

const { connectOptions } = await import('../../src/main/plc/access');
const { PlcService, connectMessage, MPI_PAUSED } = await import('../../src/main/plc/plcService');
const { mpiNodes, parsePlcAccess } = await import('../../src/main/plc/plcIpc');
const { PlcWriteService } = await import('../../src/main/plc/plcWrite');
const { BlockStatusService } = await import('../../src/main/plc/blockStatus');
const { memoryJobStore } = await import('../../src/main/plc/tisJobs');
const { readStacks } = await import('../../src/main/plc/stacks');
const { UploadService } = await import('../../src/main/plc/uploadAll');
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
  send(c: string, e: unknown) {
    if (c === 'plc:event') this.events.push(e as PlcEvent);
  },
  once: () => undefined,
  removeListener: () => undefined,
});

afterEach(() => {
  serial.opened = [];
  serial.nodes = undefined;
  serial.refused = 0;
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

  it('la sorveglianza TCP ha le stesse opzioni di sempre', () => {
    expect(connectOptions(TCP, 3000, true)).toEqual(connectOptions(TCP, 3000));
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
    expect(parsePlcAccess({ ...mpi, link: { ...LINK, localAddress: 2 } })).toBe(
      'L’indirizzo MPI della CPU deve essere diverso da quello dell’adattatore',
    );
    expect(parsePlcAccess({ ...TCP, link: { kind: 'usb' } })).toBe(
      'Tipo di collegamento non valido',
    );
  });
});

const T0 = { year: 2020, month: 5, day: 17, hour: 10, minute: 20, second: 30, ms: 0 };
function blockFile(type: 'OB' | 'FC', number: number, len = 100): Uint8Array {
  const mc7 = Uint8Array.from({ length: len }, (_, i) => (2 + i) & 0xff);
  return buildBlockFile(
    {
      type,
      number,
      language: 1,
      flags: 0x01,
      security: 0,
      codeTime: T0,
      interfaceTime: T0,
      ssbLength: 0,
      addLength: 0,
      localDataLength: 0,
      mc7Length: len,
    },
    mc7,
    { author: 'BAA', family: 'TEST', name: `${type}${number}`, version: '1.1', checksum: 0x1234 },
  );
}

describe('una sola sessione dell’adattatore per porta MPI', () => {
  it('online su MPI: download, scrittura, osservazione, stack e caricamento riescono; la sorveglianza riprende', async () => {
    const cpu = new FakeCpu({ mode: 'STOP' });
    cpu.addBlock(blockFile('OB', 1));
    serial.cpu = cpu;
    const service = new PlcService({ intervalMs: 20, connectTimeoutMs: 1000 });
    const o = owner();
    const access: PlcAccess = { ...TCP, host: '', link: LINK };
    expect(await service.connect(o, access)).toMatchObject({ ok: true });
    const monitorOk = async (): Promise<void> => {
      const r = await service.read(o, (run) => run((c) => c.listBlocks('OB')));
      expect(r).toMatchObject({ ok: true });
    };
    const writes = new PlcWriteService({ service, confirm: async () => true });

    expect(await writes.download(o, [blockFile('FC', 7)])).toEqual({
      ok: true,
      loaded: ['FC7'],
      deleted: [],
    });
    await monitorOk();

    expect(
      await writes.writeVars(o, [
        { target: { area: 'M', size: 'B', byte: 0 }, data: Uint8Array.of(1) },
      ]),
    ).toMatchObject({ ok: true });
    await monitorOk();

    const status = new BlockStatusService({ service, jobs: memoryJobStore() });
    const s = await status.start(o, {
      type: 'OB',
      number: 1,
      expect: { checksum: 0x1234, mc7Length: 100 },
      offsets: [0, 2, 4],
      saz: 10,
      mask: 0x03,
    });
    expect(s).toMatchObject({ ok: true });
    // intanto la sorveglianza è ferma: una lettura dice perché, senza «collegamento interrotto»
    expect(await service.read(o, (run) => run((c) => c.listBlocks('OB')))).toEqual({
      ok: false,
      error: MPI_PAUSED,
    });
    await status.stop(o);
    await monitorOk();

    expect(await readStacks(service, o, { experimental: true })).toMatchObject({ ok: true });
    await monitorOk();

    expect(await new UploadService().start(o, access)).toMatchObject({ ok: true });
    await monitorOk();

    expect(o.events.filter((e) => e.kind === 'lost')).toEqual([]);
    expect(service.status(o)).toMatchObject({ connected: true });
    expect(serial.refused).toBe(0);
    await service.closeAll();
    expect(serial.open.size).toBe(0);
  });

  it('una seconda sorveglianza sulla stessa porta: porta occupata, la prima resta online', async () => {
    serial.cpu = new FakeCpu();
    const service = new PlcService({ intervalMs: 20, connectTimeoutMs: 300 });
    const a = owner();
    const b = owner();
    expect(await service.connect(a, { ...TCP, host: '', link: LINK })).toMatchObject({ ok: true });
    const r = await service.connect(b, { ...TCP, host: '', link: { ...LINK, port: 'com3' } });
    expect(r).toMatchObject({
      ok: false,
      error: 'La porta com3 è già usata da un altro collegamento di BaaPortal',
    });
    expect(serial.refused).toBe(0);
    expect(a.events).toEqual([]);
    await service.closeAll();
  });
});
