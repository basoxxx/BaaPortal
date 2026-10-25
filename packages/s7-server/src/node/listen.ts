import net from 'node:net';
import { S7Error, type Transport } from '@baaportal/s7comm';
import type { CpuBackend } from '../backend';
import { serve } from '../session';

export interface ListenOptions {
  /** Predefinito 127.0.0.1: il finto PLC non esce dalla macchina se non lo si chiede. */
  host?: string;
  /** 0 (predefinito) = una porta libera, restituita in `port`. */
  port?: number;
}

export interface ListeningCpu {
  port: number;
  /** Chiude il server e tutte le sessioni; si risolve a chiusura avvenuta. */
  close(): Promise<void>;
}

/** Trasporto sopra un socket accettato. Unico file del pacchetto che importa node:net. */
function socketTransport(socket: net.Socket): Transport {
  let dataCb: ((c: Uint8Array) => void) | undefined;
  let closeCb: ((err?: Error) => void) | undefined;
  let ended = false;
  let notified = false;
  const backlog: Uint8Array[] = [];
  const notify = (): void => {
    if (notified || !closeCb || !ended || backlog.length > 0) return;
    notified = true;
    closeCb();
  };
  socket.setNoDelay(true);
  socket.on('data', (b: Buffer) => {
    const chunk = new Uint8Array(b.buffer, b.byteOffset, b.length).slice();
    if (dataCb) dataCb(chunk);
    else backlog.push(chunk);
  });
  socket.on('error', () => undefined); // 'close' segue sempre
  socket.on('close', () => {
    ended = true;
    notify();
  });
  return {
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
    // end() lascia partire i byte già scritti (un DR di rifiuto); destroySoon chiude subito dopo
    close: () => {
      if (!socket.destroyed) socket.destroySoon();
    },
  };
}

/** Mette in ascolto il finto PLC (o qualunque `CpuBackend`, p.es. la CPU simulata) su TCP. Ogni connessione accettata diventa una sessione `serve`. */
export function listen(cpu: CpuBackend, opts: ListenOptions = {}): Promise<ListeningCpu> {
  const sockets = new Set<net.Socket>();
  const sessions = new Set<{ close(): void }>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const session = serve(cpu, socketTransport(socket));
    sessions.add(session);
    socket.once('close', () => sessions.delete(session));
  });
  return new Promise<ListeningCpu>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address() as net.AddressInfo;
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            for (const s of [...sessions]) s.close();
            for (const s of sockets) s.destroy();
          }),
      });
    });
  });
}
