import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { S7Connection } from '../src';
import { openTcp, tcpTransport } from '../src/node';

const servers: net.Server[] = [];
const sockets: net.Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
});

async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

describe('tcpTransport', () => {
  it('porta chiusa di 127.0.0.1 -> CONNECT_REFUSED con il codice del sistema', async () => {
    const port = await closedPort();
    await expect(tcpTransport('127.0.0.1', port, 2000)).rejects.toMatchObject({
      code: 'CONNECT_REFUSED',
      message: expect.stringContaining('ECONNREFUSED'),
    });
  });

  it('server che accetta e tace: connessione riuscita, poi CONNECT_TIMEOUT sul CC', async () => {
    const server = net.createServer((s) => sockets.push(s));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    const t0 = Date.now();
    await expect(
      S7Connection.open({ host: '127.0.0.1', port, timeoutMs: 200, transport: tcpTransport }),
    ).rejects.toMatchObject({ code: 'CONNECT_TIMEOUT' });
    expect(Date.now() - t0).toBeLessThan(300);
  });

  it('il server che chiude dopo la connessione dà CLOSED', async () => {
    const server = net.createServer((s) => {
      sockets.push(s);
      setTimeout(() => s.destroy(), 20);
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    const t = await tcpTransport('127.0.0.1', port, 1000);
    t.onData(() => undefined);
    const err = await new Promise<Error | undefined>((r) => t.onClose(r));
    expect(err === undefined || (err as { code?: string }).code === 'CLOSED').toBe(true);
    t.close();
  });

  it('RST dopo la connessione (ECONNRESET/EPIPE) dà CLOSED', async () => {
    const server = net.createServer((s) => {
      sockets.push(s);
      setTimeout(() => s.resetAndDestroy(), 20);
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    const t = await tcpTransport('127.0.0.1', port, 1000);
    t.onData(() => undefined);
    const err = await new Promise<Error | undefined>((r) => t.onClose(r));
    expect((err as { code?: string }).code).toBe('CLOSED');
    expect(err?.message).toMatch(/ECONNRESET|EPIPE|chiusa/);
  });

  it('i dati arrivati prima di onData sono conservati', async () => {
    const server = net.createServer((s) => {
      sockets.push(s);
      s.write(Uint8Array.of(1, 2, 3));
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    const t = await tcpTransport('127.0.0.1', port, 1000);
    await new Promise((r) => setTimeout(r, 50));
    const got: number[] = [];
    t.onData((c) => got.push(...c));
    expect(got).toEqual([1, 2, 3]);
    t.close();
  });

  it('abort durante la connessione TCP: ABORTED', async () => {
    const ac = new AbortController();
    const p = tcpTransport('127.0.0.1', await closedPort(), 2000, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('openTcp apre su tcpTransport (porta chiusa: CONNECT_REFUSED)', async () => {
    await expect(openTcp({ host: '127.0.0.1', port: await closedPort() })).rejects.toMatchObject({
      code: 'CONNECT_REFUSED',
    });
  });
});
