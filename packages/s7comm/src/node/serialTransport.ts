import { SerialPort } from 'serialport';
import { S7Error } from '../errors';
import type { Transport } from '../transport';

export interface SerialPortEntry {
  path: string;
  manufacturer?: string;
  vendorId?: string;
  productId?: string;
}

/** Trasporto su porta seriale (adattatore MPI/USB), 8 bit di dati e 1 di stop. Carica `serialport` solo nel main. */
export function openSerial(o: {
  path: string;
  baudRate: number;
  parity: 'odd' | 'even' | 'none';
}): () => Promise<Transport> {
  return () =>
    new Promise<Transport>((resolve, reject) => {
      const port = new SerialPort({
        path: o.path,
        baudRate: o.baudRate,
        parity: o.parity,
        dataBits: 8,
        stopBits: 1,
        autoOpen: false,
      });
      port.open((err) => {
        if (err) {
          reject(openError(o.path, err));
          return;
        }
        let dataCb: ((c: Uint8Array) => void) | undefined;
        let closeCb: ((err?: Error) => void) | undefined;
        let lastError: Error | undefined;
        let ended = false;
        let notified = false;
        const backlog: Uint8Array[] = [];
        const notify = (): void => {
          if (notified || !closeCb || !ended || backlog.length > 0) return;
          notified = true;
          closeCb(lastError);
        };
        port.on('data', (b: Buffer) => {
          const chunk = new Uint8Array(b.buffer, b.byteOffset, b.length).slice();
          if (dataCb) dataCb(chunk);
          else backlog.push(chunk);
        });
        port.on('error', (e: Error) => {
          lastError = new S7Error('CLOSED', `porta ${o.path} persa (${e.message})`);
        });
        // `close` con errore: adattatore USB staccato; senza errore: chiusura nostra.
        port.on('close', (e?: Error) => {
          if (e) lastError = new S7Error('CLOSED', `porta ${o.path} persa (${e.message})`);
          ended = true;
          notify();
        });
        resolve({
          send: (bytes) => {
            if (!port.isOpen) throw new S7Error('CLOSED', `porta ${o.path} chiusa`);
            port.write(bytes);
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
            if (port.isOpen) port.close();
          },
        });
      });
    });
}

function openError(path: string, err: Error): S7Error {
  if (/EBUSY|Access denied|EACCES/i.test(err.message)) {
    return new S7Error('SERIAL_BUSY', `La porta ${path} è usata da un altro programma`);
  }
  return new S7Error('SERIAL_OPEN', `porta ${path} non apribile (${err.message})`);
}

export async function listSerialPorts(): Promise<SerialPortEntry[]> {
  const list = await SerialPort.list();
  return list.map(({ path, manufacturer, vendorId, productId }) => ({
    path,
    manufacturer,
    vendorId,
    productId,
  }));
}
