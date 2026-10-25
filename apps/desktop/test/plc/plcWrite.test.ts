import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectTcp } from '@baaportal/s7comm/node';
import { compileBlock, type CompileInput } from '@baaportal/mc7';
import { listen, type ListeningCpu } from '@baaportal/s7-server/node';
import { SimCpu, simBackend } from '@baaportal/sim';
import type { PlcAccess } from '@baaportal/ui';
import type { ConfirmFn, WriteConfirmTexts } from '../../src/main/plc/confirm';
import { createConfirm } from '../../src/main/plc/confirm';
import { PlcService } from '../../src/main/plc/plcService';
import {
  PlcWriteService,
  parseDownloadRequest,
  type PlcWriteOwner,
  type WriteClient,
} from '../../src/main/plc/plcWrite';

class FakeOwner implements PlcWriteOwner {
  sent: { channel: string; payload: unknown }[] = [];
  private destroyed = false;
  private listeners = new Set<() => void>();
  isDestroyed(): boolean {
    return this.destroyed;
  }
  send(channel: string, payload: unknown): void {
    if (this.destroyed) throw new Error('inviato a una finestra distrutta');
    this.sent.push({ channel, payload });
  }
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

const PROPS = {
  maxCycleMs: 150,
  minCycleMs: 0,
  clockMemory: { enabled: false, byte: 0 },
  retentivity: { mBytes: 16, timers: 0, counters: 8 },
  cyclicInterruptMs: 0,
};

type Sections = CompileInput['sections'];
const EMPTY: Sections = { in: [], out: [], inOut: [], stat: [], temp: [], ret: [] };
const NOW = new Date(2026, 9, 20, 10, 30, 15, 250);

function compile(kind: 'OB' | 'FC' | 'FB', number: number): Uint8Array {
  const ctx = {
    owner: {
      kind,
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
    now: NOW,
    header: { author: 'Diego', family: 'Prove', name: 'Blocco', version: '0.1' },
    knowHowProtected: false,
    sections: EMPTY,
    initials: {},
    networks: ['\tA %I0.0;\n\t= %Q0.0;'],
    ctx,
    kind,
    number,
  });
  if (!r.file) throw new Error('compilazione fallita');
  return r.file;
}

const waitFor = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condizione non raggiunta');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('PlcWriteService contro il PLC di prova', () => {
  let cpu: SimCpu;
  let plc: ListeningCpu;
  let service: PlcService;
  let owner: FakeOwner;
  let confirm: ReturnType<typeof vi.fn<ConfirmFn>>;
  let writes: PlcWriteService;
  let opened: number;
  const access = (): PlcAccess => ({
    host: '127.0.0.1',
    port: plc.port,
    rack: 0,
    slot: 2,
    connectionType: 'PG',
  });
  const hasBlock = async (type: 'OB' | 'FC' | 'FB', n: number): Promise<boolean> => {
    const c = await connectTcp({
      host: '127.0.0.1',
      port: plc.port,
      rack: 0,
      slot: 2,
      timeoutMs: 2000,
    });
    try {
      await c.upload(type, n);
      return true;
    } catch {
      return false;
    } finally {
      await c.close();
    }
  };

  beforeEach(async () => {
    cpu = new SimCpu({ cpuTypeId: 'cpu-315-2-pn-dp', props: PROPS });
    cpu.run();
    plc = await listen(simBackend(cpu), { port: 0 });
    service = new PlcService({ intervalMs: 1000 });
    owner = new FakeOwner();
    confirm = vi.fn<ConfirmFn>(async () => true);
    opened = 0;
    writes = new PlcWriteService({
      service,
      confirm,
      connect: async (o) => {
        opened++;
        const { connectWriteTcp } = await import('@baaportal/s7comm/node');
        return connectWriteTcp(o);
      },
    });
    expect((await service.connect(owner, access())).ok).toBe(true);
  });
  afterEach(async () => {
    await service.closeAll();
    await plc.close();
  });

  it('senza conferma non si apre nessun collegamento', async () => {
    confirm.mockResolvedValue(false);
    const d = await writes.download(owner, [compile('FC', 7)]);
    expect(d).toEqual({ ok: false, cancelled: true });
    const c = await writes.control(owner, 'STOP');
    expect(c).toEqual({ ok: false, cancelled: true });
    expect(opened).toBe(0);
    expect(cpu.mode).toBe('RUN');
  });

  it('download: i blocchi arrivano e la CPU li ha; avanzamento finale inviato', async () => {
    const r = await writes.download(owner, [compile('FC', 7), compile('OB', 1)]);
    expect(r).toEqual({ ok: true, loaded: ['FC7', 'OB1'] });
    expect(await hasBlock('FC', 7)).toBe(true);
    expect(await hasBlock('OB', 1)).toBe(true);
    const last = owner.sent.at(-1)!;
    expect(last.channel).toBe('plc:writeProgress');
    expect(last.payload).toEqual({ done: 2, total: 2, current: 'OB1' });
  });

  it('download con deleteBlocks: prima cancella, poi carica', async () => {
    await writes.download(owner, [compile('FC', 9)]);
    expect(await hasBlock('FC', 9)).toBe(true);
    const r = await writes.download(owner, [compile('FC', 7)], {
      deleteBlocks: [{ type: 'FC', number: 9 }],
    });
    expect(r).toEqual({ ok: true, loaded: ['FC7'] });
    expect(await hasBlock('FC', 9)).toBe(false);
    expect(await hasBlock('FC', 7)).toBe(true);
  });

  it('il testo della conferma nomina modulo e indirizzo, e i blocchi', async () => {
    await writes.download(owner, [compile('FC', 7)], { deleteBlocks: [{ type: 'DB', number: 3 }] });
    const t = confirm.mock.calls[0]![1] as WriteConfirmTexts;
    expect(t.message).toContain('127.0.0.1');
    expect(t.message).toMatch(/CPU 315|6ES7/);
    expect(t.detail).toContain('Cancella DB3');
    expect(t.detail).toContain('Carica FC7');
  });

  it('RUN e STOP', async () => {
    expect(await writes.control(owner, 'STOP')).toMatchObject({ ok: true });
    await waitFor(() => cpu.mode === 'STOP');
    expect(await writes.control(owner, 'RUN')).toMatchObject({ ok: true });
    await waitFor(() => cpu.mode === 'RUN');
  });

  it('COPY_RAM_TO_ROM e COMPRESS', async () => {
    expect(await writes.control(owner, 'COPY_RAM_TO_ROM')).toEqual({ ok: true, result: 'ok' });
    expect(await writes.control(owner, 'COMPRESS')).toEqual({ ok: true, result: 'ok' });
  });

  it('senza collegamento online → errore, senza chiedere conferma', async () => {
    await service.disconnect(owner);
    expect(await writes.control(owner, 'STOP')).toEqual({
      ok: false,
      error: 'Nessun collegamento online',
    });
    expect(await writes.download(owner, [compile('FC', 7)])).toMatchObject({
      ok: false,
      error: 'Nessun collegamento online',
    });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('seconda richiesta durante la prima → già in corso', async () => {
    let release!: (v: boolean) => void;
    confirm.mockImplementationOnce(() => new Promise<boolean>((r) => (release = r)));
    const first = writes.control(owner, 'STOP');
    await waitFor(() => confirm.mock.calls.length === 1);
    expect(await writes.control(owner, 'RUN')).toEqual({
      ok: false,
      error: 'Operazione già in corso',
    });
    expect(await writes.download(owner, [compile('FC', 7)])).toMatchObject({
      ok: false,
      error: 'Operazione già in corso',
    });
    release(true);
    expect(await first).toMatchObject({ ok: true });
    // finita la prima, se ne può fare un'altra
    expect(await writes.control(owner, 'RUN')).toMatchObject({ ok: true });
  });

  it('file non valido o troppi file: errore prima di ogni conferma', async () => {
    expect(await writes.download(owner, [new Uint8Array(10)])).toMatchObject({ ok: false });
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('PlcWriteService con collegamento finto', () => {
  const target = {
    access: { host: '192.0.2.10', rack: 0, slot: 2, connectionType: 'PG' as const },
    identity: { orderNumber: '6ES7 315-2EH14-0AB0', moduleName: 'CPU 315-2 PN/DP' },
  };
  const svc = { target: () => target };
  const FILES = [compile('FC', 1), compile('FC', 2), compile('FC', 3)];

  function fake(failOn?: number) {
    const log: string[] = [];
    const client: WriteClient = {
      close: vi.fn(async () => {
        log.push('close');
      }),
      downloadBlock: vi.fn(async () => {
        log.push('dl');
        if (log.filter((x) => x === 'dl').length === failOn) throw new Error('la CPU rifiuta');
      }),
      deleteBlock: vi.fn(async (t, n) => {
        log.push(`del ${t}${n}`);
      }),
      stop: vi.fn(),
      start: vi.fn(),
      copyRamToRom: vi.fn(),
      compressMemory: vi.fn(),
    };
    return { client, log };
  }

  it('errore al secondo blocco: loaded = [primo], failedAt = secondo, collegamento chiuso', async () => {
    const { client, log } = fake(2);
    const w = new PlcWriteService({
      service: svc,
      confirm: async () => true,
      connect: async () => client,
    });
    const r = await w.download(new FakeOwner(), FILES);
    expect(r).toEqual({ ok: false, loaded: ['FC1'], failedAt: 'FC2', error: 'la CPU rifiuta' });
    expect(log.filter((x) => x === 'dl')).toHaveLength(2); // si ferma, il terzo non parte
    expect(log.at(-1)).toBe('close');
  });

  it("prima le cancellazioni, poi i file nell'ordine ricevuto", async () => {
    const { client, log } = fake();
    const w = new PlcWriteService({
      service: svc,
      confirm: async () => true,
      connect: async () => client,
    });
    await w.download(new FakeOwner(), FILES, { deleteBlocks: [{ type: 'OB', number: 5 }] });
    expect(log).toEqual(['del OB5', 'dl', 'dl', 'dl', 'close']);
    const order = (client.downloadBlock as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(order).toEqual(FILES);
  });

  it('finestra distrutta: interrompe prima del blocco successivo e chiude', async () => {
    const o = new FakeOwner();
    const { client, log } = fake();
    (client.downloadBlock as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      log.push('dl');
      o.destroy();
    });
    const w = new PlcWriteService({
      service: svc,
      confirm: async () => true,
      connect: async () => client,
    });
    const r = await w.download(o, FILES);
    expect(r).toMatchObject({ ok: false, loaded: ['FC1'], failedAt: 'FC2' });
    expect(log).toEqual(['dl', 'close']);
  });

  it("avanzamento: al massimo 10 al secondo, più l'ultimo", async () => {
    const o = new FakeOwner();
    const { client } = fake();
    let t = 0;
    const w = new PlcWriteService({
      service: svc,
      confirm: async () => true,
      connect: async () => client,
      now: () => (t += 10),
    });
    await w.download(o, FILES);
    expect(o.sent.map((s) => (s.payload as { done: number }).done)).toEqual([1, 3]);
  });

  it('collegamento non riuscito → errore leggibile, nessun blocco', async () => {
    const w = new PlcWriteService({
      service: svc,
      confirm: async () => true,
      connect: async () => {
        throw new Error('boom');
      },
    });
    const r = await w.download(new FakeOwner(), FILES);
    expect(r).toMatchObject({ ok: false, loaded: [] });
  });

  it('la conferma elenca al massimo 20 righe poi «… e altri N»', async () => {
    const { client } = fake();
    const texts: WriteConfirmTexts[] = [];
    const w = new PlcWriteService({
      service: svc,
      confirm: async (...[, t]) => {
        texts.push(t);
        return false;
      },
      connect: async () => client,
    });
    const many = Array.from({ length: 25 }, () => FILES[0]!);
    await w.download(new FakeOwner(), many);
    expect(texts[0]!.detail).toContain('… e altri 5');
    expect(texts[0]!.detail.split('\n').filter((l) => l.startsWith('Carica'))).toHaveLength(20);
  });
});

describe('parseDownloadRequest', () => {
  it('accetta il caso normale', () => {
    expect(
      parseDownloadRequest([new Uint8Array(4)], { deleteBlocks: [{ type: 'FB', number: 65535 }] }),
    ).toMatchObject({
      deleteBlocks: [{ type: 'FB', number: 65535 }],
    });
  });
  it('rifiuta troppi file, file grandi, tipi e numeri non ammessi', () => {
    expect(typeof parseDownloadRequest(new Array(2049).fill(new Uint8Array(1)), {})).toBe('string');
    expect(typeof parseDownloadRequest([new Uint8Array(1024 * 1024 + 1)], {})).toBe('string');
    expect(typeof parseDownloadRequest(['x'], {})).toBe('string');
    expect(typeof parseDownloadRequest([], { deleteBlocks: [{ type: 'SDB', number: 1 }] })).toBe(
      'string',
    );
    expect(typeof parseDownloadRequest([], { deleteBlocks: [{ type: 'DB', number: 65536 }] })).toBe(
      'string',
    );
    expect(typeof parseDownloadRequest([], { deleteBlocks: [{ type: 'DB', number: -1 }] })).toBe(
      'string',
    );
    expect(typeof parseDownloadRequest([], { deleteBlocks: 'x' })).toBe('string');
  });
});

describe('createConfirm', () => {
  it('«Annulla» è predefinito e di fuga; solo il primo pulsante conferma', async () => {
    const show = vi.fn(async (...args: unknown[]) => ({ response: args.length * 0 }));
    const c = createConfirm({ showMessageBox: show } as never, () => null);
    expect(await c(null, { title: 't', message: 'm', detail: 'd', confirmLabel: 'Carica' })).toBe(
      true,
    );
    expect(show.mock.calls[0]![0]).toMatchObject({
      buttons: ['Carica', 'Annulla'],
      defaultId: 1,
      cancelId: 1,
      type: 'warning',
      noLink: true,
    });
    show.mockResolvedValueOnce({ response: 1 });
    expect(await c(null, { title: 't', message: 'm', detail: 'd', confirmLabel: 'Carica' })).toBe(
      false,
    );
  });
});
