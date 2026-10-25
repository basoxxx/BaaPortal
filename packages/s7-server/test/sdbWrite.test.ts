import { describe, expect, it } from 'vitest';
import {
  S7WriteClient,
  memoryTransportPair,
  type ConnectOptions,
  type TransportFactory,
} from '@baaportal/s7comm';
import { FakeCpu, serve, syntheticSdb, type FakeCpuOptions } from '../src';
import { blockFile, seq } from './helpers';

function world(o: FakeCpuOptions = {}): FakeCpu {
  const cpu = new FakeCpu({ mode: 'STOP', ...o });
  cpu.addBlock(blockFile('OB', 1, seq(50, 2)));
  cpu.addBlock(syntheticSdb(0, 32));
  cpu.addBlock(syntheticSdb(1000, 32));
  cpu.addBlock(syntheticSdb(2, 32));
  return cpu;
}

async function connect(
  cpu: FakeCpu,
  mode: 'online-write' | 'online-restore' = 'online-restore',
): Promise<S7WriteClient> {
  const transport: TransportFactory = async () => {
    const [a, b] = memoryTransportPair();
    serve(cpu, b);
    return a;
  };
  const o: ConnectOptions = { host: 'finto', transport, timeoutMs: 2000 };
  return S7WriteClient.connect(o, mode);
}

const cpuError = (cls: number, code: number): object => ({
  code: 'CPU_ERROR',
  detail: { errorClass: cls, errorCode: code },
});

describe('SDB nel finto PLC (ripristino)', () => {
  it('in STOP: download + _INSE di SDB 7 e _DELE di SDB 1000', async () => {
    const cpu = world();
    const c = await connect(cpu);
    await c.downloadBlock(syntheticSdb(7, 40));
    expect(cpu.block('SDB', 7)?.file.length).toBeGreaterThan(0);
    await c.deleteSystemBlock(1000);
    expect(cpu.block('SDB', 1000)).toBeUndefined();
    await c.close();
  });

  it('in RUN: download e _DELE di SDB rifiutati; i blocchi utente no', async () => {
    const cpu = world({ mode: 'RUN' });
    const c = await connect(cpu);
    await expect(c.downloadBlock(syntheticSdb(7, 40))).rejects.toMatchObject(cpuError(0xd2, 0x41));
    await expect(c.deleteSystemBlock(1000)).rejects.toMatchObject(cpuError(0xd2, 0x41));
    expect(cpu.block('SDB', 1000)).toBeDefined();
    await c.close();
  });

  it('SDB 2 e fuori intervallo: il client non invia nulla, il filtro non li ammette', async () => {
    const cpu = world();
    const c = await connect(cpu);
    await expect(c.deleteSystemBlock(2)).rejects.toMatchObject({ code: 'PROTOCOL' });
    await expect(c.downloadBlock(syntheticSdb(2, 40))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(c.downloadBlock(syntheticSdb(3000, 40))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(cpu.block('SDB', 2)).toBeDefined();
    await c.close();
  });

  it('online-write non scrive gli SDB', async () => {
    const cpu = world();
    const c = await connect(cpu, 'online-write');
    await expect(c.downloadBlock(syntheticSdb(7, 40))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await c.close();
  });

  it('readJobList nel modo del ripristino: solo la chiamata stessa', async () => {
    const c = await connect(world());
    expect(await c.readJobList()).toEqual([{ fn: 0x10, job: expect.any(Number) }]);
    await c.close();
  });

  it('insertBusy 2: due 0xD2A9 poi ok, con attesa di 200 ms iniettata', async () => {
    const cpu = world({ faults: { insertBusy: 2 } });
    const c = await connect(cpu);
    const waits: number[] = [];
    await c.downloadBlock(syntheticSdb(7, 40), {
      busyRetry: { sleep: async (ms) => void waits.push(ms) },
    });
    expect(waits).toEqual([200, 200]);
    expect(cpu.block('SDB', 7)).toBeDefined();
    await c.close();
  });

  it('senza busyRetry il primo 0xD2A9 è un errore', async () => {
    const c = await connect(world({ faults: { insertBusy: 1 } }));
    await expect(c.downloadBlock(syntheticSdb(7, 40))).rejects.toMatchObject(cpuError(0xd2, 0xa9));
    await c.close();
  });

  it('11 risposte 0xD2A9 → errore dopo 10 ritentativi', async () => {
    const cpu = world({ faults: { insertBusy: 11 } });
    const c = await connect(cpu);
    let waits = 0;
    await expect(
      c.downloadBlock(syntheticSdb(7, 40), { busyRetry: { sleep: async () => void waits++ } }),
    ).rejects.toMatchObject(cpuError(0xd2, 0xa9));
    expect(waits).toBe(10);
    expect(cpu.block('SDB', 7)).toBeUndefined();
    await c.close();
  });
});
