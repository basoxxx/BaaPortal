import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { connectTcp } from '@baaportal/s7comm/node';
import { FakeCpu } from '../src';
import { listen } from '../src/node';
import { seq } from './helpers';

describe('listen (TCP)', () => {
  it('porta 0 = libera su 127.0.0.1; il client vero legge; close() chiude tutto e si risolve', async () => {
    const cpu = new FakeCpu();
    cpu.addDb(1, seq(40));
    const srv = await listen(cpu);
    expect(srv.port).toBeGreaterThan(0);
    const c = await connectTcp({ host: '127.0.0.1', port: srv.port, timeoutMs: 2000 });
    expect((await c.identity()).orderNumber).toBe('6ES7 315-2EH14-0AB0');
    expect(await c.readArea('DB', 1, 0, 8)).toEqual(seq(8));
    expect((await c.upload('DB', 1)).length).toBe(36 + 40 + 36);
    expect(cpu.connections).toBe(1);
    await srv.close();
    expect(cpu.connections).toBe(0);
    await expect(c.readArea('DB', 1, 0, 8)).rejects.toMatchObject({ code: 'CLOSED' });
    await c.close();
    // il server non ascolta più
    await expect(
      new Promise((resolve, reject) => {
        const s = net.connect({ host: '127.0.0.1', port: srv.port });
        s.once('connect', () => {
          s.destroy();
          resolve(undefined);
        });
        s.once('error', reject);
      }),
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('17ª connessione TCP: il client riceve il DR (COTP_REJECTED); frammenti TCP minuscoli', async () => {
    const cpu = new FakeCpu({ maxConnections: 1, faults: { chunkSize: 3 } });
    const srv = await listen(cpu);
    const a = await connectTcp({ host: '127.0.0.1', port: srv.port, timeoutMs: 2000 });
    expect((await a.identity()).orderNumber).toBe('6ES7 315-2EH14-0AB0');
    await expect(
      connectTcp({ host: '127.0.0.1', port: srv.port, timeoutMs: 2000 }),
    ).rejects.toMatchObject({ code: 'COTP_REJECTED' });
    await a.close();
    await srv.close();
  });

  it('host e porta fissi: errore se la porta è occupata', async () => {
    const cpu = new FakeCpu();
    const srv = await listen(cpu);
    await expect(listen(cpu, { port: srv.port })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await srv.close();
  });
});
