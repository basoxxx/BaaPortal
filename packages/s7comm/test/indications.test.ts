import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  S7Connection,
  fromHex,
  memoryTransportPair,
  reqEnableJob,
  reqReadJobList,
  type ConnectionMode,
  type Transport,
} from '../src';
import { FakeCpu, type FakeCpuOptions } from './fakeCpu';

afterEach(() => {
  vi.useRealTimers();
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

function rig(opts: FakeCpuOptions = {}): { client: Transport; cpu: FakeCpu } {
  const [client, server] = memoryTransportPair();
  return { client, cpu: new FakeCpu(server, opts) };
}

const open = (client: Transport, mode: ConnectionMode): Promise<S7Connection> =>
  S7Connection.open({ host: 'h', transport: async () => client, mode });

/** Indication `00 01 12 08 12 01 SS NN 00 00 0000` con dati TIS di 2 byte. */
function indicate(cpu: FakeCpu, sub: number, seq: number, ref = 0x7777): void {
  cpu.sendPdu({
    rosctr: 7,
    pduRef: ref,
    errorClass: 0,
    errorCode: 0,
    param: Uint8Array.of(0, 1, 0x12, 8, 0x12, 0x01, sub, seq, 0, 0, 0, 0),
    data: fromHex('ff09 000a 0004 0002 01000001 abcd'),
  });
}

describe('indication in modo online-test', () => {
  it('arrivata prima della richiesta di attesa → consegnata da nextIndication', async () => {
    const { client, cpu } = rig();
    const conn = await open(client, 'online-test');
    indicate(cpu, 0x13, 3);
    await flush();
    const d = await conn.nextIndication({ group: 1, sub: 0x13, seq: 3 }, 1000);
    expect(d?.param).toMatchObject({ group: 1, subfunction: 0x13, sequence: 3, type: 0 });
  });

  it("arrivata dopo → risolve l'attesa", async () => {
    const { client, cpu } = rig();
    const conn = await open(client, 'online-test');
    const p = conn.nextIndication({ group: 1, sub: 0x13, seq: 3 }, 1000);
    indicate(cpu, 0x13, 3);
    await expect(p).resolves.toMatchObject({ param: { sequence: 3 } });
  });

  it('non risolve la richiesta in corso, anche con lo stesso pduRef', async () => {
    const { client, cpu } = rig({
      onPdu: (pdu, c) => {
        indicate(c, 0x10, 1, pdu.pduRef);
        c.sendPdu({
          rosctr: 7,
          pduRef: pdu.pduRef,
          errorClass: 0,
          errorCode: 0,
          param: Uint8Array.of(0, 1, 0x12, 8, 0x12, 0x81, 0x10, 1, 0, 0, 0, 0),
          data: fromHex('0a000000'),
        });
      },
    });
    const conn = await open(client, 'online-test');
    const f = reqReadJobList();
    const res = await conn.request(f.param, f.data, 7);
    expect(res.param[5]).toBe(0x81);
    void cpu;
  });

  it('9 indication non chieste → la più vecchia scartata, ignoredCount + 1', async () => {
    const { client, cpu } = rig();
    const conn = await open(client, 'online-test');
    for (let i = 1; i <= 9; i++) indicate(cpu, 0x13, i);
    await flush();
    expect(conn.ignoredCount).toBe(1);
    vi.useFakeTimers();
    const old = conn.nextIndication({ group: 1, sub: 0x13, seq: 1 }, 100);
    await vi.advanceTimersByTimeAsync(150);
    await expect(old).resolves.toBeUndefined();
    await expect(conn.nextIndication({ group: 1, sub: 0x13, seq: 9 }, 100)).resolves.toBeDefined();
  });

  it('nextIndication senza risultato in 2 s → undefined, connessione aperta', async () => {
    const { client } = rig();
    const conn = await open(client, 'online-test');
    vi.useFakeTimers();
    const p = conn.nextIndication({ group: 1, sub: 0x13, seq: 3 }, 2000);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toBeUndefined();
    expect(conn.closed).toBe(false);
  });

  it('una indication dopo discardIndications si scarta; reviveIndications la riammette', async () => {
    const { client, cpu } = rig();
    const conn = await open(client, 'online-test');
    indicate(cpu, 0x13, 3);
    await flush();
    conn.discardIndications(1, 0x13, 3);
    indicate(cpu, 0x13, 3);
    await flush();
    expect(conn.ignoredCount).toBe(1);
    vi.useFakeTimers();
    const p = conn.nextIndication({ group: 1, sub: 0x13, seq: 3 }, 100);
    await vi.advanceTimersByTimeAsync(150);
    await expect(p).resolves.toBeUndefined();
    conn.reviveIndications(1, 0x13, 3);
    vi.useRealTimers();
    indicate(cpu, 0x13, 3);
    await flush();
    await expect(conn.nextIndication({ group: 1, sub: 0x13, seq: 3 }, 100)).resolves.toBeDefined();
  });

  it("discardIndications chiude l'attesa del job cancellato: il job con lo stesso numero non viene scavalcato", async () => {
    const { client, cpu } = rig();
    const conn = await open(client, 'online-test');
    const vecchia = conn.nextIndication({ group: 1, sub: 0x13, seq: 3 }, 60_000);
    conn.discardIndications(1, 0x13, 3);
    await expect(vecchia).resolves.toBeUndefined();
    conn.reviveIndications(1, 0x13, 3);
    const nuova = conn.nextIndication({ group: 1, sub: 0x13, seq: 3 }, 60_000);
    indicate(cpu, 0x13, 3);
    await expect(nuova).resolves.toMatchObject({ param: { sequence: 3 } });
  });

  it("chiusura della connessione → l'attesa è rifiutata", async () => {
    const { client } = rig();
    const conn = await open(client, 'online-test');
    const p = conn.nextIndication({ group: 1, sub: 0x13, seq: 3 }, 5000);
    await conn.close();
    await expect(p).rejects.toMatchObject({ code: 'CLOSED' });
  });

  it('AbortSignal → ABORTED', async () => {
    const { client } = rig();
    const conn = await open(client, 'online-test');
    const ac = new AbortController();
    const p = conn.nextIndication({ group: 1, sub: 0x13, seq: 3 }, 5000, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'ABORTED' });
    expect(conn.closed).toBe(false);
  });

  it("il filtro dell'invio usa la PDU negoziata e rifiuta un enable non canonico", async () => {
    const { client } = rig();
    const conn = await open(client, 'online-test');
    const ok = reqEnableJob(0x13, 3);
    await expect(conn.request(ok.param, ok.data, 7, 50)).rejects.toMatchObject({ code: 'TIMEOUT' });
    const c2 = await open(rig().client, 'online-test');
    const bad = reqEnableJob(0x02, 3);
    await expect(c2.request(bad.param, bad.data, 7)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(c2.refusedCount).toBe(1);
  });
});

describe('indication negli altri modi', () => {
  for (const mode of ['read-only', 'online-write'] as const) {
    it(`${mode}: scartata, nessuna richiesta risolta`, async () => {
      const { client, cpu } = rig();
      const conn = await open(client, mode);
      indicate(cpu, 0x13, 3);
      await flush();
      expect(conn.ignoredCount).toBe(1);
      await expect(
        conn.nextIndication({ group: 1, sub: 0x13, seq: 3 }, 100),
      ).rejects.toBeInstanceOf(RangeError);
    });
  }

  it('online-restore si apre (filtro provvisorio)', async () => {
    const { client } = rig();
    const conn = await open(client, 'online-restore');
    expect(conn.closed).toBe(false);
  });
});
