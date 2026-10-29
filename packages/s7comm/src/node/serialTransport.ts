import type { SerialPort as SerialPortClass } from 'serialport';
import { S7Error } from '../errors';
import type { PduLinkFactory } from '../link';
import { listMpiNodes, mpiAdapterLink, type MpiOptions, type SerialOpener } from '../mpi/adapter';
import type { Transport } from '../transport';

export interface SerialSettings {
  path: string;
  baudRate: number;
  parity: 'odd' | 'even' | 'none';
}

export interface SerialPortEntry {
  path: string;
  manufacturer?: string;
  vendorId?: string;
  productId?: string;
}

/**
 * Porte aperte da questo processo, per nome: si libera all'evento `close` della porta. Una seconda
 * apertura della stessa porta aspetta la prima (al più `timeoutMs`), poi SERIAL_BUSY: due sessioni
 * dell'adattatore sulla stessa linea si rovinerebbero a vicenda.
 */
const held = new Map<string, Promise<void>>();

async function lease(path: string, timeoutMs: number): Promise<() => void> {
  const key = path.trim().toLowerCase();
  const deadline = Date.now() + timeoutMs;
  for (let prev = held.get(key); prev; prev = held.get(key)) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((r) => {
      timer = setTimeout(() => r('late'), Math.max(0, deadline - Date.now()));
    });
    const r = await Promise.race([prev.then(() => 'free' as const), late]);
    clearTimeout(timer);
    if (r === 'late') {
      throw new S7Error(
        'SERIAL_BUSY',
        `La porta ${path} è già usata da un altro collegamento di BaaPortal`,
      );
    }
  }
  let release!: () => void;
  const mine: Promise<void> = new Promise<void>((r) => (release = r)).then(() => {
    if (held.get(key) === mine) held.delete(key);
  });
  held.set(key, mine);
  return release;
}

/** `serialport` si carica al primo uso: se il modulo nativo manca, l'app parte lo stesso e fallisce solo l'MPI. */
async function serialPortClass(): Promise<typeof SerialPortClass> {
  try {
    return (await import('serialport')).SerialPort;
  } catch (e) {
    throw new S7Error(
      'SERIAL_OPEN',
      `porta seriale non disponibile su questo computer (${e instanceof Error ? e.message : String(e)})`,
    );
  }
}

/**
 * Trasporto su porta seriale (adattatore MPI/USB), 8 bit di dati e 1 di stop. Carica `serialport`
 * solo nel main. Interno a questa cartella: fuori si usano `mpiSerialLink` e `listMpiNodesSerial`.
 * `close()` si risolve a porta chiusa davvero.
 */
export function openSerial(o: SerialSettings): SerialOpener {
  return async (timeoutMs = 5000) => {
    const SerialPort = await serialPortClass();
    const release = await lease(o.path, timeoutMs);
    return new Promise<Transport>((resolve, reject) => {
      const port = new SerialPort({
        path: o.path,
        baudRate: o.baudRate,
        parity: o.parity,
        dataBits: 8,
        stopBits: 1,
        autoOpen: false,
      });
      const closed = new Promise<void>((r) => port.once('close', () => r()));
      void closed.then(release);
      port.open((err) => {
        if (err) {
          release();
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
            return closed;
          },
        });
      });
    });
  };
}

/** Link verso la CPU attraverso l'adattatore MPI sulla porta seriale, per `S7Connection.open({ link })`. */
export function mpiSerialLink(serial: SerialSettings, o: MpiOptions): PduLinkFactory {
  return mpiAdapterLink(openSerial(serial), o);
}

/** Nodi attivi del bus MPI attraverso l'adattatore sulla porta seriale («Cerca»). */
export function listMpiNodesSerial(
  serial: SerialSettings,
  o: Parameters<typeof listMpiNodes>[1],
): Promise<number[]> {
  return listMpiNodes(openSerial(serial), o);
}

function openError(path: string, err: Error): S7Error {
  if (/EBUSY|Access denied|EACCES|Cannot lock port/i.test(err.message)) {
    return new S7Error('SERIAL_BUSY', `La porta ${path} è usata da un altro programma`);
  }
  return new S7Error('SERIAL_OPEN', `porta ${path} non apribile (${err.message})`);
}

export async function listSerialPorts(): Promise<SerialPortEntry[]> {
  const list = await (await serialPortClass()).list();
  return list.map(({ path, manufacturer, vendorId, productId }) => ({
    path,
    manufacturer,
    vendorId,
    productId,
  }));
}
