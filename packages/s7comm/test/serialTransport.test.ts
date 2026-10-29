import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  opts: undefined as Record<string, unknown> | undefined,
  openErr: undefined as Error | undefined,
  inst: undefined as unknown as EventEmitter & { isOpen: boolean; written: Uint8Array[] },
}));

vi.mock('serialport', async () => {
  const { EventEmitter: EE } = await import('node:events');
  class FakePort extends EE {
    isOpen = false;
    written: Uint8Array[] = [];
    constructor(opts: Record<string, unknown>) {
      super();
      h.opts = opts;
      h.inst = this;
    }
    open(cb: (e: Error | null) => void) {
      if (h.openErr) cb(h.openErr);
      else {
        this.isOpen = true;
        cb(null);
      }
    }
    write(b: Uint8Array) {
      this.written.push(b);
    }
    close() {
      // come la porta vera: l'evento arriva dopo, a porta chiusa davvero
      setTimeout(() => {
        this.isOpen = false;
        this.emit('close');
      }, 5);
    }
    static list = async () => [{ path: 'COM3', manufacturer: 'FTDI', extra: 1 }];
  }
  return { SerialPort: FakePort };
});

import { listSerialPorts, openSerial } from '../src/node/serialTransport';

const open = () => openSerial({ path: 'COM3', baudRate: 38400, parity: 'odd' })();

beforeEach(() => {
  h.openErr = undefined;
});

describe('openSerial', () => {
  it('apre a 38400 baud, parità dispari, 8N1 e passa i dati', async () => {
    const t = await open();
    expect(h.opts).toMatchObject({
      path: 'COM3',
      baudRate: 38400,
      parity: 'odd',
      dataBits: 8,
      stopBits: 1,
    });
    const got: number[][] = [];
    h.inst.emit('data', Buffer.from([1, 2])); // prima del callback: in coda
    t.onData((c) => got.push([...c]));
    h.inst.emit('data', Buffer.from([3]));
    expect(got).toEqual([[1, 2], [3]]);
    t.send(new Uint8Array([9]));
    expect(h.inst.written).toHaveLength(1);
    await t.close();
  });

  it('porta occupata: SERIAL_BUSY con il percorso reale', async () => {
    h.openErr = new Error('Opening COM7: Access denied');
    await expect(
      openSerial({ path: 'COM7', baudRate: 38400, parity: 'odd' })(),
    ).rejects.toMatchObject({
      code: 'SERIAL_BUSY',
      message: 'La porta COM7 è usata da un altro programma',
    });
  });

  it('porta bloccata (macOS «Cannot lock port»): SERIAL_BUSY', async () => {
    h.openErr = new Error('Error Resource temporarily unavailable Cannot lock port');
    await expect(open()).rejects.toMatchObject({ code: 'SERIAL_BUSY' });
  });

  it('stessa porta aperta due volte: la seconda aspetta la chiusura della prima', async () => {
    const t = await open();
    const first = h.inst;
    let second = false;
    const next = open().then((x) => ((second = true), x));
    await new Promise((r) => setTimeout(r, 20));
    expect(second).toBe(false);
    await t.close();
    expect(first.isOpen).toBe(false);
    const t2 = await next;
    expect(h.inst).not.toBe(first);
    await t2.close();
  });

  it('stessa porta ancora occupata oltre il tempo: SERIAL_BUSY, senza aprirla', async () => {
    const t = await open();
    const first = h.inst;
    await expect(
      openSerial({ path: 'com3 ', baudRate: 38400, parity: 'odd' })(30),
    ).rejects.toMatchObject({ code: 'SERIAL_BUSY', message: expect.stringContaining('BaaPortal') });
    expect(h.inst).toBe(first);
    await t.close();
  });

  it('altro errore di apertura: SERIAL_OPEN', async () => {
    h.openErr = new Error('File not found');
    await expect(open()).rejects.toMatchObject({ code: 'SERIAL_OPEN' });
  });

  it('adattatore staccato: onClose con errore', async () => {
    const t = await open();
    const cb = vi.fn();
    t.onClose(cb);
    h.inst.emit('close', Object.assign(new Error('device disconnected'), { disconnected: true }));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]![0]).toBeInstanceOf(Error);
  });

  it('close libera la porta, senza errore', async () => {
    const t = await open();
    const cb = vi.fn();
    t.onClose(cb);
    await t.close();
    expect(h.inst.isOpen).toBe(false);
    expect(cb).toHaveBeenCalledWith(undefined);
    expect(() => t.send(new Uint8Array([1]))).toThrow();
  });
});

describe('listSerialPorts', () => {
  it('restituisce solo i campi noti', async () => {
    expect(await listSerialPorts()).toEqual([
      { path: 'COM3', manufacturer: 'FTDI', vendorId: undefined, productId: undefined },
    ]);
  });
});
