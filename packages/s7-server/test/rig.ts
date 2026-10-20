import {
  S7Client,
  memoryTransportPair,
  type CaptureRecorder,
  type TransportFactory,
} from '@baaportal/s7comm';
import { connectTcp } from '@baaportal/s7comm/node';
import { serve, type FakeCpu } from '../src';
import { listen } from '../src/node';

export type Via = 'memory' | 'tcp';

export interface Rig {
  /** Un nuovo client collegato al finto PLC. */
  connect(o?: {
    proposedPdu?: number;
    timeoutMs?: number;
    recorder?: CaptureRecorder;
  }): Promise<S7Client>;
  close(): Promise<void>;
}

/** Il finto PLC raggiunto in memoria o con un vero socket TCP su 127.0.0.1 (porta libera). */
export async function rig(cpu: FakeCpu, via: Via): Promise<Rig> {
  const clients = new Set<S7Client>();
  const track = (c: S7Client): S7Client => {
    clients.add(c);
    return c;
  };
  if (via === 'memory') {
    const transport: TransportFactory = async () => {
      const [a, b] = memoryTransportPair();
      serve(cpu, b);
      return a;
    };
    return {
      connect: async (o = {}) =>
        track(await S7Client.connect({ host: 'finto', transport, timeoutMs: 3000, ...o })),
      close: async () => {
        for (const c of clients) await c.close();
      },
    };
  }
  const srv = await listen(cpu);
  return {
    connect: async (o = {}) =>
      track(await connectTcp({ host: '127.0.0.1', port: srv.port, timeoutMs: 3000, ...o })),
    close: async () => {
      for (const c of clients) await c.close();
      await srv.close();
    },
  };
}

/** Un finto PLC popolato, e il giro completo di tutti i metodi di lettura con il controllo dei risultati. */
import { expect } from 'vitest';
import type { S7Client as Client } from '@baaportal/s7comm';
import { FakeCpu as Fake } from '../src';
import { blockFile, seq } from './helpers';

export const SMALL_DB = Uint8Array.from({ length: 600 }, (_, i) => (i * 5 + 1) & 0xff);

export function smallWorld(cpu: Fake): void {
  cpu.addDb(1, SMALL_DB);
  cpu.addBlock(blockFile('OB', 1, seq(50, 2)));
  cpu.setMemory('M', 10, seq(100, 9));
  cpu.addDiagnostic({
    eventId: 0x4302,
    info: new Uint8Array(10),
    time: { year: 2025, month: 1, day: 2, hour: 3, minute: 4, second: 5, ms: 6, weekday: 5 },
  });
}

export async function exerciseAll(cl: Client): Promise<void> {
  expect((await cl.identity()).orderNumber).toBe('6ES7 315-2EH14-0AB0');
  expect(await cl.mode()).toBe('RUN');
  expect((await cl.communication()).maxPdu).toBeGreaterThan(0);
  expect(await cl.protection()).toMatchObject({ validLevel: 1 });
  expect(await cl.readArea('M', 0, 10, 100)).toEqual(seq(100, 9));
  expect(await cl.readArea('DB', 1, 0, 600)).toEqual(SMALL_DB);
  expect(
    (await cl.readItems([{ area: 'M', db: 0, start: 10, size: 'BYTE', count: 2 }]))[0],
  ).toMatchObject({
    ok: true,
    data: seq(2, 9),
  });
  expect((await cl.blockCounts()).DB).toBe(1);
  expect((await cl.listBlocks('DB')).map((e) => e.number)).toEqual([1]);
  expect(await cl.listBlocks('FC')).toEqual([]);
  expect((await cl.blockInfo('OB', 1)).mc7Length).toBe(50);
  expect((await cl.upload('DB', 1)).length).toBe(36 + 600 + 36);
  expect((await cl.readClock()).year).toBeGreaterThan(2000);
  expect((await cl.diagnosticBuffer()).map((d) => d.eventId)).toEqual([0x4302]);
}
