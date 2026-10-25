import { describe, expect, it } from 'vitest';
import {
  S7TestClient,
  blockStatusResultSize,
  decodeBStack,
  decodeBlockStatusResult,
  decodeIStack,
  decodeLStack,
  decodeTisReply,
  ledsFrom,
  memoryTransportPair,
  reqBlockStatus,
  reqEnableJob,
  type BlockStatusRequest,
  type TransportFactory,
} from '@baaportal/s7comm';
import { FakeCpu, serve, type FakeCpuOptions } from '../src';
import { TestPeer, blockFile, seq, settle, sleep } from './helpers';

const R: BlockStatusRequest = {
  type: 'OB',
  number: 1,
  initMask: 0x03,
  lines: [0, 2, 4].map((offset) => ({ offset, mask: 0x03 })),
};
const SAZ = 0x10;

function world(o: FakeCpuOptions = {}): FakeCpu {
  const cpu = new FakeCpu(o);
  cpu.addBlock(blockFile('OB', 1, seq(50, 2)));
  cpu.addBlock(blockFile('FC', 10, seq(20, 3)));
  return cpu;
}

async function connect(cpu: FakeCpu): Promise<S7TestClient> {
  const transport: TransportFactory = async () => {
    const [a, b] = memoryTransportPair();
    serve(cpu, b);
    return a;
  };
  return S7TestClient.connect({ host: 'finto', transport, timeoutMs: 2000 });
}

const cpuError = (cls: number, code: number): object => ({
  code: 'CPU_ERROR',
  detail: { errorClass: cls, errorCode: code },
});

describe('TIS: SZL 0x0131 indice 2', () => {
  it('be fd 4f, 7d 00, force 10; con tisV2 false be fd 03', async () => {
    const c = await connect(world());
    const rec = (await c.readSzl(0x0131, 2)).records[0]!;
    expect([...rec.slice(2, 5)]).toEqual([0xbe, 0xfd, 0x4f]);
    expect([...rec.slice(20, 22)]).toEqual([0x7d, 0x00]);
    expect((rec[32]! << 8) | rec[33]!).toBe(10);
    expect((await c.tisFunctions()).blockStatusV2).toBe(true);
    await c.close();
    const old = await connect(world({ tisV2: false }));
    expect([...(await old.readSzl(0x0131, 2)).records[0]!.slice(2, 5)]).toEqual([0xbe, 0xfd, 0x03]);
    expect((await old.tisFunctions()).blockStatusV2).toBe(false);
    await old.close();
  });
});

describe('TIS: block status del finto PLC', () => {
  it('create + enable su OB1: ack con il numero del job, poi indication con la dimensione di p4', async () => {
    const c = await connect(world());
    const job = await c.createBlockStatus(R, SAZ);
    const res = await c.enableAndWait(0x13, job, 1000);
    if (!('result' in res)) throw new Error('nessun risultato');
    expect(res.result.length).toBe(blockStatusResultSize(R));
    const dec = decodeBlockStatusResult(res.result, R);
    if (!dec.ok) throw new Error(dec.why);
    expect(dec.lines.map((l) => l?.accu1)).toEqual([0, 2, 4]);
    await c.close();
  });

  it('numero del job = contatore della CPU, che cresce a ogni richiesta TIS', async () => {
    const c = await connect(world());
    const a = await c.createBlockStatus(R, SAZ);
    await c.readJobList();
    const b = await c.createBlockStatus(R, SAZ);
    expect(b).toBe(a + 2);
    await c.close();
  });

  it('p4 sbagliato → 0xD032', async () => {
    const peer = await new TestPeer(world()).open();
    const f = reqBlockStatus(R, SAZ);
    const data = f.data.slice();
    data[8 + 7] = 0x2f; // p4
    const r = await peer.userdata({ param: f.param, data });
    expect(decodeTisReply(r!.param, r!.data).errorCode).toBe(0xd032);
    peer.close();
  });

  it('forma non canonica → 0xD0AB', async () => {
    const peer = await new TestPeer(world()).open();
    const f = reqBlockStatus(R, SAZ);
    const data = f.data.slice();
    data[8 + 3] = 2; // p2 = 2
    const r = await peer.userdata({ param: f.param, data });
    expect(decodeTisReply(r!.param, r!.data).errorCode).toBe(0xd0ab);
    peer.close();
  });

  it('FC 99 assente → 0xD012; in STOP → 0xD081', async () => {
    const cpu = world();
    const c = await connect(cpu);
    await expect(c.createBlockStatus({ ...R, type: 'FC', number: 99 }, SAZ)).rejects.toMatchObject(
      cpuError(0xd0, 0x12),
    );
    cpu.setMode('STOP');
    await expect(c.createBlockStatus(R, SAZ)).rejects.toMatchObject(cpuError(0xd0, 0x81));
    await c.close();
  });

  it('tisV2 false: create → 0xD003', async () => {
    const c = await connect(world({ tisV2: false }));
    await expect(c.createBlockStatus(R, SAZ)).rejects.toMatchObject(cpuError(0xd0, 0x03));
    await c.close();
  });

  it('cinque job: il quinto 0xD062', async () => {
    const c = await connect(world());
    for (let i = 0; i < 4; i++) await c.createBlockStatus(R, SAZ);
    await expect(c.createBlockStatus(R, SAZ)).rejects.toMatchObject(cpuError(0xd0, 0x62));
    await c.close();
  });

  it('lo stesso blocco osservato da un altro client → 0xD063', async () => {
    const cpu = world();
    const a = await connect(cpu);
    const b = await connect(cpu);
    await a.createBlockStatus(R, SAZ);
    await expect(b.createBlockStatus(R, SAZ)).rejects.toMatchObject(cpuError(0xd0, 0x63));
    await a.close();
    await b.close();
  });

  it('una sola indication per enable', async () => {
    const peer = await new TestPeer(world()).open();
    const ack = await peer.userdata(reqBlockStatus(R, SAZ));
    const job = decodeTisReply(ack!.param, ack!.data).job;
    const before = peer.pdus.length;
    await peer.userdata(reqEnableJob(0x13, job));
    await settle();
    const fresh = peer.pdus.slice(before);
    const indications = fresh.filter((p) => p.rosctr === 7 && p.param[5] === 0x01);
    expect(indications).toHaveLength(1);
    expect(decodeTisReply(indications[0]!.param, indications[0]!.data)).toMatchObject({
      kind: 'indication',
      sub: 0x13,
      job,
    });
    // l'ack precede l'indication
    expect(fresh[0]!.param[5]).toBe(0x81);
    peer.close();
  });

  it('FC mai chiamato → nessuna indication in 1 s; chiamato → risultato', async () => {
    const c = await connect(world({ calledBlocks: ['FC10'] }));
    const never = await connect(world());
    const r = { ...R, type: 'FC' as const, number: 10 };
    const j1 = await never.createBlockStatus(r, SAZ);
    expect(await never.enableAndWait(0x13, j1, 1000)).toEqual({ timeout: true });
    const j2 = await c.createBlockStatus(r, SAZ);
    expect(await c.enableAndWait(0x13, j2, 1000)).toHaveProperty('result');
    await c.close();
    await never.close();
  });

  it('tisPartial: 0xD0CC con i valori → result con partial true', async () => {
    const c = await connect(world({ faults: { tisPartial: true } }));
    const job = await c.createBlockStatus(R, SAZ);
    const res = await c.enableAndWait(0x13, job, 1000);
    if (!('result' in res)) throw new Error('nessun risultato');
    expect(res.partial).toBe(true);
    expect(res.result.length).toBe(blockStatusResultSize(R));
    await c.close();
  });

  it('tisMalformed [0x13]: il risultato è troncato a 7 byte', async () => {
    const c = await connect(world({ faults: { tisMalformed: [0x13] } }));
    const job = await c.createBlockStatus(R, SAZ);
    const res = await c.enableAndWait(0x13, job, 1000);
    if (!('result' in res)) throw new Error('nessun risultato');
    expect(res.result.length).toBe(7);
    await c.close();
  });
});

describe('TIS: gestione dei job', () => {
  it('delete → la lista contiene solo 10 nn; secondo delete → notFound', async () => {
    const c = await connect(world());
    const job = await c.createBlockStatus(R, SAZ);
    expect(await c.readJobList()).toEqual([
      { fn: 0x13, job },
      { fn: 0x10, job: job + 1 },
    ]);
    expect(await c.deleteJob(0x13, job)).toBe('deleted');
    const list = await c.readJobList();
    expect(list).toHaveLength(1);
    expect(list[0]!.fn).toBe(0x10);
    expect(await c.deleteJob(0x13, job)).toBe('notFound');
    await c.close();
  });

  it('job di un altro client → otherConnection; con orphanJobs → cancellabile', async () => {
    for (const orphanJobs of [false, true]) {
      const cpu = world({ faults: { orphanJobs } });
      const a = await connect(cpu);
      const b = await connect(cpu);
      const job = await a.createBlockStatus(R, SAZ);
      expect(await b.deleteJob(0x13, job)).toBe(orphanJobs ? 'deleted' : 'otherConnection');
      await a.close();
      await b.close();
    }
  });

  it('sessione chiusa → i suoi job spariscono; con orphanJobs → restano', async () => {
    for (const orphanJobs of [false, true]) {
      const cpu = world({ faults: { orphanJobs } });
      const a = await connect(cpu);
      const b = await connect(cpu);
      const job = await a.createBlockStatus(R, SAZ);
      await a.close();
      await sleep(20);
      const list = await b.readJobList();
      expect(list.some((e) => e.fn === 0x13 && e.job === job)).toBe(orphanJobs);
      await b.close();
    }
  });

  it('RUN → STOP → enable → 0xD0A5', async () => {
    const cpu = world();
    const c = await connect(cpu);
    const job = await c.createBlockStatus(R, SAZ);
    cpu.setMode('STOP');
    await expect(c.enableAndWait(0x13, job, 500)).rejects.toMatchObject(cpuError(0xd0, 0xa5));
    await c.close();
  });

  it("download dell'OB1 osservato → enable → 0xD0C8", async () => {
    const cpu = world();
    const c = await connect(cpu);
    const job = await c.createBlockStatus(R, SAZ);
    cpu.applyDownloadedBlock('OB', 1, blockFile('OB', 1, seq(50, 9)));
    await expect(c.enableAndWait(0x13, job, 500)).rejects.toMatchObject(cpuError(0xd0, 0xc8));
    await c.close();
  });

  it('tisError sulla lista: il codice scelto', async () => {
    const c = await connect(world({ faults: { tisError: { sub: 0x10, code: 0xd0a1 } } }));
    await expect(c.readJobList()).rejects.toMatchObject(cpuError(0xd0, 0xa1));
    await c.close();
  });
});

describe('TIS: stack', () => {
  it('in RUN → 0xD081', async () => {
    const c = await connect(world());
    await expect(c.readStack('BSTACK')).rejects.toMatchObject(cpuError(0xd0, 0x81));
    await c.close();
  });

  it('in STOP: BSTACK con OB1 e FC10, ISTACK di 76 byte, LSTACK di 20', async () => {
    const c = await connect(world({ mode: 'STOP' }));
    const b = decodeBStack(await c.readStack('BSTACK'));
    if (!b.ok) throw new Error(b.why);
    expect(b.value.entries.map((e) => `${e.blockType}${e.number}`)).toEqual(['OB1', 'FC10']);
    expect(b.value.entries[0]!.ob?.priority).toBe(1);
    expect(b.value.rest).toBeUndefined();
    const raw = await c.readStack('ISTACK');
    expect(raw.length).toBe(76);
    const i = decodeIStack(raw);
    if (!i.ok) throw new Error(i.why);
    expect(i.value.stw).toBe(0x0106);
    expect(i.value.interrupted).toMatchObject({ blockType: 'FC', number: 10 });
    const l = await c.readStack('LSTACK', { priority: 1, depth: 0 });
    expect(l.length).toBe(20);
    expect(decodeLStack(l)).toMatchObject({ ok: true, value: { priority: 1 } });
    await c.close();
  });

  it('tisMalformed [0x04] → BSTACK di 7 byte', async () => {
    const c = await connect(world({ mode: 'STOP', faults: { tisMalformed: [0x04] } }));
    const raw = await c.readStack('BSTACK');
    expect(raw.length).toBe(7);
    expect(decodeBStack(raw)).toMatchObject({
      ok: true,
      value: { entries: [], rest: expect.any(String) },
    });
    await c.close();
  });
});

describe('FRCE', () => {
  it('forceActive → LED FRCE 0x0006 acceso in 0x0174, 0x0074 e 0x0019', async () => {
    const c = await connect(world({ forceActive: true }));
    expect(ledsFrom(await c.readSzl(0x0174, 6))).toEqual([
      { id: 6, name: 'FRCE', on: true, blink: 'none' },
    ]);
    for (const id of [0x0074, 0x0019]) {
      expect(ledsFrom(await c.readSzl(id, 0)).find((l) => l.name === 'FRCE')?.on).toBe(true);
    }
    await c.close();
    const off = await connect(world());
    expect(ledsFrom(await off.readSzl(0x0174, 6))[0]!.on).toBe(false);
    await off.close();
  });
});
