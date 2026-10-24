import net from 'node:net';
import { S7Client } from '../client';
import { S7Error } from '../errors';
import { S7Connection, type ConnectOptions } from '../connection';
import type { Transport, TransportFactory } from '../transport';

const REFUSED = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND']);

/** Trasporto TCP su node:net. Unico file del pacchetto che importa node:net. */
/** Interno: non esportato dal punto di ingresso `./node` (vedi la regola ESLint). */
export const tcpTransport: TransportFactory = (host, port, timeoutMs, signal) =>
  new Promise<Transport>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new S7Error('ABORTED', 'operazione annullata'));
      return;
    }
    const socket = net.connect({ host, port });
    socket.setNoDelay(true);
    let onAbort: (() => void) | undefined;
    const done = (): void => {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    };
    const timer = setTimeout(() => {
      socket.destroy();
      done();
      reject(new S7Error('CONNECT_TIMEOUT', `connessione a ${host}:${port} oltre ${timeoutMs} ms`));
    }, timeoutMs);
    if (signal) {
      onAbort = () => {
        socket.destroy();
        done();
        reject(new S7Error('ABORTED', 'operazione annullata'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const onConnectError = (err: NodeJS.ErrnoException): void => {
      done();
      socket.destroy();
      const code = err.code ?? 'ERRORE';
      if (code === 'ETIMEDOUT') {
        reject(new S7Error('CONNECT_TIMEOUT', `connessione a ${host}:${port} scaduta (${code})`));
      } else if (REFUSED.has(code)) {
        reject(new S7Error('CONNECT_REFUSED', `connessione a ${host}:${port} rifiutata (${code})`));
      } else {
        reject(
          new S7Error(
            'CONNECT_REFUSED',
            `connessione a ${host}:${port} fallita (${code}: ${err.message})`,
          ),
        );
      }
    };
    socket.once('error', onConnectError);

    socket.once('connect', () => {
      done();
      socket.off('error', onConnectError);
      socket.setKeepAlive(true, 10000);

      let dataCb: ((c: Uint8Array) => void) | undefined;
      let closeCb: ((err?: Error) => void) | undefined;
      let lastError: Error | undefined;
      let notified = false;
      let ended = false;
      const backlog: Uint8Array[] = [];
      const notify = (): void => {
        if (notified || !closeCb || !ended || backlog.length > 0) return;
        notified = true;
        closeCb(lastError);
      };
      socket.on('data', (b: Buffer) => {
        const chunk = new Uint8Array(b.buffer, b.byteOffset, b.length).slice();
        if (dataCb) dataCb(chunk);
        else backlog.push(chunk);
      });
      socket.on('error', (err: NodeJS.ErrnoException) => {
        lastError = new S7Error('CLOSED', `connessione persa (${err.code ?? err.message})`);
      });
      socket.on('close', () => {
        lastError ??= new S7Error('CLOSED', 'connessione chiusa dalla CPU');
        ended = true;
        notify();
      });
      resolve({
        send: (bytes) => {
          if (socket.destroyed || !socket.writable) throw new S7Error('CLOSED', 'socket chiuso');
          socket.write(bytes);
        },
        onData: (cb) => {
          dataCb = cb;
          for (const c of backlog.splice(0)) cb(c);
          notify();
        },
        onClose: (cb) => {
          closeCb = cb;
          notify();
        },
        close: () => {
          if (socket.destroyed) return;
          socket.end();
          setTimeout(() => socket.destroy(), 1000).unref();
        },
      });
    });
  });

/** Apre una connessione S7 su TCP (node:net). */
export function openTcp(o: Omit<ConnectOptions, 'transport'>): Promise<S7Connection> {
  return S7Connection.open({ ...o, transport: tcpTransport });
}

/** Apre il client di lettura S7 su TCP (node:net). */
export function connectTcp(o: Omit<ConnectOptions, 'transport'>): Promise<S7Client> {
  return S7Client.connect({ ...o, mode: 'read-only', transport: tcpTransport });
}
