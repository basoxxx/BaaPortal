import { describe, expect, it, vi } from 'vitest';
import { FakeCpu, serve } from '@baaportal/s7-server';
import {
  S7Client,
  S7Connection,
  S7Error,
  S7WriteClient,
  buildBlockFile,
  decodeCotp,
  decodeS7,
  encodeCotp,
  encodeS7,
  encodeTpkt,
  fromHex,
  hex,
  memoryTransportPair,
  type Transport,
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

/**
 * Il finto PLC non sa rispondere a `_INSE` con un codice di parametro diverso da 0: lo si forza
 * qui sul filo, riscrivendo l'ack-data 20 byte con param `28` in `28 <code>` (TPKT 20 -> 21,
 * lunghezza param 1 -> 2). L'header resta senza errore, come su una CPU che rifiuta nel param.
 */
function insParamCodeRig(cpu: FakeCpu, code: number): Promise<S7WriteClient> {
  const transport: TransportFactory = async () => {
    const [a, b] = memoryTransportPair();
    serve(cpu, b);
    const wrapped: Transport = {
      send: (bytes) => a.send(bytes),
      close: () => a.close(),
      onClose: (cb) => a.onClose(cb),
      onData: (cb) =>
        a.onData((chunk) => {
          const isInse =
            chunk.length === 20 && chunk[0] === 3 && chunk[8] === 3 && chunk[19] === 0x28;
          if (!isInse) return cb(chunk);
          const out = new Uint8Array(21);
          out.set(chunk);
          out[3] = 21;
          out[14] = 2;
          out[20] = code;
          cb(out);
        }),
    };
    return wrapped;
  };
  return S7WriteClient.connect({ host: 'finto', transport, timeoutMs: 3000 });
}

describe('S7WriteClient contro il finto PLC', () => {
  it('downloadBlock: un codice di param diverso da ok in risposta a _INSE lancia CPU_ERROR', async () => {
    const c = await insParamCodeRig(new FakeCpu(), 0x02);
    const e: unknown = await c
      .downloadBlock(
        blockFile(
          7,
          Uint8Array.from({ length: 40 }, (_, i) => i),
        ),
      )
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(S7Error);
    expect(e).toMatchObject({ code: 'CPU_ERROR', detail: { returnCode: 0x02 } });
    await c.close();
  });

  it('plain S7Client apre sempre la connessione read-only, anche con mode online-write', async () => {
    const open = vi.spyOn(S7Connection, 'open');
    try {
      const transport: TransportFactory = async () => {
        const [a, b] = memoryTransportPair();
        serve(new FakeCpu(), b);
        return a;
      };
      const c = await S7Client.connect({ host: 'finto', transport, mode: 'online-write' });
      expect(open).toHaveBeenCalledTimes(1);
      expect(open.mock.calls[0]![0].mode).toBe('read-only');
      await c.close();
      // S7WriteClient (sottoclasse) apre invece online-write
      const w = await rig(new FakeCpu());
      expect(open.mock.calls[1]![0].mode).toBe('online-write');
      await w.close();
    } finally {
      open.mockRestore();
    }
  });

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

/** Risponde al set clock con i byte di una CPU reale (proto §12.0), con `code` nel parametro. */
function setClockRig(code: number, seen: string[]): Promise<S7WriteClient> {
  const transport: TransportFactory = async () => {
    const [a, b] = memoryTransportPair();
    serve(new FakeCpu(), b);
    let reply: ((c: Uint8Array) => void) | undefined;
    return {
      send: (bytes) => {
        const cotp = decodeCotp(bytes.subarray(4));
        const pdu = cotp.type === 'DT' ? decodeS7(cotp.data) : undefined;
        if (pdu?.rosctr === 7 && pdu.param[5] === 0x47 && pdu.param[6] === 0x02) {
          seen.push(hex(pdu.param) + ' ' + hex(pdu.data));
          const param = fromHex('000112081287020000000000');
          param[10] = code >> 8;
          param[11] = code & 0xff;
          const res = encodeS7({
            rosctr: 7,
            pduRef: pdu.pduRef,
            errorClass: 0,
            errorCode: 0,
            param,
            data: fromHex('0a000000'),
          });
          reply?.(encodeTpkt(encodeCotp({ type: 'DT', eot: true, data: res })));
          return;
        }
        a.send(bytes);
      },
      close: () => a.close(),
      onClose: (cb) => a.onClose(cb),
      onData: (cb) => {
        reply = cb;
        a.onData(cb);
      },
    } satisfies Transport;
  };
  return S7WriteClient.connect({ host: 'finto', transport, timeoutMs: 3000 });
}

describe('S7WriteClient.setClock', () => {
  const T = { year: 2020, month: 5, day: 17, hour: 10, minute: 20, second: 30, ms: 0 };

  it('anno 2090: RangeError senza invio', async () => {
    const seen: string[] = [];
    const c = await setClockRig(0, seen);
    await expect(c.setClock({ ...T, year: 2090 })).rejects.toBeInstanceOf(RangeError);
    expect(seen).toEqual([]);
  });

  it('manda 7/2 canonico e accetta la risposta senza dati utili; un error code diverso da 0 è CPU_ERROR', async () => {
    const seen: string[] = [];
    await (await setClockRig(0, seen)).setClock(T);
    expect(seen).toEqual(['0001120411470200 ff09000a00192005171020300000']);
    const e: unknown = await (await setClockRig(0xd241, [])).setClock(T).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'CPU_ERROR', detail: { errorClass: 0xd2, errorCode: 0x41 } });
    expect((e as Error).message).toContain('set clock');
  });
});
