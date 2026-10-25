import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  S7Connection,
  assertOnlineWrite,
  assertOutgoingFrame,
  decodeDownloadBlockAck,
  decodeRequestDownload,
  encodeCotp,
  encodeDownloadBlockAck,
  encodeDownloadBlockJob,
  encodeDownloadEnded,
  encodeCompressMemory,
  encodeCopyRamToRom,
  encodeDeleteBlock,
  encodeInsertBlock,
  encodePlcStop,
  encodeRequestDownload,
  encodeS7,
  encodeTpkt,
  encodeWarmRestart,
  encodeWriteRequest,
  memoryTransportPair,
  type S7Pdu,
  type Transport,
} from '../src';
import { FakeCpu } from './fakeCpu';

afterEach(() => {
  vi.useRealTimers();
});

const none = new Uint8Array(0);
const hexb = (s: string): Uint8Array =>
  Uint8Array.from(
    s
      .replace(/\s+/g, '')
      .match(/../g)!
      .map((x) => parseInt(x, 16)),
  );

const job = (param: Uint8Array, data: Uint8Array = none, rosctr: 1 | 2 | 3 | 7 = 1): S7Pdu => ({
  rosctr,
  pduRef: 7,
  errorClass: 0,
  errorCode: 0,
  param,
  data,
});

const dt = (s7: Uint8Array): Uint8Array =>
  encodeTpkt(encodeCotp({ type: 'DT', eot: true, data: s7 }));

const writeReq = encodeWriteRequest([
  { area: 'M', db: 0, start: 0, size: 'BYTE', count: 1, data: Uint8Array.of(0xaa) },
]);
const writePdu = job(writeReq.param, writeReq.data);

describe('assertOnlineWrite', () => {
  it('assertOnlineWrite: 0x05, 0x1A, 0x1C, 0x29, warm restart, _INSE, _DELE, _MODU e _GARB passano (solo canonici); cold/MRES/force → FORBIDDEN', () => {
    const ok: S7Pdu[] = [
      writePdu,
      job(encodeRequestDownload('DB', 1, 'P', 100086, 2)),
      job(encodeDownloadEnded('DB', 1, 'P')),
      job(encodePlcStop()),
      job(encodeWarmRestart()),
      job(encodeInsertBlock('DB', 1, 'P')),
      job(encodeDeleteBlock('OB', 1, 'P')),
      job(encodeCopyRamToRom()),
      job(encodeCompressMemory()),
      // ack-data 0x1B e 0x1C
      job(
        encodeDownloadBlockAck(true, Uint8Array.of(1, 2, 3)).param,
        encodeDownloadBlockAck(true, Uint8Array.of(1, 2, 3)).data,
        3,
      ),
      job(Uint8Array.of(0x1c), none, 3),
    ];
    for (const p of ok) expect(() => assertOnlineWrite(p)).not.toThrow();

    const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
    const ctl = (args: number[], svc: string): Uint8Array =>
      Uint8Array.from([
        0x28,
        0,
        0,
        0,
        0,
        0,
        0,
        0xfd,
        0,
        args.length,
        ...args,
        svc.length,
        ...ascii(svc),
      ]);
    const bad: S7Pdu[] = [
      job(ctl([1, 0, ...ascii('0A00001P')], '_GARB')), // _GARB con argomenti
      job(ctl([1, 0, ...ascii('0A00001P')], '_MODU')), // _MODU con argomenti
      job(ctl(ascii('EQ'), '_MODU')),
      job(ctl([1, 0, ...ascii('0800001B')], '_DELE')), // _DELE su filesystem B
      job(ctl([1, 0, ...ascii('0800001A')], '_DELE')),
      job(ctl([2, 0, ...ascii('0800001P')], '_DELE')), // conteggio diverso da 1
      job(Uint8Array.from([...encodeCompressMemory(), 0])),
      job(Uint8Array.from([...encodeCopyRamToRom(), 0])),
      job(encodeDeleteBlock('OB', 1, 'P'), Uint8Array.of(1)), // dati in più
      job(ctl(ascii('C '), 'P_PROGRAM')), // cold restart
      job(ctl(ascii('H '), 'P_PROGRAM')), // hot restart
      job(ctl([], '_MRES')),
      job(hexb('1b 00 00 00 00 00 00 00 09 5f 30 41 30 30 30 30 31 50')), // job 0x1B dal client
      job(hexb('77 00 00 00')), // funzione sconosciuta
      job(hexb('2a 00 00 00')),
      job(hexb('00 00')),
      job(Uint8Array.of(0x1c, 0), none, 3), // ack 0x1C non canonica
      job(Uint8Array.of(0xf1, 0), none, 3), // ack di altra funzione
      job(encodePlcStop(), Uint8Array.of(1)), // dati in più
      job(writeReq.param, Uint8Array.from([...writeReq.data, 0])), // write non canonico
      job(Uint8Array.from([...encodeWarmRestart(), 0])),
      job(Uint8Array.from([...encodeRequestDownload('DB', 1, 'P', 1, 1), 0])),
      job(encodeInsertBlock('DB', 1, 'P').map((b, i) => (i === 3 ? 0x01 : b))),
      job(new Uint8Array(0)),
    ];
    for (const p of bad) {
      expect(() => assertOnlineWrite(p)).toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN' }),
      );
    }
  });

  it('assertOutgoingFrame(mode="online-write") accetta un DT con write var; mode default la rifiuta', () => {
    const frame = dt(encodeS7(writePdu));
    expect(() => assertOutgoingFrame(frame, 'online-write')).not.toThrow();
    expect(() => assertOutgoingFrame(frame)).toThrowError(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
    expect(() => assertOutgoingFrame(frame, 'read-only')).toThrowError(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
    // un DT non canonico resta vietato anche in online-write
    expect(() =>
      assertOutgoingFrame(
        dt(encodeS7(job(encodeInsertBlock('DB', 1, 'P').slice(0, 5)))),
        'online-write',
      ),
    ).toThrow();
  });
});

async function open(
  mode: 'read-only' | 'online-write' | undefined,
  onPdu?: (p: S7Pdu, cpu: FakeCpu) => void,
): Promise<{ conn: S7Connection; sends: Uint8Array[]; cpu: FakeCpu }> {
  const [a, b] = memoryTransportPair();
  const sends: Uint8Array[] = [];
  const spy: Transport = {
    send: (x) => {
      sends.push(x.slice());
      a.send(x);
    },
    onData: (cb) => a.onData(cb),
    onClose: (cb) => a.onClose(cb),
    close: () => a.close(),
  };
  const cpu = new FakeCpu(b, { pdu: 480, ...(onPdu ? { onPdu } : {}) });
  const conn = await S7Connection.open({
    host: 'x',
    transport: async () => spy,
    ...(mode ? { mode } : {}),
  });
  return { conn, sends, cpu };
}

describe('modo della connessione', () => {
  it('su una connessione read-only una write var non arriva mai al trasporto (spia su send)', async () => {
    for (const mode of [undefined, 'read-only'] as const) {
      const { conn, sends } = await open(mode);
      const before = sends.length;
      await expect(conn.request(writeReq.param, writeReq.data, 1)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(
        conn.runDownload(
          encodeRequestDownload('DB', 1, 'P', 1, 1),
          () => ({ eos: false, chunk: none }),
          () => undefined,
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(conn.request(Uint8Array.of(0x1c), none, 3)).rejects.toBeInstanceOf(RangeError);
      expect(sends.length).toBe(before);
      expect(conn.refusedCount).toBe(1);
      expect(conn.closed).toBe(false);
    }
  });

  it('online-write: una write var arriva al trasporto; un _DELE non canonico resta vietato', async () => {
    const { conn, sends } = await open('online-write', (p, cpu) => {
      cpu.ack(p.pduRef, Uint8Array.of(0x05, 1), Uint8Array.of(0xff));
    });
    const before = sends.length;
    const res = await conn.request(writeReq.param, writeReq.data, 1);
    expect(res.data).toEqual(Uint8Array.of(0xff));
    expect(sends.length).toBe(before + 1);
    const dele = Uint8Array.from([
      0x28,
      0,
      0,
      0,
      0,
      0,
      0,
      0xfd,
      0,
      10,
      1,
      0,
      ...[...'0A00001B'].map((c) => c.charCodeAt(0)),
      5,
      ...[...'_DELE'].map((c) => c.charCodeAt(0)),
    ]);
    await expect(conn.request(dele, none, 1)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(sends.length).toBe(before + 1);
  });
});

/** Finto PLC del download: dopo l'ack 0x1A manda `n` job 0x1B e poi il job `last`. */
function downloadCpu(n: number, last: Uint8Array): (p: S7Pdu, cpu: FakeCpu) => void {
  let sent = 0;
  const next = (cpu: FakeCpu): void => {
    if (sent < n) {
      sent++;
      cpu.sendPdu(job(encodeDownloadBlockJob('DB', 1, 'P'), none, 1));
    } else {
      sent++;
      cpu.sendPdu({ ...job(last), pduRef: 900 });
    }
  };
  return (p, cpu) => {
    if (p.rosctr === 1 && p.param[0] === 0x1a) {
      cpu.ack(p.pduRef, Uint8Array.of(0x1a));
      next(cpu);
    } else if (p.rosctr === 3 && sent <= n) {
      next(cpu);
    }
  };
}

describe('runDownload', () => {
  it('runDownload su memoryTransportPair con un server di prova: 0x1A, tre ack-data 0x1B, 0x1C', async () => {
    const { conn, cpu } = await open(
      'online-write',
      downloadCpu(3, encodeDownloadEnded('DB', 1, 'P')),
    );
    const chunks = [Uint8Array.of(1, 2), Uint8Array.of(3), Uint8Array.of(4, 5, 6)];
    let i = 0;
    const ended: unknown[] = [];
    await conn.runDownload(
      encodeRequestDownload('DB', 1, 'P', 100, 10),
      (j) => {
        expect(j).toEqual({ type: 'DB', number: 1 });
        const chunk = chunks[i]!;
        i++;
        return { eos: i < chunks.length, chunk };
      },
      (j) => ended.push(j),
    );
    expect(ended).toEqual([{ type: 'DB', number: 1 }]);
    const jobs = cpu.pdus.filter((p) => p.rosctr === 1 && p.param[0] === 0x1a);
    expect(decodeRequestDownload(jobs[0]!.param)).toMatchObject({ number: 1, loadLength: 100 });
    const acks = cpu.pdus.filter((p) => p.rosctr === 3);
    expect(acks).toHaveLength(4);
    expect(acks.slice(0, 3).map((a) => decodeDownloadBlockAck(a.param, a.data))).toEqual([
      { eos: true, chunk: chunks[0] },
      { eos: true, chunk: chunks[1] },
      { eos: false, chunk: chunks[2] },
    ]);
    expect(acks[3]!.param).toEqual(Uint8Array.of(0x1c));
    expect(conn.closed).toBe(false);
    // fuori dal download la connessione torna a rifiutare i job della CPU
    cpu.sendPdu(job(encodeDownloadBlockJob('DB', 1, 'P')));
    await vi.waitFor(() => expect(conn.closed).toBe(true));
  });

  it('runDownload: job non-0x1B a metà → PROTOCOL e nessuna promessa appesa', async () => {
    const { conn } = await open('online-write', downloadCpu(1, hexb('77 00 00 00')));
    const settled = vi.fn();
    const p = conn.runDownload(
      encodeRequestDownload('DB', 1, 'P', 100, 10),
      () => ({ eos: true, chunk: Uint8Array.of(1) }),
      () => undefined,
    );
    p.then(settled, settled);
    await expect(p).rejects.toMatchObject({ code: 'PROTOCOL' });
    expect(conn.closed).toBe(true);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("runDownload: nessun job dopo l'ack → TIMEOUT e promessa rifiutata", async () => {
    const { conn } = await open('online-write', (p, cpu) => {
      if (p.param[0] === 0x1a) cpu.ack(p.pduRef, Uint8Array.of(0x1a));
    });
    await expect(
      conn.runDownload(
        encodeRequestDownload('DB', 1, 'P', 1, 1),
        () => ({ eos: false, chunk: none }),
        () => undefined,
        30,
      ),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(conn.closed).toBe(true);
  });

  it('runDownload: header error del request 0x1A → CPU_ERROR', async () => {
    const { conn } = await open('online-write', (p, cpu) => {
      cpu.sendPdu({
        ...p,
        rosctr: 2,
        errorClass: 0xd2,
        errorCode: 0x41,
        param: Uint8Array.of(0x1a),
        data: none,
      });
    });
    await expect(
      conn.runDownload(
        encodeRequestDownload('DB', 1, 'P', 1, 1),
        () => ({ eos: false, chunk: none }),
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: 'CPU_ERROR' });
  });

  it('fuori da runDownload un job ROSCTR 1 chiude ancora la connessione con PROTOCOL', async () => {
    for (const mode of ['read-only', 'online-write'] as const) {
      const { conn, cpu } = await open(mode);
      cpu.sendPdu(job(encodeDownloadBlockJob('DB', 1, 'P')));
      await vi.waitFor(() => expect(conn.closed).toBe(true));
      await expect(conn.request(none, none, 1)).rejects.toMatchObject({ code: 'CLOSED' });
    }
  });
});
