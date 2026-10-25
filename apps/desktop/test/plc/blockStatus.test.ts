import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compileBlock, type CompileInput } from '@baaportal/mc7';
import {
  S7TestClient,
  buildBlockFile,
  memoryTransportPair,
  type TransportFactory,
} from '@baaportal/s7comm';
import { FakeCpu, serve, type CpuBackend, type FakeCpuOptions } from '@baaportal/s7-server';
import { SimCpu, simBackend } from '@baaportal/sim';
import type { PlcAccess, PlcMode, PlcStatusRequest } from '@baaportal/ui';
import {
  BlockStatusService,
  cpuKey,
  parseStatusRequest,
  type StatusClient,
} from '../../src/main/plc/blockStatus';
import type { PlcOwner } from '../../src/main/plc/plcService';
import { memoryJobStore } from '../../src/main/plc/tisJobs';

class FakeOwner implements PlcOwner {
  private destroyed = false;
  private listeners = new Set<() => void>();
  isDestroyed(): boolean {
    return this.destroyed;
  }
  send(): void {}
  once(_e: 'destroyed', cb: () => void): void {
    this.listeners.add(cb);
  }
  removeListener(_e: 'destroyed', cb: () => void): void {
    this.listeners.delete(cb);
  }
  destroy(): void {
    this.destroyed = true;
    for (const cb of [...this.listeners]) cb();
  }
}

const ORDER = '6ES7 315-2EH14-0AB0';
const T0 = { year: 2020, month: 5, day: 17, hour: 10, minute: 20, second: 30, ms: 0 };

function blockFile(type: 'OB' | 'FC', number: number, len: number): Uint8Array {
  const mc7 = Uint8Array.from({ length: len }, (_, i) => (2 + i) & 0xff);
  return buildBlockFile(
    {
      type,
      number,
      language: 1,
      flags: 0x01,
      security: 0,
      codeTime: T0,
      interfaceTime: T0,
      ssbLength: 0,
      addLength: 0,
      localDataLength: 0,
      mc7Length: len,
    },
    mc7,
    { author: 'BAA', family: 'TEST', name: `${type}${number}`, version: '1.1', checksum: 0x1234 },
  );
}

const EXPECT = { checksum: 0x1234, mc7Length: 100 };
const evens = (from: number, to: number): number[] => {
  const out: number[] = [];
  for (let o = from; o <= to; o += 2) out.push(o);
  return out;
};
const req = (over: Partial<PlcStatusRequest> = {}): PlcStatusRequest => ({
  type: 'OB',
  number: 1,
  expect: EXPECT,
  offsets: [0, 2, 4],
  saz: 10,
  mask: 0x03,
  ...over,
});

const access = (port = 102): PlcAccess => ({
  host: '192.0.2.10',
  port,
  rack: 0,
  slot: 2,
  connectionType: 'PG',
});

function world(o: FakeCpuOptions = {}): FakeCpu {
  const cpu = new FakeCpu(o);
  cpu.addBlock(blockFile('OB', 1, 100));
  cpu.addBlock(blockFile('FC', 10, 100));
  return cpu;
}

interface Call {
  name: string;
  at: number;
  args: unknown[];
}

describe('BlockStatusService', () => {
  let backend: CpuBackend;
  let clock: number;
  let mode: PlcMode;
  let calls: Call[];
  let connections: StatusClient[];
  let linkEnds: Map<PlcOwner, Set<() => void>>;
  let owners: FakeOwner[];
  let jobs: ReturnType<typeof memoryJobStore>;
  let access1: PlcAccess;
  let wantSerial: string | undefined;

  const names = (n: string): Call[] => calls.filter((c) => c.name === n);

  function spy(c: S7TestClient): StatusClient {
    const wrap =
      <A extends unknown[], R>(name: string, f: (...a: A) => R) =>
      (...a: A): R => {
        calls.push({ name, at: clock, args: a });
        return f.apply(c, a);
      };
    const out: StatusClient = {
      identity: () => c.identity(),
      close: () => c.close(),
      get pduLength() {
        return c.pduLength;
      },
      tisFunctions: () => c.tisFunctions(),
      blockInfo: (t, n) => c.blockInfo(t, n),
      readJobList: () => c.readJobList(),
      createBlockStatus: wrap('create', (r, s) => c.createBlockStatus(r, s)),
      enableAndWait: wrap('enable', (f, j, t) => c.enableAndWait(f, j, t)),
      deleteJob: wrap('delete', (f, j) => c.deleteJob(f, j)),
    };
    return out;
  }

  const connectRaw = async (b = backend): Promise<S7TestClient> => {
    const transport: TransportFactory = async () => {
      const [a, z] = memoryTransportPair();
      serve(b, z);
      return a;
    };
    return S7TestClient.connect({ host: 'finto', transport, timeoutMs: 2000 });
  };

  function newService(
    o: Partial<ConstructorParameters<typeof BlockStatusService>[0]> = {},
  ): BlockStatusService {
    const service = {
      target: (owner: PlcOwner) =>
        owners.includes(owner as FakeOwner)
          ? {
              access: owners.indexOf(owner as FakeOwner) === 0 ? access1 : access(103),
              identity: { orderNumber: ORDER, ...(wantSerial ? { serial: wantSerial } : {}) },
              linkId: 1,
            }
          : undefined,
      modeOf: () => mode,
      onLinkEnd: (owner: PlcOwner, cb: () => void) => {
        const set = linkEnds.get(owner) ?? new Set();
        set.add(cb);
        linkEnds.set(owner, set);
        return () => void set.delete(cb);
      },
    };
    return new BlockStatusService({
      service,
      jobs,
      minEnableMs: 0,
      idleMs: 60_000,
      now: () => clock,
      connect: async () => {
        const c = spy(await connectRaw());
        connections.push(c);
        return c;
      },
      ...o,
    });
  }

  const liveJobs = async (): Promise<number[]> => {
    const c = await connectRaw();
    try {
      return (await c.readJobList()).filter((j) => j.fn === 0x13).map((j) => j.job);
    } finally {
      await c.close();
    }
  };

  beforeEach(() => {
    backend = world();
    clock = 1000;
    mode = 'RUN';
    calls = [];
    connections = [];
    linkEnds = new Map();
    owners = [new FakeOwner(), new FakeOwner()];
    jobs = memoryJobStore();
    access1 = access();
    wantSerial = undefined;
  });
  afterEach(() => undefined);

  it('start + read contro il PLC di prova con OB1 L 5 / T MW 10 → riga di T con ACCU1 5, STW presente', async () => {
    const cpu = new SimCpu({
      cpuTypeId: 'cpu-315-2-pn-dp',
      props: {
        maxCycleMs: 150,
        minCycleMs: 0,
        clockMemory: { enabled: false, byte: 0 },
        retentivity: { mBytes: 16, timers: 0, counters: 8 },
        cyclicInterruptMs: 0,
      },
    });
    const ctx = {
      owner: {
        kind: 'OB',
        iface: {
          input: [],
          output: [],
          inOut: [],
          static: [],
          temp: [],
          returnType: { kind: 'void' },
        },
      },
      symbol: () => undefined,
      block: () => undefined,
      resolve: () => null,
      allSymbols: () => [],
      allBlocks: () => [],
    } as unknown as CompileInput['ctx'];
    const r = compileBlock({
      now: new Date(2026, 9, 20, 10, 30, 15, 250),
      header: { author: 'Diego', family: 'Prove', name: 'Blocco', version: '0.1' },
      knowHowProtected: false,
      sections: { in: [], out: [], inOut: [], stat: [], temp: [], ret: [] },
      initials: {},
      networks: ['\tL 5;\n\tT MW 10;'],
      ctx,
      kind: 'OB',
      number: 1,
    });
    if (!r.file) throw new Error('compilazione fallita');
    cpu.run();
    const simB = simBackend(cpu);
    // il programma si scarica con un client di scrittura sullo stesso backend
    const { S7WriteClient } = await import('@baaportal/s7comm');
    const wc = await S7WriteClient.connect({
      host: 'sim',
      timeoutMs: 2000,
      transport: async () => {
        const [a, z] = memoryTransportPair();
        serve(simB, z);
        return a;
      },
    });
    await wc.downloadBlock(r.file);
    await wc.close();
    const info = await (await connectRaw(simB)).blockInfo('OB', 1);
    const timer = setInterval(() => cpu.cycle(), 5);
    try {
      const svc = newService({
        connect: async () => spy(await connectRaw(simB)),
      });
      const s = await svc.start(owners[0]!, {
        ...req({
          offsets: [0, 4],
          saz: 6,
          expect: { checksum: info.checksum!, mc7Length: info.mc7Length! },
        }),
      });
      expect(s).toMatchObject({ ok: true });
      const res = await svc.read(owners[0]!);
      if (!res.ok || res.state !== 'values') throw new Error(JSON.stringify(res));
      expect(res.lines[1]!.regs).toMatchObject({ accu1: 5 });
      expect(res.lines[1]!.regs!.stw).toBeDefined();
      await svc.stop(owners[0]!);
    } finally {
      clearInterval(timer);
    }
  });

  it('start con checksum diverso → different, nessun job creato', async () => {
    const svc = newService();
    const r = await svc.start(owners[0]!, req({ expect: { checksum: 0x9999, mc7Length: 100 } }));
    expect(r).toMatchObject({ ok: false, reason: 'different' });
    expect((r as { error: string }).error).toContain('diverso');
    expect(await liveJobs()).toEqual([]);
    expect(names('create')).toHaveLength(0);
  });

  it('blocco assente → missing; CPU con tisV2 false → unsupported', async () => {
    const svc = newService();
    expect(await svc.start(owners[0]!, req({ number: 77 }))).toMatchObject({
      ok: false,
      reason: 'missing',
    });
    backend = world({ tisV2: false });
    expect(await svc.start(owners[0]!, req())).toMatchObject({ ok: false, reason: 'unsupported' });
  });

  it('30 righe con PDU 240 e maschera 0x03 → maxLines 24, job creato con 24 righe', async () => {
    const svc = newService();
    const r = await svc.start(owners[0]!, req({ offsets: evens(0, 58), saz: 60 }));
    expect(r).toMatchObject({ ok: true, maxLines: 24, pduLength: 240 });
    const created = names('create')[0]!.args[0] as { lines: unknown[] };
    expect(created.lines).toHaveLength(24);
    const res = await svc.read(owners[0]!);
    expect(res).toMatchObject({ ok: true, state: 'values' });
    if (res.ok && res.state === 'values') expect(res.lines).toHaveLength(24);
    await svc.stop(owners[0]!);
  });

  it('finestra tagliata: SAZ = inizio della prima riga scartata; la finestra uguale del renderer non ricrea il job', async () => {
    const svc = newService();
    await svc.start(owners[0]!, req({ offsets: evens(0, 58), saz: 60 }));
    expect(names('create')[0]!.args[1]).toBe(48);
    expect(svc.window(owners[0]!, req({ offsets: evens(0, 46), saz: 48 }))).toEqual({ ok: true });
    const res = await svc.read(owners[0]!);
    expect(res).toMatchObject({ ok: true, state: 'values' });
    expect(names('create')).toHaveLength(1);
    expect(names('delete')).toHaveLength(0);
    await svc.stop(owners[0]!);
  });

  it('start sovrapposte della stessa finestra: la superata non rilascia la CPU; una seconda finestra è busy', async () => {
    const svc = newService();
    const a1 = svc.start(owners[0]!, req());
    const a2 = svc.start(owners[0]!, req());
    const [r1, r2] = await Promise.all([a1, a2]);
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(true);
    expect(await svc.start(owners[1]!, req())).toMatchObject({ ok: false, reason: 'busy' });
    await svc.stopAll();
  });

  it('stop durante una start → la start è annullata e non lascia job né collegamenti', async () => {
    const svc = newService();
    const st = svc.start(owners[0]!, req());
    await svc.stop(owners[0]!);
    expect(await st).toMatchObject({ ok: false });
    expect(svc.active(owners[0]!)).toBe(false);
    expect(await liveJobs()).toEqual([]);
    expect(await svc.start(owners[1]!, req())).toMatchObject({ ok: true });
    await svc.stopAll();
  });

  it("stopForCpu: ferma l'osservazione di qualunque finestra sulla stessa CPU e cancella il job", async () => {
    const svc = newService();
    await svc.start(owners[0]!, req());
    expect(await liveJobs()).toHaveLength(1);
    await svc.stopForCpu(owners[0]!);
    expect(svc.active(owners[0]!)).toBe(false);
    expect(await liveJobs()).toEqual([]);
    expect(await svc.read(owners[0]!)).toMatchObject({
      ok: false,
      ended: true,
      error: expect.stringContaining('ripristino'),
    });
  });

  it("stopForCpu chiamato da un'altra finestra ferma l'osservazione viva della prima", async () => {
    access1 = access(103); // le due finestre sulla stessa CPU
    const svc = newService();
    await svc.start(owners[1]!, req());
    expect(svc.active(owners[1]!)).toBe(true);
    expect(await liveJobs()).toHaveLength(1);
    // il ripristino parte dalla finestra 0, l'osservazione è della finestra 1 sulla stessa CPU
    await svc.stopForCpu(owners[0]!);
    expect(svc.active(owners[1]!)).toBe(false);
    expect(await liveJobs()).toEqual([]);
    expect(await svc.read(owners[1]!)).toMatchObject({ ok: false, ended: true });
  });

  it('CPU in ripristino (blocked) → start rifiutata come busy, nessun job né collegamento', async () => {
    let restoring = true;
    const svc = newService({ blocked: () => restoring });
    const r = await svc.start(owners[0]!, req());
    expect(r).toMatchObject({ ok: false, reason: 'busy' });
    expect((r as { error: string }).error).toContain('Ripristino in corso');
    expect(connections).toHaveLength(0);
    expect(await liveJobs()).toEqual([]);
    restoring = false;
    expect(await svc.start(owners[0]!, req())).toMatchObject({ ok: true });
    await svc.stopAll();
  });

  it('un ripristino che parte durante start: nessun job creato; né ricreazione con blocked', async () => {
    let calls = 0;
    const svc = newService({ blocked: () => ++calls > 1 }); // la prima verifica passa, la seconda no
    const r = await svc.start(owners[0]!, req());
    expect(r).toMatchObject({ ok: false, reason: 'busy' });
    expect(await liveJobs()).toEqual([]);

    let restoring = false;
    const svc2 = newService({ blocked: () => restoring });
    await svc2.start(owners[0]!, req({ offsets: evens(0, 10), saz: 12 }));
    restoring = true;
    svc2.window(owners[0]!, req({ offsets: evens(20, 30), saz: 32 })); // vuole ricreare il job
    expect(await svc2.read(owners[0]!)).toMatchObject({ ok: false, ended: true });
    expect(await liveJobs()).toEqual([]);
    await svc2.stopAll();
  });

  it('stopAll con una create in volo (ricreazione dopo una nuova finestra) → job comunque cancellato', async () => {
    let creates = 0;
    const svc = newService({
      connect: async () => {
        const c = spy(await connectRaw());
        const create = c.createBlockStatus.bind(c);
        c.createBlockStatus = async (r, s) => {
          if (++creates === 2) await new Promise((res) => setTimeout(res, 300));
          return create(r, s);
        };
        connections.push(c);
        return c;
      },
    });
    await svc.start(owners[0]!, req({ offsets: evens(0, 10), saz: 12 }));
    svc.window(owners[0]!, req({ offsets: evens(20, 30), saz: 32 }));
    const reading = svc.read(owners[0]!);
    await new Promise((r) => setTimeout(r, 50)); // la seconda create è in volo
    expect(creates).toBe(2);
    const t = Date.now();
    await svc.stopAll();
    expect(Date.now() - t).toBeLessThan(2500);
    await reading;
    expect(await liveJobs()).toEqual([]);
    expect(svc.active(owners[0]!)).toBe(false);
  });

  it('0xD0CC con i valori (tisPartial) → values veri con partial true', async () => {
    backend = world({ faults: { tisPartial: true } });
    const svc = newService();
    await svc.start(owners[0]!, req());
    const res = await svc.read(owners[0]!);
    if (!res.ok || res.state !== 'values') throw new Error(JSON.stringify(res));
    expect(res.partial).toBe(true);
    expect(res.lines.map((l) => l.regs?.accu1)).toEqual([0, 2, 4]);
    await svc.stop(owners[0]!);
  });

  it('0xD081 alla creazione → state stop, osservazione ancora accesa', async () => {
    backend = world({ faults: { tisError: { sub: 0x13, code: 0xd081 } } });
    const svc = newService();
    expect(await svc.start(owners[0]!, req())).toMatchObject({ ok: true });
    expect(await svc.read(owners[0]!)).toEqual({ ok: true, state: 'stop' });
    expect(svc.active(owners[0]!)).toBe(true);
    await svc.stopAll();
  });

  it('il registro porta il numero di serie; cleanup con un altro numero di serie non tocca la CPU', async () => {
    expect(cpuKey(access(), 'S C-1')).toBe('192.0.2.10:102/0/2#S C-1');
    wantSerial = 'S C-ALTRO';
    jobs.add(cpuKey(access(), wantSerial), 0x13, 7);
    const svc = newService();
    await svc.cleanup(owners[0]!);
    expect(jobs.list(cpuKey(access(), wantSerial))).toEqual([{ fn: 0x13, job: 7 }]);
  });

  it('due read di fila → il secondo enable parte ≥ 250 ms dopo il primo (orologio iniettato)', async () => {
    const svc = newService({
      minEnableMs: 250,
      timers: {
        sleep: async (ms) => {
          clock += ms;
        },
      },
    });
    await svc.start(owners[0]!, req());
    await svc.read(owners[0]!);
    await svc.read(owners[0]!);
    const [a, b] = names('enable');
    expect(b!.at - a!.at).toBeGreaterThanOrEqual(250);
    await svc.stop(owners[0]!);
  });

  it("read durante un'altra read → waiting, un solo enable", async () => {
    const svc = newService();
    await svc.start(owners[0]!, req({ type: 'FC', number: 10 })); // FC mai chiamato: la prima read attende
    const first = svc.read(owners[0]!);
    const second = await svc.read(owners[0]!);
    expect(second).toEqual({ ok: true, state: 'waiting' });
    expect(await first).toEqual({ ok: true, state: 'waiting' });
    expect(names('enable')).toHaveLength(1);
    await svc.stop(owners[0]!);
  });

  it('FC mai chiamato → waiting dopo 2 s, nessun secondo enable', async () => {
    const svc = newService({ resultTimeoutMs: 100 });
    await svc.start(owners[0]!, req({ type: 'FC', number: 10 }));
    expect(await svc.read(owners[0]!)).toEqual({ ok: true, state: 'waiting' });
    expect(await svc.read(owners[0]!)).toEqual({ ok: true, state: 'waiting' });
    expect(names('enable')).toHaveLength(1);
    await svc.stop(owners[0]!);
  });

  it('enable scaduto → job cancellato e ricreato prima del prossimo enable (nessuna indication tardiva)', async () => {
    const svc = newService({ resultTimeoutMs: 400, enableLongMs: 60 });
    await svc.start(owners[0]!, req({ type: 'FC', number: 10 }));
    expect(await svc.read(owners[0]!)).toEqual({ ok: true, state: 'waiting' });
    expect(names('delete')).toHaveLength(1);
    expect(await liveJobs()).toEqual([]);
    await svc.read(owners[0]!);
    expect(names('create')).toHaveLength(2);
    expect(names('enable')).toHaveLength(2);
    await svc.stop(owners[0]!);
  });

  it('job cancellato con un enable in attesa, numero riusato dal nuovo job → il nuovo enable riceve i suoi valori', async () => {
    backend = world({ faults: { reuseJobId: true } });
    const orig = (
      backend as unknown as { blockStatus: (...a: unknown[]) => Promise<unknown> }
    ).blockStatus.bind(backend);
    let gate = false;
    (backend as unknown as { blockStatus: unknown }).blockStatus = (...a: unknown[]) =>
      gate ? orig(...a) : Promise.resolve(undefined);
    const svc = newService({ resultTimeoutMs: 100 });
    await svc.start(owners[0]!, req({ type: 'OB', number: 1 }));
    expect(await svc.read(owners[0]!)).toEqual({ ok: true, state: 'waiting' });
    gate = true;
    svc.window(owners[0]!, req({ offsets: [0, 2], saz: 6 }));
    const res = await svc.read(owners[0]!);
    if (!res.ok || res.state !== 'values') throw new Error(JSON.stringify(res));
    const created = names('create').length;
    expect(created).toBe(2);
    await svc.stop(owners[0]!);
  });

  it('CPU in STOP → state stop, job cancellato; di nuovo RUN → job ricreato e valori', async () => {
    const svc = newService();
    await svc.start(owners[0]!, req());
    mode = 'STOP';
    expect(await svc.read(owners[0]!)).toEqual({ ok: true, state: 'stop' });
    expect(await liveJobs()).toEqual([]);
    mode = 'RUN';
    const res = await svc.read(owners[0]!);
    expect(res).toMatchObject({ ok: true, state: 'values' });
    expect(await liveJobs()).toHaveLength(1);
    await svc.stop(owners[0]!);
  });

  it('stop → lista dei job vuota, collegamento chiuso, registro vuoto', async () => {
    const svc = newService();
    const key = cpuKey(access1);
    await svc.start(owners[0]!, req());
    expect(jobs.list(key)).toHaveLength(1);
    await svc.read(owners[0]!);
    await svc.stop(owners[0]!);
    expect(await liveJobs()).toEqual([]);
    expect(jobs.list(key)).toEqual([]);
    expect(svc.active(owners[0]!)).toBe(false);
    expect(names('delete')).toHaveLength(1);
  });

  it('window da [0..10] a [20..30] → delete, poi create con le nuove righe; tre window in 100 ms → un solo create', async () => {
    const svc = newService();
    await svc.start(owners[0]!, req({ offsets: evens(0, 10), saz: 12 }));
    expect(svc.window(owners[0]!, req({ offsets: evens(20, 30), saz: 32 }))).toEqual({ ok: true });
    svc.window(owners[0]!, req({ offsets: evens(20, 26), saz: 28 }));
    svc.window(owners[0]!, req({ offsets: evens(20, 30), saz: 32 }));
    const res = await svc.read(owners[0]!);
    if (!res.ok || res.state !== 'values') throw new Error(JSON.stringify(res));
    expect(res.lines.map((l) => l.offset)).toEqual(evens(20, 30));
    const order = calls
      .filter((c) => c.name === 'create' || c.name === 'delete')
      .map((c) => c.name);
    expect(order).toEqual(['create', 'delete', 'create']);
    await svc.stop(owners[0]!);
  });

  it('window per un altro blocco o con dati non validi → errore', async () => {
    const svc = newService();
    await svc.start(owners[0]!, req());
    expect(svc.window(owners[0]!, req({ number: 2 }))).toMatchObject({ ok: false });
    expect(svc.window(owners[0]!, { x: 1 })).toMatchObject({ ok: false });
    await svc.stop(owners[0]!);
    expect(svc.window(owners[0]!, req())).toMatchObject({ ok: false });
  });

  it('seconda finestra sulla stessa CPU → busy; dopo lo stop della prima si può', async () => {
    const svc = newService();
    access1 = access(103); // stessa CPU per entrambe le finestre
    expect(await svc.start(owners[0]!, req())).toMatchObject({ ok: true });
    const b = await svc.start(owners[1]!, req());
    expect(b).toMatchObject({ ok: false, reason: 'busy' });
    expect((b as { error: string }).error).toContain("in un'altra finestra");
    await svc.stop(owners[0]!);
    expect(await svc.start(owners[1]!, req())).toMatchObject({ ok: true });
    await svc.stopAll();
  });

  it('una nuova start della stessa finestra cancella il job vecchio', async () => {
    const svc = newService();
    await svc.start(owners[0]!, req());
    await svc.start(owners[0]!, req({ type: 'OB', number: 1, offsets: [0, 2], saz: 4 }));
    expect(await liveJobs()).toHaveLength(1);
    expect(connections).toHaveLength(2);
    await svc.stopAll();
  });

  it('onLinkEnd (offline) → job cancellato', async () => {
    const svc = newService();
    await svc.start(owners[0]!, req());
    for (const cb of [...(linkEnds.get(owners[0]!) ?? [])]) cb();
    await new Promise((r) => setTimeout(r, 20));
    expect(await liveJobs()).toEqual([]);
    expect(svc.active(owners[0]!)).toBe(false);
    expect(await svc.read(owners[0]!)).toMatchObject({ ok: false, ended: true });
  });

  it('finestra distrutta → job cancellato', async () => {
    const svc = newService();
    await svc.start(owners[0]!, req());
    owners[0]!.destroy();
    await new Promise((r) => setTimeout(r, 20));
    expect(await liveJobs()).toEqual([]);
  });

  it('renderer muto per 5 s → job cancellato', async () => {
    const svc = newService({ idleMs: 50 });
    await svc.start(owners[0]!, req());
    await new Promise((r) => setTimeout(r, 150));
    expect(await liveJobs()).toEqual([]);
    expect(svc.active(owners[0]!)).toBe(false);
  });

  it("stopAll all'uscita → ogni job cancellato entro 1 s", async () => {
    const svc = newService();
    await svc.start(owners[0]!, req());
    await svc.start(owners[1]!, req());
    const t = Date.now();
    await svc.stopAll();
    expect(Date.now() - t).toBeLessThan(1000);
    expect(await liveJobs()).toEqual([]);
  });

  it("0xD0C8 sull'enable → ended con «confrontarlo di nuovo»", async () => {
    backend = world({ faults: { tisError: { sub: 0x0e, code: 0xd0c8 } } });
    const svc = newService();
    await svc.start(owners[0]!, req());
    const r = await svc.read(owners[0]!);
    expect(r).toMatchObject({ ok: false, ended: true });
    expect((r as { error: string }).error).toContain('confrontarlo di nuovo');
    expect(await liveJobs()).toEqual([]);
  });

  it("0xD0A5 sull'enable → il job si ricrea alla read successiva", async () => {
    backend = world({ faults: { tisError: { sub: 0x0e, code: 0xd0a5 } } });
    const svc = newService();
    await svc.start(owners[0]!, req());
    expect(await svc.read(owners[0]!)).toEqual({ ok: true, state: 'waiting' });
    expect(names('create')).toHaveLength(1);
    await svc.read(owners[0]!);
    expect(names('create')).toHaveLength(2);
    await svc.stop(owners[0]!);
  });

  it('0xD0A1 alla creazione → protection', async () => {
    backend = world({ faults: { tisError: { sub: 0x13, code: 0xd0a1 } } });
    const svc = newService();
    expect(await svc.start(owners[0]!, req())).toMatchObject({ ok: false, reason: 'protection' });
  });

  it('risultato malformato (tisMalformed) → ended con esadecimale, nessuna eccezione', async () => {
    backend = world({ faults: { tisMalformed: [0x13] } });
    const svc = newService();
    const s = await svc.start(owners[0]!, req());
    if (!s.ok) {
      expect(s.error).toBeTruthy(); // il guasto può colpire già l'ack: nessuna eccezione
      return;
    }
    const r = await svc.read(owners[0]!);
    expect(r).toMatchObject({ ok: false, ended: true });
    expect((r as { error: string }).error).toMatch(/non riconosciuta|[0-9a-f]{2}/i);
  });

  it('orfani: job 0x13 registrato e presente → cancellato; non registrato → lasciato', async () => {
    backend = world({ faults: { orphanJobs: true } });
    const key = cpuKey(access1);
    const c = await connectRaw();
    const mine = await c.createBlockStatus(
      { type: 'OB', number: 1, initMask: 3, lines: [{ offset: 0, mask: 3 }] },
      4,
    );
    const theirs = await c.createBlockStatus(
      { type: 'OB', number: 1, initMask: 3, lines: [{ offset: 2, mask: 3 }] },
      4,
    );
    await c.close();
    jobs.add(key, 0x13, mine);
    const svc = newService();
    await svc.start(owners[0]!, req());
    const live = await liveJobs();
    expect(live).toContain(theirs);
    expect(live).not.toContain(mine);
    expect(jobs.list(key).some((j) => j.job === mine)).toBe(false);
    await svc.stopAll();
  });

  it('cleanup a ogni collegamento: cancella il job registrato, senza osservazione attiva', async () => {
    backend = world({ faults: { orphanJobs: true } });
    const key = cpuKey(access1);
    const c = await connectRaw();
    const mine = await c.createBlockStatus(
      { type: 'OB', number: 1, initMask: 3, lines: [{ offset: 0, mask: 3 }] },
      4,
    );
    await c.close();
    jobs.add(key, 0x13, mine);
    const svc = newService();
    await svc.cleanup(owners[0]!);
    expect(await liveJobs()).toEqual([]);
    expect(jobs.list(key)).toEqual([]);
  });

  it("orfano di un'altra connessione → 0xD0AE, voce tolta, job lasciato", async () => {
    const key = cpuKey(access1);
    const other = await connectRaw();
    const theirs = await other.createBlockStatus(
      { type: 'OB', number: 1, initMask: 3, lines: [{ offset: 0, mask: 3 }] },
      4,
    );
    jobs.add(key, 0x13, theirs);
    const svc = newService();
    await svc.start(owners[0]!, req());
    expect(jobs.list(key).some((j) => j.job === theirs)).toBe(false);
    expect(await liveJobs()).toContain(theirs);
    await svc.stopAll();
    await other.close();
  });
});

describe('parseStatusRequest', () => {
  it.each([
    ['offset dispari', req({ offsets: [0, 3] })],
    ['offset decrescenti', req({ offsets: [4, 2] })],
    ['offset ≥ saz', req({ offsets: [0, 10], saz: 10 })],
    ['maschera 0x10', req({ mask: 0x10 })],
    ['maschera senza STW', req({ mask: 0x02 })],
    ['65 righe', req({ offsets: evens(0, 128), saz: 130 })],
    ['nessuna riga', req({ offsets: [] })],
    ['saz oltre la lunghezza MC7', req({ saz: 101 })],
  ])('%s → errore', (_n, r) => {
    expect(typeof parseStatusRequest(r)).toBe('string');
  });

  it('richiesta valida → uguale; 64 righe ammesse', () => {
    expect(parseStatusRequest(req())).toEqual(req());
    expect(
      parseStatusRequest(
        req({ offsets: evens(0, 126), saz: 128, expect: { checksum: 1, mc7Length: 200 } }),
      ),
    ).not.toBeTypeOf('string');
    expect(typeof parseStatusRequest(null)).toBe('string');
  });

  it('un errore non apre nessun collegamento', async () => {
    let opened = 0;
    const svc = new BlockStatusService({
      service: { target: () => undefined, modeOf: () => 'RUN', onLinkEnd: () => () => undefined },
      jobs: memoryJobStore(),
      connect: async () => {
        opened++;
        throw new Error('no');
      },
    });
    const r = await svc.start(new FakeOwner(), req({ mask: 0x10 }));
    expect(r).toMatchObject({ ok: false, reason: 'error' });
    expect(opened).toBe(0);
  });
});
