import { describe, expect, it } from 'vitest';
import {
  S7WriteClient,
  cycleConfigFrom,
  cycleTimeFrom,
  diagRecordsFrom,
  encodeDeleteBlock,
  isUnavailable,
  lastModeChangeFrom,
  ledsFrom,
  memoryFrom,
  memoryTransportPair,
  modeTransition,
  type S7DateTime,
  type TransportFactory,
} from '@baaportal/s7comm';
import { FakeCpu, serve, syntheticSdb, type CpuBackend } from '../src';
import { TestPeer, blockFile, seq } from './helpers';

/** Un client di scrittura collegato in memoria a `cpu` (il finto PLC o un suo derivato). */
async function connect(cpu: CpuBackend): Promise<S7WriteClient> {
  const transport: TransportFactory = async () => {
    const [a, b] = memoryTransportPair();
    serve(cpu, b);
    return a;
  };
  return S7WriteClient.connect({ host: 'finto', transport, timeoutMs: 1500 });
}

/** Il finto PLC con un orologio che si può impostare: la lettura segue l'ora scritta. */
function withClock(cpu: FakeCpu): CpuBackend {
  let set: { ms: number; at: number } | undefined;
  const b = Object.create(cpu) as CpuBackend;
  b.setClock = (t: S7DateTime) => {
    set = {
      ms: Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second, t.ms),
      at: Date.now(),
    };
  };
  b.now = () => {
    if (!set) return cpu.now();
    const d = new Date(set.ms + (Date.now() - set.at));
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds(),
      ms: d.getUTCMilliseconds(),
      weekday: d.getUTCDay() + 1,
    };
  };
  return b;
}

describe('SZL di diagnostica del finto PLC: forma delle liste (proto §7.5)', () => {
  it('ogni SZL nuova ha la lunghezza di record e il numero di record di §7.5', async () => {
    const c = await connect(new FakeCpu());
    const want: [number, number, number, number][] = [
      // id, indice, lunghezza del record, numero di record
      [0x0013, 0, 36, 5],
      [0x0019, 0, 4, 7],
      [0x0074, 0, 4, 7],
      [0x0174, 4, 4, 1],
      [0x0124, 0, 20, 1],
      [0x0222, 1, 28, 1],
      [0x0222, 0x50, 28, 1],
    ];
    for (const [id, index, len, n] of want) {
      const l = await c.readSzl(id, index);
      expect(l.recordLength, `0x${id.toString(16)}`).toBe(len);
      expect(l.records, `0x${id.toString(16)}`).toHaveLength(n);
      for (const r of l.records) expect(r).toHaveLength(len);
    }
    // le intestazioni 0x0Fxx: lunghezza del record e conteggio della lista piena, nessun record
    for (const [id, len, n] of [
      [0x0f13, 36, 5],
      [0x0f19, 4, 7],
      [0x0f74, 4, 7],
      [0x0f22, 28, 2],
    ] as const) {
      const l = await c.readSzl(id, 0);
      expect(l).toMatchObject({ recordLength: len, records: [], declaredCount: n });
    }
    await c.close();
  });

  it('0x0222 indice 0x5050 → 0xD402, riconosciuto come lista assente', async () => {
    const c = await connect(new FakeCpu());
    const err = await c.readSzl(0x0222, 0x5050).catch((e: unknown) => e);
    expect(isUnavailable(err)).toBe(true);
    expect(err).toMatchObject({ code: 'CPU_ERROR', detail: { errorClass: 0xd4, errorCode: 0x02 } });
    // 0x0013 e 0x0222 con indici validi non sono assenti
    await c.readSzl(0x0013, 0);
    await c.readSzl(0x0222, 1);
    await c.close();
  });

  it('faults.szlUnavailable [0x0013] → 0xD402 solo per 0x0013', async () => {
    const c = await connect(new FakeCpu({ faults: { szlUnavailable: [0x0013] } }));
    expect(isUnavailable(await c.readSzl(0x0013, 0).catch((e: unknown) => e))).toBe(true);
    for (const [id, index] of [
      [0x0019, 0],
      [0x0124, 0],
      [0x0222, 1],
      [0x0424, 0],
    ] as const) {
      await expect(c.readSzl(id, index)).resolves.toMatchObject({ id });
    }
    await c.close();
    expect(() => new FakeCpu({ faults: { szlUnavailable: [-1] } })).toThrow(RangeError);
  });

  it('0x0222 senza tempi dal backend: zeri e sorveglianza di 150 ms', async () => {
    const c = await connect(new FakeCpu());
    expect(cycleTimeFrom(await c.readSzl(0x0222, 1))).toMatchObject({
      lastMs: 0,
      minMs: 0,
      maxMs: 0,
    });
    expect(cycleConfigFrom(await c.readSzl(0x0222, 0x50))).toEqual({ minMs: 0, maxMs: 150 });
    await c.close();
  });
});

describe('buffer diagnostico, ultimo cambio di modo e LED', () => {
  it('STOP e poi RUN → in testa al buffer 0x4302 con byte 0x68 e 0x4301 con 0x46; 0x0124 = 0x4302', async () => {
    const cpu = new FakeCpu({ mode: 'RUN' });
    const c = await connect(cpu);
    await c.stop();
    await c.start();
    const buf = diagRecordsFrom(await c.readSzl(0x00a0, 0));
    expect(buf.slice(0, 3).map((r) => [r.eventId, r.obNumber])).toEqual([
      [0x4302, 0x68],
      [0x4301, 0x46],
      [0x4304, 0x84], // STOP da PG
    ]);
    expect(buf[0]).toMatchObject({ priority: 0xff });
    expect(modeTransition(0x68)).toEqual({ from: 'startup', to: 'run' });
    const last = lastModeChangeFrom(await c.readSzl(0x0124, 0));
    expect(last).toMatchObject({ eventId: 0x4302, obNumber: 0x68 });
    expect(last!.time).toBeDefined();
    await c.close();
  });

  it('0x0124 senza voci di classe 4: un 0x4302 costruito da modeSince', async () => {
    const cpu = new FakeCpu({ mode: 'RUN' });
    const c = await connect(cpu);
    const last = lastModeChangeFrom(await c.readSzl(0x0124, 0));
    expect(last).toMatchObject({ eventId: 0x4302, priority: 0xff });
    expect(last!.time).toMatchObject({ year: cpu.modeSince.year, month: cpu.modeSince.month });
    // una voce di classe diversa non conta: l'ultima di classe 4 resta quella
    cpu.addDiagnostic({
      eventId: 0x2521,
      info: new Uint8Array(10),
      time: cpu.now(),
    });
    expect(lastModeChangeFrom(await c.readSzl(0x0124, 0))!.eventId).toBe(0x4302);
    await c.close();
  });

  it('LED: RUN acceso in RUN, STOP acceso in STOP, SF segue faultLed', async () => {
    const cpu = new FakeCpu({ mode: 'RUN' });
    const c = await connect(cpu);
    const led = async (name: string) =>
      ledsFrom(await c.readSzl(0x0019, 0)).find((l) => l.name === name)!;
    expect(ledsFrom(await c.readSzl(0x0019, 0)).map((l) => l.name)).toEqual([
      'SF',
      'RUN',
      'STOP',
      'FRCE',
      'BUS1F',
      'BUS2F',
      'MAINT',
    ]);
    expect(await led('RUN')).toMatchObject({ on: true, blink: 'none' });
    expect(await led('STOP')).toMatchObject({ on: false });
    expect(await led('SF')).toMatchObject({ on: false });
    await c.stop();
    expect(await led('RUN')).toMatchObject({ on: false });
    expect(await led('STOP')).toMatchObject({ on: true, blink: 'none' });
    cpu.faultLed = true;
    expect(await led('SF')).toMatchObject({ on: true });
    // 0x0074 = tutti, 0x0174 = uno solo, scelto con l'id del LED
    expect(ledsFrom(await c.readSzl(0x0074, 0))).toHaveLength(7);
    expect(ledsFrom(await c.readSzl(0x0174, 0x04))).toEqual([
      { id: 4, name: 'RUN', on: false, blink: 'none' },
    ]);
    expect(isUnavailable(await c.readSzl(0x0174, 0x99).catch((e: unknown) => e))).toBe(true);
    await c.close();
  });

  it('LED in avviamento: STOP acceso e RUN lampeggiante a 2 Hz', async () => {
    const cpu = new FakeCpu({ mode: 'STARTUP' });
    const c = await connect(cpu);
    const leds = ledsFrom(await c.readSzl(0x0019, 0));
    expect(leds.find((l) => l.name === 'STOP')).toMatchObject({ on: true, blink: 'none' });
    expect(leds.find((l) => l.name === 'RUN')).toMatchObject({ on: true, blink: 'normal' });
    await c.close();
  });
});

describe('memoria (0x0013)', () => {
  it('lavoro = MC7 caricata, MMC = lunghezze di caricamento, 5 aree come §7.5.3', async () => {
    const cpu = new FakeCpu({ memory: { workBytes: 196608 } });
    const c = await connect(cpu);
    const before = memoryFrom(await c.readSzl(0x0013, 0));
    expect(before.map((a) => [a.index, a.kind, a.size])).toEqual([
      [1, 'work', 196608],
      [2, 'loadIntegrated', 0],
      [3, 'loadMmc', 512 * 1024],
      [4, 'loadMax', 8 * 1024 * 1024],
      [5, 'backup', 1280],
    ]);
    expect(before.map((a) => a.used)).toEqual([0, 0, 0, 0, 0]);
    const file = blockFile('OB', 1, seq(120, 5));
    await c.downloadBlock(file);
    const after = memoryFrom(await c.readSzl(0x0013, 0));
    expect(after[0]!.used).toBe(120); // lunghezza MC7
    expect(after[2]!.used).toBe(file.length); // lunghezza di caricamento
    expect(after[0]!.free).toBe(196608 - 120);
    // un solo indice → un solo record
    expect(memoryFrom(await c.readSzl(0x0013, 3)).map((a) => a.index)).toEqual([3]);
    await c.close();
  });

  it('gli SDB contano nella memoria di caricamento ma non in quella di lavoro', async () => {
    const sdb = syntheticSdb(1, 200);
    const c = await connect(new FakeCpu({ systemBlocks: [sdb] }));
    const m = memoryFrom(await c.readSzl(0x0013, 0));
    expect(m[0]!.used).toBe(0);
    expect(m[2]!.used).toBe(sdb.length);
    await c.close();
  });
});

describe('tempi di ciclo (0x0222) con un backend che li ha', () => {
  it('ultimo, minimo, massimo e la sorveglianza configurata', async () => {
    const cpu = new FakeCpu();
    const b = Object.create(cpu) as CpuBackend;
    b.cycleStats = () => ({ lastMs: 4, minMs: 2, maxMs: 9, configMinMs: 1, configMaxMs: 300 });
    const c = await connect(b);
    const t = cycleTimeFrom(await c.readSzl(0x0222, 1));
    expect(t).toMatchObject({ lastMs: 4, minMs: 2, maxMs: 9 });
    expect(t.minMs <= t.lastMs && t.lastMs <= t.maxMs).toBe(true);
    expect(cycleConfigFrom(await c.readSzl(0x0222, 0x50))).toEqual({ minMs: 1, maxMs: 300 });
    await c.close();
  });
});

describe("impostazione dell'ora (userdata 7/2)", () => {
  it("set clock in RUN: la lettura dopo dà l'ora scritta (± 1 s) con il giorno della settimana ricalcolato", async () => {
    const cpu = new FakeCpu({ mode: 'RUN' });
    const c = await connect(withClock(cpu));
    const t = { year: 2026, month: 10, day: 28, hour: 12, minute: 30, second: 15, ms: 0 };
    await c.setClock(t);
    const r = await c.readClock();
    const delta =
      Date.UTC(r.year, r.month - 1, r.day, r.hour, r.minute, r.second, r.ms) -
      Date.UTC(2026, 9, 28, 12, 30, 15);
    expect(delta).toBeGreaterThanOrEqual(0);
    expect(delta).toBeLessThanOrEqual(1000);
    expect(r.weekday).toBe(4); // mercoledì: il PG manda 0, la CPU lo ricalcola
    await c.close();
  });

  it('senza setClock nel backend: "non implementato" (0x8104)', async () => {
    const c = await connect(new FakeCpu());
    const err = await c
      .setClock({ year: 2026, month: 10, day: 28, hour: 1, minute: 2, second: 3, ms: 0 })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'CPU_ERROR', detail: { errorClass: 0x81, errorCode: 0x04 } });
    await c.close();
  });

  it("set clock con livello di protezione 3 → 0xD0A1 (ipotesi di §12.0) e l'ora non cambia", async () => {
    const cpu = new FakeCpu({ protectionLevel: 3 });
    let called = false;
    const b = Object.create(cpu) as CpuBackend;
    b.setClock = () => {
      called = true;
    };
    const c = await connect(b);
    const err = await c
      .setClock({ year: 2026, month: 10, day: 28, hour: 1, minute: 2, second: 3, ms: 0 })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'CPU_ERROR', detail: { errorClass: 0xd0, errorCode: 0xa1 } });
    expect(called).toBe(false);
    await c.close();
  });

  it("set clock con livello di protezione 2 → 0xD241 e l'ora non cambia", async () => {
    const cpu = new FakeCpu({ protectionLevel: 2 });
    let called = false;
    const b = Object.create(cpu) as CpuBackend;
    b.setClock = () => {
      called = true;
    };
    const c = await connect(b);
    const err = await c
      .setClock({ year: 2026, month: 10, day: 28, hour: 1, minute: 2, second: 3, ms: 0 })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'CPU_ERROR', detail: { errorClass: 0xd2, errorCode: 0x41 } });
    expect(called).toBe(false);
    await c.close();
  });

  it("set clock con la CPU in STOP: accettato, la lettura dopo dà l'ora scritta", async () => {
    const cpu = new FakeCpu({ mode: 'STOP' });
    const c = await connect(withClock(cpu));
    await c.setClock({ year: 2026, month: 10, day: 28, hour: 12, minute: 30, second: 15, ms: 0 });
    const r = await c.readClock();
    expect([r.year, r.month, r.day, r.hour, r.minute]).toEqual([2026, 10, 28, 12, 30]);
    await c.close();
  });

  it('7/4 resta rifiutata', async () => {
    const p = await new TestPeer(new FakeCpu()).open();
    const r = await p.send({
      rosctr: 7,
      param: Uint8Array.of(0x00, 0x01, 0x12, 0x04, 0x11, 0x47, 0x04, 0x00),
      data: Uint8Array.of(
        0xff,
        0x09,
        0x00,
        0x0a,
        0,
        0x19,
        0x26,
        0x10,
        0x28,
        0x12,
        0x30,
        0x15,
        0,
        0x40,
      ),
    });
    expect(r).toMatchObject({ rosctr: 2, errorClass: 0xd2, errorCode: 0x41 });
  });
});

describe('SDB come blob opachi', () => {
  const sdb0 = syntheticSdb(0, 64);
  const sdb1 = syntheticSdb(1, 300);

  it('SDB 0 e 1: elenco, block info e upload in RUN, byte identici a quelli seminati', async () => {
    const c = await connect(new FakeCpu({ mode: 'RUN', systemBlocks: [sdb0, sdb1] }));
    expect((await c.blockCounts()).SDB).toBe(2);
    expect((await c.listBlocks('SDB')).map((b) => [b.number, b.language])).toEqual([
      [0, 7],
      [1, 7],
    ]);
    const info = await c.blockInfo('SDB', 1);
    expect(info).toMatchObject({ type: 'SDB', number: 1, language: 7, mc7Length: 300 });
    expect(info.loadLength).toBe(sdb1.length);
    expect(Array.from(await c.upload('SDB', 0))).toEqual(Array.from(sdb0));
    expect(Array.from(await c.upload('SDB', 1))).toEqual(Array.from(sdb1));
    await c.close();
  });

  it('la scritta di prova sta in testa al corpo, il resto è a zero', () => {
    const body = new TextDecoder().decode(
      sdb0.slice(sdb0.length - 36 - 64, sdb0.length - 36 - 64 + 22),
    );
    expect(body).toBe('BaaPortal SDB di prova');
    expect(() => syntheticSdb(0x10000, 1)).toThrow(RangeError);
    expect(() => syntheticSdb(0, -1)).toThrow(RangeError);
  });

  it("download e _DELE di un SDB → rifiutati, l'SDB resta uguale", async () => {
    const cpu = new FakeCpu({ mode: 'RUN', systemBlocks: [sdb0] });
    const c = await connect(cpu);
    const other = syntheticSdb(0, 10);
    // il filtro di online-write non manda gli SDB; il rifiuto della CPU in RUN è in sdbWrite.test.ts
    await expect(c.downloadBlock(other)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(c.downloadBlock(syntheticSdb(7, 10))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(Array.from(await c.upload('SDB', 0))).toEqual(Array.from(sdb0));
    expect((await c.blockCounts()).SDB).toBe(1);
    await c.close();

    // _DELE: il client non lo manda (solo OB, FB, FC, DB), quindi la richiesta è scritta a mano
    const p = await new TestPeer(cpu).open();
    const r = await p.job(encodeDeleteBlock('SDB', 0, 'A'));
    expect(r).toMatchObject({ rosctr: 2, errorClass: 0xd2, errorCode: 0x41 });
    expect(cpu.blockCounts().SDB).toBe(1);
  });

  it('systemBlocks accetta solo SDB', () => {
    expect(() => new FakeCpu({ systemBlocks: [blockFile('OB', 1, seq(4, 1))] })).toThrow(
      RangeError,
    );
  });
});
