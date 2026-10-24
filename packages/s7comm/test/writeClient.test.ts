import { describe, expect, it } from 'vitest';
import { FakeCpu, serve } from '@baaportal/s7-server';
import {
  S7Client,
  S7Error,
  S7WriteClient,
  buildBlockFile,
  memoryTransportPair,
  type TransportFactory,
} from '../src';

const T0 = { year: 2020, month: 5, day: 17, hour: 10, minute: 20, second: 30, ms: 0 };

function blockFile(number: number, mc7: Uint8Array): Uint8Array {
  return buildBlockFile(
    {
      type: 'FC',
      number,
      language: 1,
      flags: 0x01,
      security: 0,
      codeTime: T0,
      interfaceTime: T0,
      ssbLength: 0,
      addLength: 0,
      localDataLength: 0,
      mc7Length: mc7.length,
    },
    mc7,
    { author: 'BAA', family: 'TEST', name: `FC${number}`, version: '1.1', checksum: 0x1234 },
  );
}

async function rig(cpu: FakeCpu): Promise<S7WriteClient> {
  const transport: TransportFactory = async () => {
    const [a, b] = memoryTransportPair();
    serve(cpu, b);
    return a;
  };
  return S7WriteClient.connect({ host: 'finto', transport, timeoutMs: 3000 });
}

describe('S7WriteClient contro il finto PLC', () => {
  it('writeArea di 1000 byte su un DB poi readArea rilegge identico', async () => {
    const cpu = new FakeCpu();
    cpu.addDb(1, new Uint8Array(1200));
    const c = await rig(cpu);
    const data = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7 + 3) & 0xff);
    await c.writeArea('DB', 1, 50, data); // più di una PDU da 240
    expect(await c.readArea('DB', 1, 50, 1000)).toEqual(data);
    const r = await c.writeItems([
      { area: 'M', db: 0, start: 0, size: 'BYTE', count: 2, data: Uint8Array.of(9, 8) },
    ]);
    expect(r).toEqual([{ returnCode: 0xff, name: expect.any(String) }]);
    await c.close();
  });

  it('downloadBlock di un blocco → upload dello stesso blocco identico byte per byte', async () => {
    const cpu = new FakeCpu();
    const c = await rig(cpu);
    const file = blockFile(
      7,
      Uint8Array.from({ length: 700 }, (_, i) => (i * 3 + 1) & 0xff),
    );
    await c.downloadBlock(file);
    expect((await c.blockInfo('FC', 7)).mc7Length).toBe(700);
    expect(await c.upload('FC', 7)).toEqual(file);
    await c.close();
  });

  it('stop() → ControlResult ok e mode()==="STOP"; stop() di nuovo → "già STOP"', async () => {
    const c = await rig(new FakeCpu());
    expect(await c.stop()).toEqual({ code: 0, name: 'ok' });
    expect(await c.mode()).toBe('STOP');
    expect(await c.stop()).toEqual({ code: 0x07, name: 'già STOP' });
    await c.close();
  });

  it('start() → RUN; su CPU protetta 2 la writeArea dà S7Error CPU_ERROR 0xD241', async () => {
    const stopped = await rig(new FakeCpu({ mode: 'STOP' }));
    expect(await stopped.start()).toEqual({ code: 0, name: 'ok' });
    expect(await stopped.mode()).toBe('RUN');
    expect(await stopped.start()).toEqual({ code: 0x03, name: 'già RUN' });
    await stopped.close();

    const cpu = new FakeCpu({ protectionLevel: 2 });
    cpu.addDb(1, new Uint8Array(10));
    const c = await rig(cpu);
    const e: unknown = await c.writeArea('DB', 1, 0, Uint8Array.of(1)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(S7Error);
    expect(e).toMatchObject({ code: 'CPU_ERROR', detail: { errorClass: 0xd2, errorCode: 0x41 } });
    const s: unknown = await c.stop().catch((x: unknown) => x);
    expect(s).toMatchObject({ code: 'CPU_ERROR', detail: { errorClass: 0xd2, errorCode: 0x41 } });
    await c.close();
  });

  it('S7Client (lettura) non ha metodi di scrittura (chiavi del prototipo)', () => {
    const keys = Object.getOwnPropertyNames(S7Client.prototype);
    for (const k of ['writeItems', 'writeArea', 'downloadBlock', 'stop', 'start']) {
      expect(keys).not.toContain(k);
    }
  });
});
