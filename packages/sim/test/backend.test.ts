import { findCpu } from '@baaportal/catalog';
import { syntheticSdb, serve, type CpuBackend } from '@baaportal/s7-server';
import {
  S7TestClient,
  S7WriteClient,
  buildBlockFile,
  decodeBStack,
  decodeBlockStatusResult,
  decodeLStack,
  type BlockStatusRequest,
  cycleConfigFrom,
  cycleTimeFrom,
  diagRecordsFrom,
  lastModeChangeFrom,
  isUnavailable,
  ledsFrom,
  memoryFrom,
  memoryTransportPair,
  parseBlockFile,
  type TransportFactory,
} from '@baaportal/s7comm';
import { describe, expect, it, vi } from 'vitest';
import { SimCpu, connectToSim, simBackend, type SimCpuOptions } from '../src';
import { buildFiles, buildProgram } from './programHelpers';

const PROPS: SimCpuOptions['props'] = {
  maxCycleMs: 150,
  minCycleMs: 0,
  clockMemory: { enabled: false, byte: 0 },
  retentivity: { mBytes: 16, timers: 2, counters: 2 },
  cyclicInterruptMs: 0,
};

const newCpu = (o: Partial<SimCpuOptions> = {}): SimCpu =>
  new SimCpu({ cpuTypeId: 'cpu-315-2-pn-dp', props: PROPS, ...o });

/** Un client collegato a un backend preparato dal test (per le opzioni che `connectToSim` non ha). */
async function connectTo(
  backend: CpuBackend,
  mode: 'online-write' | 'online-restore' = 'online-write',
): Promise<S7WriteClient> {
  const transport: TransportFactory = async () => {
    const [a, b] = memoryTransportPair();
    serve(backend, b);
    return a;
  };
  return S7WriteClient.connect({ host: 'sim', transport, timeoutMs: 3000 }, mode);
}

const OB1 = { kind: 'OB' as const, number: 1, networks: ['\tL 7;\n\tT MW 10;'] };

/** File di un DB di `n` byte a zero (sintetico). */
function dbFile(number: number, n: number): Uint8Array {
  const t = { year: 2020, month: 1, day: 1, hour: 0, minute: 0, second: 0, ms: 0 };
  return buildBlockFile(
    {
      type: 'DB',
      number,
      language: 5,
      flags: 0x01,
      security: 0,
      codeTime: t,
      interfaceTime: t,
      ssbLength: 0,
      addLength: 0,
      localDataLength: 0,
      mc7Length: n,
    },
    new Uint8Array(n),
    { author: 'BaaPort', family: 'DATADB', name: `DB${number}`, version: '1.0', checksum: 0 },
  );
}

describe('CPU simulata: SZL di diagnostica attraverso il server S7', () => {
  it('tempo di ciclo: minimo ≤ ultimo ≤ massimo, e la sorveglianza configurata', async () => {
    let t = 1_800_000_000_000;
    const cpu = newCpu({ now: () => (t += 1) }); // ogni lettura dell'orologio avanza di 1 ms
    const c = await connectToSim(cpu);
    for (const f of buildFiles([OB1])) await c.downloadBlock(f);
    await c.start();
    for (let i = 0; i < 5; i++) cpu.cycle();
    const cy = cycleTimeFrom(await c.readSzl(0x0222, 1));
    expect(cy.maxMs).toBeGreaterThan(0);
    expect(cy.minMs).toBeLessThanOrEqual(cy.lastMs);
    expect(cy.lastMs).toBeLessThanOrEqual(cy.maxMs);
    expect(cycleConfigFrom(await c.readSzl(0x0222, 0x50))).toEqual({ minMs: 0, maxMs: 150 });
    await c.close();
  });

  it('memoria: dopo il download di OB1 la memoria di lavoro usata cresce della lunghezza MC7', async () => {
    const cpu = newCpu();
    const c = await connectToSim(cpu);
    const before = memoryFrom(await c.readSzl(0x0013, 0));
    expect(before[0]).toMatchObject({
      kind: 'work',
      size: findCpu('cpu-315-2-pn-dp')!.workMemoryKB * 1024,
      used: 0,
    });
    const [ob] = buildFiles([OB1]);
    await c.downloadBlock(ob!);
    const mc7 = parseBlockFile(ob!).header.mc7Length;
    const after = memoryFrom(await c.readSzl(0x0013, 0));
    expect(mc7).toBeGreaterThan(0);
    expect(after[0]!.used - before[0]!.used).toBe(mc7);
    expect(after[2]!.used - before[2]!.used).toBe(ob!.length);
    await c.close();
  });

  it('LED: RUN acceso in RUN, STOP acceso in STOP, SF dopo un errore di programma', async () => {
    const cpu = newCpu();
    const c = await connectToSim(cpu);
    const led = async (name: string) =>
      ledsFrom(await c.readSzl(0x0019, 0)).find((l) => l.name === name)!;
    expect(await led('STOP')).toMatchObject({ on: true });
    expect(await led('RUN')).toMatchObject({ on: false });
    for (const f of buildFiles([
      { kind: 'OB', number: 1, networks: ['\tOPN DB 99;\n\tL 1;\n\tT MW 10;'] },
    ])) {
      await c.downloadBlock(f);
    }
    await c.start();
    expect(await led('RUN')).toMatchObject({ on: true, blink: 'none' });
    expect(await led('STOP')).toMatchObject({ on: false });
    expect(await led('SF')).toMatchObject({ on: false });
    cpu.cycle(); // OPN DB 99: DB non caricato, senza OB121 la CPU va in STOP
    expect(cpu.mode).toBe('STOP');
    expect(await led('SF')).toMatchObject({ on: true });
    expect(await led('STOP')).toMatchObject({ on: true });
    await c.close();
  });

  it('STOP e poi RUN → in testa al buffer 0x4302/0x68 e 0x4301/0x46; 0x0124 = 0x4302', async () => {
    const cpu = newCpu();
    const c = await connectToSim(cpu);
    await c.start();
    await c.stop();
    await c.start();
    const buf = diagRecordsFrom(await c.readSzl(0x00a0, 0));
    const modes = buf.filter((r) => r.eventId >> 12 === 4).map((r) => [r.eventId, r.obNumber]);
    expect(modes).toEqual([
      [0x4302, 0x68],
      [0x4301, 0x46],
      [0x4304, 0x84],
      [0x4302, 0x68],
      [0x4301, 0x46],
    ]);
    expect(buf[0]!.eventId).toBe(0x4302); // la più recente è la prima
    expect(lastModeChangeFrom(await c.readSzl(0x0124, 0))).toMatchObject({
      eventId: 0x4302,
      obNumber: 0x68,
    });
    await c.close();
  });

  it('write var su M e DB: la lettura dopo dà il valore scritto', async () => {
    const cpu = newCpu();
    const c = await connectToSim(cpu);
    await c.downloadBlock(dbFile(3, 8));
    await c.start();
    await c.writeArea('M', 0, 20, Uint8Array.of(0xde, 0xad));
    await c.writeArea('DB', 3, 2, Uint8Array.of(1, 2, 3));
    expect(Array.from(await c.readArea('M', 0, 20, 2))).toEqual([0xde, 0xad]);
    expect(Array.from(await c.readArea('DB', 3, 0, 6))).toEqual([0, 0, 1, 2, 3, 0]);
    expect(cpu.memory.dbs.get(3)!.data[3]).toBe(2);
    await c.close();
  });
});

describe('CPU simulata: ora', () => {
  it("set clock in RUN: la lettura dopo dà l'ora scritta (± 1 s) con il giorno della settimana ricalcolato", async () => {
    const cpu = newCpu();
    cpu.run();
    const c = await connectToSim(cpu);
    const t = { year: 2026, month: 10, day: 28, hour: 12, minute: 30, second: 15, ms: 0 };
    await c.setClock(t);
    const r = await c.readClock();
    const got = new Date(r.year, r.month - 1, r.day, r.hour, r.minute, r.second, r.ms).getTime();
    const want = new Date(2026, 9, 28, 12, 30, 15).getTime();
    expect(got - want).toBeGreaterThanOrEqual(0);
    expect(got - want).toBeLessThanOrEqual(1000);
    expect(r.weekday).toBe(4); // mercoledì
    // lo stesso orologio della CPU (SET_CLK): la CPU lo vede
    expect(Math.abs(cpu.clockMs() - want)).toBeLessThanOrEqual(1000);
    await c.close();
  });

  it("setClock della CPU è lo stesso scostamento di SET_CLK, senza toccare l'orologio di sistema", () => {
    let sys = 1_800_000_000_000;
    const cpu = newCpu({ now: () => sys });
    cpu.setClock(1_900_000_000_000);
    expect(cpu.clockMs()).toBe(1_900_000_000_000);
    sys += 500;
    expect(cpu.clockMs()).toBe(1_900_000_000_500);
  });

  it('set clock con livello di protezione 3 → 0xD0A1', async () => {
    const backend = simBackend(newCpu());
    backend.config.protectionLevel = 3;
    const c = await connectTo(backend);
    const err = await c
      .setClock({ year: 2026, month: 10, day: 28, hour: 1, minute: 2, second: 3, ms: 0 })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'CPU_ERROR', detail: { errorClass: 0xd0, errorCode: 0xa1 } });
    await c.close();
  });
});

describe('CPU simulata: SZL non disponibili', () => {
  it('faults.szlUnavailable [0x0013, 0x0124] → solo quelle due sono assenti', async () => {
    const backend = simBackend(newCpu());
    backend.config.faults = { szlUnavailable: [0x0013, 0x0124] };
    const c = await connectTo(backend);
    for (const [id, index] of [
      [0x0013, 0],
      [0x0124, 0],
    ] as const) {
      expect(isUnavailable(await c.readSzl(id, index).catch((e: unknown) => e))).toBe(true);
    }
    for (const [id, index] of [
      [0x0019, 0],
      [0x0222, 1],
      [0x0424, 0],
    ] as const) {
      await expect(c.readSzl(id, index)).resolves.toMatchObject({ id });
    }
    await c.close();
  });
});

describe('CPU simulata: SDB sintetici', () => {
  const sdb0 = syntheticSdb(0, 64);
  const sdb1 = syntheticSdb(1, 128);

  it('SDB 0 e 1: elenco, block info e upload in RUN, byte identici a quelli seminati', async () => {
    const cpu = newCpu();
    cpu.run();
    const c = await connectTo(simBackend(cpu, { systemBlocks: [sdb0, sdb1] }));
    expect((await c.blockCounts()).SDB).toBe(2);
    expect((await c.listBlocks('SDB')).map((b) => b.number)).toEqual([0, 1]);
    expect(await c.blockInfo('SDB', 1)).toMatchObject({ type: 'SDB', number: 1, language: 7 });
    expect(Array.from(await c.upload('SDB', 0))).toEqual(Array.from(sdb0));
    expect(Array.from(await c.upload('SDB', 1))).toEqual(Array.from(sdb1));
    await c.close();
  });

  it('download di un SDB → rifiutato; il programma della CPU non lo vede', async () => {
    const cpu = newCpu();
    cpu.run(); // in RUN gli SDB non si scrivono
    const c = await connectTo(simBackend(cpu, { systemBlocks: [sdb0] }), 'online-restore');
    await expect(c.downloadBlock(syntheticSdb(5, 16))).rejects.toMatchObject({ code: 'CPU_ERROR' });
    expect((await c.blockCounts()).SDB).toBe(1);
    expect(cpu.program.list().some((b) => (b.kind as string) === 'SDB')).toBe(false);
    await c.close();
  });

  it('in STOP, con il modo del ripristino: SDB scaricato e cancellato come blob opaco', async () => {
    const cpu = newCpu();
    const backend = simBackend(cpu, { systemBlocks: [sdb0] });
    const transport: TransportFactory = async () => {
      const [a, b] = memoryTransportPair();
      serve(backend, b);
      return a;
    };
    const c = await S7WriteClient.connect(
      { host: 'sim', transport, timeoutMs: 3000 },
      'online-restore',
    );
    await c.downloadBlock(syntheticSdb(5, 16));
    expect((await c.blockCounts()).SDB).toBe(2);
    await c.deleteSystemBlock(5);
    expect((await c.blockCounts()).SDB).toBe(1);
    expect(cpu.program.list().some((b) => (b.kind as string) === 'SDB')).toBe(false);
    await c.close();
  });

  it('systemBlocks accetta solo SDB', () => {
    const [ob] = buildFiles([OB1]);
    expect(() => simBackend(newCpu(), { systemBlocks: [ob!] })).toThrow(RangeError);
  });
});

describe('CPU simulata: funzioni di test TIS', () => {
  async function connectTest(cpu: SimCpu): Promise<S7TestClient> {
    const backend = simBackend(cpu);
    const transport: TransportFactory = async () => {
      const [a, b] = memoryTransportPair();
      serve(backend, b);
      return a;
    };
    return S7TestClient.connect({ host: 'sim', transport, timeoutMs: 3000 });
  }

  /** CPU in RUN con il programma `blocks`, caricato direttamente (senza file sul server). */
  function runningCpu(blocks: Parameters<typeof buildProgram>[0]): SimCpu {
    const cpu = newCpu({ now: () => 0 });
    for (const b of buildProgram(blocks).list()) cpu.program.put(b);
    cpu.run();
    return cpu;
  }

  const lines = (...offsets: number[]): BlockStatusRequest => ({
    type: 'OB',
    number: 1,
    initMask: 0x03,
    lines: offsets.map((offset) => ({ offset, mask: 0x03 })),
  });

  /** Fa girare i cicli mentre il test aspetta il risultato (l'osservazione dura fino al ciclo dopo l'enable). */
  async function withCycles<T>(cpu: SimCpu, f: () => Promise<T>): Promise<T> {
    const timer = setInterval(() => cpu.cycle(), 5);
    try {
      return await f();
    } finally {
      clearInterval(timer);
    }
  }

  it('L 5 / T MW 10 in OB1: ACCU1 = 5 sulla riga della T; il monitor torna libero', async () => {
    const cpu = runningCpu([{ kind: 'OB', number: 1, networks: ['\tL 5;\n\tT MW 10;'] }]);
    const c = await connectTest(cpu);
    const r = lines(0, 4);
    const res = await withCycles(cpu, async () => {
      const job = await c.createBlockStatus(r, 6);
      return c.enableAndWait(0x13, job, 2000);
    });
    if (!('result' in res)) throw new Error('nessun risultato');
    const dec = decodeBlockStatusResult(res.result, r);
    if (!dec.ok) throw new Error(dec.why);
    expect(dec.lines[1]).toMatchObject({ accu1: 5 });
    expect(cpu.monitorSnapshot()).toBeUndefined();
    await c.close();
  });

  it("riga dopo un salto preso → assente dall'indication", async () => {
    // offset: SET 0, JC 2, L 1 6 e T MW 10 8 (saltate), NOP 12, L 5 14, T MW 12 18
    const cpu = runningCpu([
      {
        kind: 'OB',
        number: 1,
        networks: ['\tSET;\n\tJC fine;\n\tL 1;\n\tT MW 10;\nfine: NOP 0;\n\tL 5;\n\tT MW 12;'],
      },
    ]);
    const c = await connectTest(cpu);
    const r = lines(6, 8, 14, 18);
    const res = await withCycles(cpu, async () => {
      const job = await c.createBlockStatus(r, 20);
      return c.enableAndWait(0x13, job, 2000);
    });
    if (!('result' in res)) throw new Error('nessun risultato');
    // 2 byte di offset + iniziali (6) + due righe eseguite da 8 byte: le due saltate mancano
    expect(res.result.length).toBe(2 + 6 + 2 * 8);
    const dec = decodeBlockStatusResult(res.result, r);
    if (!dec.ok) throw new Error(dec.why);
    expect(dec.lines[0]).toBeNull();
    expect(dec.lines[1]).toBeNull();
    expect(dec.lines[3]).toMatchObject({ accu1: 5 });
    await c.close();
  });

  it("senza cicli l'osservazione scade e non blocca quella dopo", async () => {
    vi.useFakeTimers();
    try {
      const cpu = runningCpu([{ kind: 'OB', number: 1, networks: ['\tL 5;\n\tT MW 10;'] }]);
      const b = simBackend(cpu);
      const first = b.blockStatus!('OB', 1, [{ offset: 0, mask: 3 }]);
      const second = b.blockStatus!('OB', 1, [{ offset: 0, mask: 3 }]);
      await vi.advanceTimersByTimeAsync(3000);
      await expect(first).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(3000);
      await expect(second).resolves.toBeUndefined();
      expect(cpu.monitorSnapshot()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('FC mai chiamato → nessuna indication; il monitor torna libero', async () => {
    const cpu = runningCpu([
      { kind: 'OB', number: 1, networks: ['\tL 5;\n\tT MW 10;'] },
      { kind: 'FC', number: 1, networks: ['\tL 7;\n\tT MW 12;'] },
    ]);
    const c = await connectTest(cpu);
    const r: BlockStatusRequest = { ...lines(0, 4), type: 'FC', number: 1 };
    const res = await withCycles(cpu, async () => {
      const job = await c.createBlockStatus(r, 6);
      return c.enableAndWait(0x13, job, 300);
    });
    expect(res).toEqual({ timeout: true });
    expect(cpu.monitorSnapshot()).toBeUndefined();
    await c.close();
  });

  it('blocco assente → 0xD012; in STOP → 0xD081', async () => {
    const cpu = runningCpu([{ kind: 'OB', number: 1, networks: ['\tL 5;\n\tT MW 10;'] }]);
    const c = await connectTest(cpu);
    await expect(
      c.createBlockStatus({ ...lines(0), type: 'FC', number: 9 }, 6),
    ).rejects.toMatchObject({ detail: { errorClass: 0xd0, errorCode: 0x12 } });
    cpu.stop();
    await expect(c.createBlockStatus(lines(0, 4), 6)).rejects.toMatchObject({
      detail: { errorClass: 0xd0, errorCode: 0x81 },
    });
    await c.close();
  });

  it("il passaggio in STOP cancella i job: l'enable dopo dà 0xD0A5", async () => {
    const cpu = runningCpu([{ kind: 'OB', number: 1, networks: ['\tL 5;\n\tT MW 10;'] }]);
    const c = await connectTest(cpu);
    const job = await c.createBlockStatus(lines(0, 4), 6);
    cpu.stop();
    await expect(c.enableAndWait(0x13, job, 300)).rejects.toMatchObject({
      detail: { errorClass: 0xd0, errorCode: 0xa5 },
    });
    await c.close();
  });

  it('stack: in RUN 0xD081; in STOP BSTACK = OB1, LSTACK a zero', async () => {
    const cpu = runningCpu([{ kind: 'OB', number: 1, networks: ['\tL 5;\n\tT MW 10;'] }]);
    const c = await connectTest(cpu);
    await expect(c.readStack('BSTACK')).rejects.toMatchObject({
      detail: { errorClass: 0xd0, errorCode: 0x81 },
    });
    cpu.stop();
    const b = decodeBStack(await c.readStack('BSTACK'));
    if (!b.ok) throw new Error(b.why);
    expect(b.value.entries.map((e) => `${e.blockType}${e.number}`)).toEqual(['OB1']);
    expect((await c.readStack('ISTACK')).length).toBe(76);
    const l = decodeLStack(await c.readStack('LSTACK', { priority: 1, depth: 0 }));
    expect(l).toMatchObject({ ok: true, value: { priority: 0 } });
    await c.close();
  });
});
