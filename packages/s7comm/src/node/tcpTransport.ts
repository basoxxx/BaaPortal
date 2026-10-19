import net from 'node:net';
import { S7Error } from '../errors';
import type { Transport, TransportFactory } from '../transport';

const REFUSED = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND']);

/** Trasporto TCP su node:net. Unico file del pacchetto che importa node:net. */
export const tcpTransport: TransportFactory = (host, port, timeoutMs) =>
  new Promise<Transport>((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setNoDelay(true);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new S7Error('CONNECT_TIMEOUT', `connessione a ${host}:${port} oltre ${timeoutMs} ms`));
    }, timeoutMs);

    const onConnectError = (err: NodeJS.ErrnoException): void => {
      clearTimeout(timer);
      socket.destroy();
      const code = err.code ?? 'ERRORE';
      reject(
        REFUSED.has(code)
          ? new S7Error('CONNECT_REFUSED', `connessione a ${host}:${port} rifiutata (${code})`)
          : new S7Error(
              'CONNECT_REFUSED',
              `connessione a ${host}:${port} fallita (${code}: ${err.message})`,
            ),
      );
    };
    socket.once('error', onConnectError);

    socket.once('connect', () => {
      clearTimeout(timer);
      socket.off('error', onConnectError);
      socket.setKeepAlive(true, 10000);

      let dataCb: ((c: Uint8Array) => void) | undefined;
      let closeCb: ((err?: Error) => void) | undefined;
      let lastError: Error | undefined;
      let notified = false;
      const notify = (): void => {
        if (notified || !closeCb) return;
        notified = true;
        closeCb(lastError);
      };
      socket.on('data', (b: Buffer) => dataCb?.(new Uint8Array(b.buffer, b.byteOffset, b.length)));
      socket.on('error', (err: NodeJS.ErrnoException) => {
        lastError = new S7Error('CLOSED', `connessione persa (${err.code ?? err.message})`);
      });
      socket.on('close', () => {
        lastError ??= new S7Error('CLOSED', 'connessione chiusa dalla CPU');
        notify();
      });
      resolve({
        send: (bytes) => {
          if (socket.destroyed || !socket.writable) throw new S7Error('CLOSED', 'socket chiuso');
          socket.write(bytes);
        },
        onData: (cb) => {
          dataCb = cb;
        },
        onClose: (cb) => {
          closeCb = cb;
          if (socket.destroyed) notify();
        },
        close: () => {
          if (socket.destroyed) return;
          socket.end();
          setTimeout(() => socket.destroy(), 1000).unref();
        },
      });
    });
  });
