import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const electronApp = vi.hoisted(() => ({ isPackaged: false }));
vi.mock('electron', () => ({ app: electronApp }));
import { connectTcp } from '@baaportal/s7comm/node';
import { compileBlock, type CompileInput } from '@baaportal/mc7';
import { listen, type ListeningCpu } from '@baaportal/s7-server/node';
import { SimCpu, simBackend } from '@baaportal/sim';
import type { PlcAccess } from '@baaportal/ui';
import type { ConfirmFn, WriteConfirmTexts } from '../../src/main/plc/confirm';
import { registerPlc } from '../../src/main/plc/plcIpc';
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
    expect(r).toEqual({ ok: true, loaded: ['FC7', 'OB1'], deleted: [] });
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
    expect(r).toEqual({ ok: true, loaded: ['FC7'], deleted: ['FC9'] });
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

  it('collegamento perso mentre la conferma è aperta: nessuna scrittura', async () => {
    confirm.mockImplementationOnce(async () => {
      await service.disconnect(owner);
      return true;
    });
    expect(await writes.control(owner, 'STOP')).toMatchObject({ ok: false });
    expect(opened).toBe(0);
    expect(cpu.mode).toBe('RUN');
  });

  it('riconnessione (altro collegamento) mentre la conferma è aperta: annullato', async () => {
    confirm.mockImplementationOnce(async () => {
      await service.connect(owner, access()); // un altro collegamento, anche se allo stesso indirizzo
      return true;
    });
    expect(await writes.control(owner, 'STOP')).toEqual({
      ok: false,
      error: 'Collegamento online cambiato: operazione annullata',
    });
    expect(opened).toBe(0);
    expect(cpu.mode).toBe('RUN');
  });

  it('file non valido o troppi file: errore prima di ogni conferma', async () => {
    expect(await writes.download(owner, [new Uint8Array(10)])).toMatchObject({ ok: false });
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('PlcWriteService con collegamento finto', () => {
  const target = {
    access: { host: '192.0.2.10', rack: 0, slot: 2, connectionType: 'PG' as const },
    identity: {
      orderNumber: '6ES7 315-2EH14-0AB0',
      moduleName: 'CPU 315-2 PN/DP',
      serial: 'S C-ABC',
    },
    linkId: 1,
  };
  const svc = { target: () => target };
  const ID = { orderNumber: '6ES7 315-2EH14-0AB0', serialNumber: 'S C-ABC' };
  const FILES = [compile('FC', 1), compile('FC', 2), compile('FC', 3)];

  function fake(failOn?: number, id: Record<string, string> = ID, failDelete = false) {
    const log: string[] = [];
    const client: WriteClient = {
      close: vi.fn(async () => {
        log.push('close');
      }),
      downloadBlock: vi.fn(async () => {
        log.push('dl');
        if (log.filter((x) => x === 'dl').length === failOn) throw new Error('la CPU rifiuta');
      }),
      identity: vi.fn(async () => id as never),
      deleteBlock: vi.fn(async (t, n) => {
        log.push(`del ${t}${n}`);
        if (failDelete) throw new Error('cancellazione rifiutata');
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
    expect(r).toEqual({
      ok: false,
      loaded: ['FC1'],
      deleted: [],
      failedAt: 'FC2',
      error: 'la CPU rifiuta',
    });
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
    expect(r).toMatchObject({
      ok: false,
      loaded: ['FC1'],
      error: expect.stringContaining('interrotto prima di FC2'),
    });
    expect(r).not.toHaveProperty('failedAt');
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

const WIN = { isDestroyed: () => false } as never;

describe('createConfirm', () => {
  it('«Annulla» è predefinito e di fuga; solo il primo pulsante conferma', async () => {
    const show = vi.fn(async (...args: unknown[]) => ({ response: args.length * 0 }));
    const c = createConfirm({ showMessageBox: show } as never, () => WIN);
    expect(await c(null, { title: 't', message: 'm', detail: 'd', confirmLabel: 'Carica' })).toBe(
      true,
    );
    expect(show.mock.calls[0]![1]).toMatchObject({
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

describe('createConfirm: aggancio e2e', () => {
  const t = { title: 't', message: 'm', detail: 'd', confirmLabel: 'Carica' };
  afterEach(() => {
    delete process.env['BAAPORTAL_E2E_CONFIRM'];
    electronApp.isPackaged = false;
  });

  it('non impacchettata: yes e no rispondono senza mostrare la finestra', async () => {
    const show = vi.fn(async () => ({ response: 0 }));
    const c = createConfirm({ showMessageBox: show } as never, () => WIN);
    process.env['BAAPORTAL_E2E_CONFIRM'] = 'yes';
    expect(await c(null, t)).toBe(true);
    process.env['BAAPORTAL_E2E_CONFIRM'] = 'no';
    expect(await c(null, t)).toBe(false);
    expect(show).not.toHaveBeenCalled();
  });

  it('un altro valore non è un aggancio: la finestra si mostra', async () => {
    const show = vi.fn(async () => ({ response: 1 }));
    const c = createConfirm({ showMessageBox: show } as never, () => WIN);
    process.env['BAAPORTAL_E2E_CONFIRM'] = 'si';
    expect(await c(null, t)).toBe(false);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('impacchettata: la variabile è ignorata e la finestra si mostra', async () => {
    electronApp.isPackaged = true;
    const show = vi.fn(async () => ({ response: 1 }));
    const c = createConfirm({ showMessageBox: show } as never, () => WIN);
    process.env['BAAPORTAL_E2E_CONFIRM'] = 'yes';
    expect(await c(null, t)).toBe(false);
    expect(show).toHaveBeenCalledTimes(1);
  });
});

describe('createConfirm senza finestra', () => {
  it('finestra assente o distrutta: rifiuta senza mostrare nulla', async () => {
    const show = vi.fn();
    const t = { title: 't', message: 'm', detail: 'd', confirmLabel: 'Carica' };
    await expect(
      createConfirm({ showMessageBox: show } as never, () => null)(null, t),
    ).rejects.toThrow();
    const dead = { isDestroyed: () => true } as never;
    await expect(
      createConfirm({ showMessageBox: show } as never, () => dead)(null, t),
    ).rejects.toThrow();
    expect(show).not.toHaveBeenCalled();
  });
});

describe('PlcWriteService: sicurezza del bersaglio e uscita', () => {
  const mk = (linkId = { v: 1 }) => ({
    access: { host: '192.0.2.10', rack: 0, slot: 2, connectionType: 'PG' as const },
    identity: { orderNumber: '6ES7 315-2EH14-0AB0', serial: 'S C-ABC' },
    linkId: linkId.v,
  });
  const client = (
    over: Partial<WriteClient> = {},
    id: Record<string, string> = { orderNumber: '6ES7 315-2EH14-0AB0', serialNumber: 'S C-ABC' },
  ) => {
    const log: string[] = [];
    const c: WriteClient = {
      close: vi.fn(async () => void log.push('close')),
      identity: vi.fn(async () => id as never),
      downloadBlock: vi.fn(async () => void log.push('dl')),
      deleteBlock: vi.fn(async (t, n) => void log.push(`del ${t}${n}`)),
      stop: vi.fn(),
      start: vi.fn(),
      copyRamToRom: vi.fn(),
      compressMemory: vi.fn(),
      ...over,
    };
    return { c, log };
  };
  const F = [compile('FC', 1), compile('FC', 2)];

  it('collegamento perso mentre la finestra è aperta: nessuna scrittura', async () => {
    const link = { v: 1 };
    const t = mk(link);
    let current: ReturnType<typeof mk> | undefined = t;
    const connect = vi.fn();
    const w = new PlcWriteService({
      service: { target: () => current },
      confirm: async () => {
        current = undefined;
        return true;
      },
      connect,
    });
    expect(await w.control(new FakeOwner(), 'STOP')).toMatchObject({ ok: false });
    expect(connect).not.toHaveBeenCalled();
  });

  it('riconnessione (altro collegamento) durante la conferma: annullato', async () => {
    const link = { v: 1 };
    const connect = vi.fn();
    const w = new PlcWriteService({
      service: { target: () => mk(link) },
      confirm: async () => {
        link.v = 2;
        return true;
      },
      connect,
    });
    expect(await w.download(new FakeOwner(), F)).toEqual({
      ok: false,
      loaded: [],
      deleted: [],
      error: 'Collegamento online cambiato: operazione annullata',
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it('identità diversa dalla confermata: chiude e non scrive', async () => {
    for (const id of [
      { orderNumber: '6ES7 999-0AA00-0AA0', serialNumber: 'S C-ABC' },
      { orderNumber: '6ES7 315-2EH14-0AB0', serialNumber: 'S C-ZZZ' },
    ]) {
      const { c, log } = client({}, id);
      const w = new PlcWriteService({
        service: { target: () => mk() },
        confirm: async () => true,
        connect: async () => c,
      });
      const r = await w.download(new FakeOwner(), F);
      expect(r).toMatchObject({ ok: false, loaded: [] });
      expect(log).toEqual(['close']);
      const k = await w.control(new FakeOwner(), 'STOP');
      expect(k).toMatchObject({ ok: false });
      expect(c.stop).not.toHaveBeenCalled();
    }
  });

  it('cancellazione fallita: deleted riporta quelle già fatte', async () => {
    let n = 0;
    const { c } = client({
      deleteBlock: vi.fn(async () => {
        if (++n === 2) throw new Error('rifiutata');
      }),
    });
    const w = new PlcWriteService({
      service: { target: () => mk() },
      confirm: async () => true,
      connect: async () => c,
    });
    const r = await w.download(new FakeOwner(), F, {
      deleteBlocks: [
        { type: 'OB', number: 1 },
        { type: 'FC', number: 2 },
      ],
    });
    expect(r).toEqual({
      ok: false,
      loaded: [],
      deleted: ['OB1'],
      failedAt: 'FC2',
      error: 'rifiutata',
    });
  });

  it('tipi non ammessi (SFC, SDB) rifiutati con il nome prima della conferma', async () => {
    const confirm = vi.fn(async () => true);
    const w = new PlcWriteService({ service: { target: () => mk() }, confirm });
    // SFC1: stesso file di un FC con il codice tipo cambiato (byte 5 = 0x? vedi blockTypeCode)
    const f = compile('FC', 1).slice();
    f[5] = 0x0d; // SFC
    const r = await w.download(new FakeOwner(), [f]);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('SFC1') });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('control: finestra distrutta durante la conferma, nessun collegamento', async () => {
    const o = new FakeOwner();
    const connect = vi.fn();
    const w = new PlcWriteService({
      service: { target: () => mk() },
      confirm: async () => {
        o.destroy();
        return true;
      },
      connect,
    });
    expect(await w.control(o, 'STOP')).toMatchObject({ ok: false });
    expect(connect).not.toHaveBeenCalled();
  });

  it('conferma che lancia: errore leggibile, niente collegamento, si può riprovare', async () => {
    const connect = vi.fn();
    let boom = true;
    const w = new PlcWriteService({
      service: { target: () => mk() },
      confirm: async () => {
        if (boom) throw new Error('finestra non disponibile');
        return false;
      },
      connect,
    });
    expect(await w.control(new FakeOwner(), 'STOP')).toEqual({
      ok: false,
      error: 'finestra non disponibile',
    });
    boom = false;
    const o = new FakeOwner();
    expect(await w.control(o, 'STOP')).toEqual({ ok: false, cancelled: true });
    expect(connect).not.toHaveBeenCalled();
  });

  it('abortAll alla conferma, poi «Sì»: nessun collegamento, cancelled; dopo, «Chiusura in corso»', async () => {
    const connect = vi.fn();
    let release!: (v: boolean) => void;
    const w = new PlcWriteService({
      service: { target: () => mk() },
      confirm: () => new Promise<boolean>((r) => (release = r)),
      connect,
    });
    const first = w.control(new FakeOwner(), 'STOP');
    await Promise.resolve();
    await w.abortAll();
    release(true);
    expect(await first).toEqual({ ok: false, cancelled: true });
    expect(connect).not.toHaveBeenCalled();
    expect(await w.control(new FakeOwner(), 'RUN')).toEqual({
      ok: false,
      error: 'Chiusura in corso',
    });
    expect(await w.download(new FakeOwner(), F)).toMatchObject({
      ok: false,
      error: 'Chiusura in corso',
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it('abortAll durante un download: si ferma prima del blocco successivo, chiude e riporta', async () => {
    const { c, log } = client();
    const o = new FakeOwner();
    let aborting: Promise<void> | undefined;
    const w: PlcWriteService = new PlcWriteService({
      service: { target: () => mk() },
      confirm: async () => true,
      connect: async () => c,
    });
    (c.downloadBlock as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      log.push('dl');
      aborting = w.abortAll();
    });
    expect(w.writing()).toBe(false);
    const r = await w.download(o, F, { deleteBlocks: [{ type: 'OB', number: 5 }] });
    await aborting;
    expect(r).toMatchObject({
      ok: false,
      deleted: ['OB5'],
      loaded: ['FC1'],
      error: expect.stringContaining('interrotto prima di FC2'),
    });
    expect(log).toEqual(['del OB5', 'dl', 'close']);
    expect(w.writing()).toBe(false);
  });
});

describe('registerPlc: canali di scrittura', () => {
  type H = (e: unknown, ...a: unknown[]) => Promise<unknown>;
  const setup = (confirm: ConfirmFn) => {
    const handlers = new Map<string, H>();
    const connect = vi.fn();
    const target = {
      access: { host: '192.0.2.10', rack: 0, slot: 2, connectionType: 'PG' as const },
      identity: { orderNumber: '6ES7 315-2EH14-0AB0' },
      linkId: 1,
    };
    const service = new PlcService();
    const writes = new PlcWriteService({ service: { target: () => target }, confirm, connect });
    registerPlc((ch, l) => handlers.set(ch, l as H), confirm, service, undefined, writes);
    return { handlers, connect };
  };

  it('chiamato direttamente chiede comunque la conferma; con «Annulla» non apre nulla', async () => {
    const confirm = vi.fn<ConfirmFn>(async () => false);
    const { handlers, connect } = setup(confirm);
    const e = { sender: new FakeOwner() };
    expect(await handlers.get('plc:download')!(e, [compile('FC', 1)], {})).toEqual({
      ok: false,
      cancelled: true,
    });
    expect(await handlers.get('plc:control')!(e, 'STOP')).toEqual({ ok: false, cancelled: true });
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(connect).not.toHaveBeenCalled();
  });

  it('dati non validi dal renderer: errore senza conferma', async () => {
    const confirm = vi.fn<ConfirmFn>(async () => true);
    const { handlers } = setup(confirm);
    const e = { sender: new FakeOwner() };
    expect(await handlers.get('plc:download')!(e, 'x', {})).toMatchObject({ ok: false });
    expect(await handlers.get('plc:control')!(e, 'MRES')).toMatchObject({ ok: false });
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('PlcWriteService: una scrittura per CPU fra tutte le finestre', () => {
  const target = (host = '192.0.2.10', slot = 2) => ({
    access: { host, rack: 0, slot, connectionType: 'PG' as const },
    identity: { orderNumber: '6ES7 315-2EH14-0AB0' },
    linkId: 1,
  });

  it("la seconda finestra sulla stessa CPU è rifiutata; un'altra CPU o a fine operazione no", async () => {
    const a = new FakeOwner();
    const b = new FakeOwner();
    const c = new FakeOwner();
    const targets = new Map<unknown, ReturnType<typeof target>>([
      [a, target()],
      [b, target('192.0.2.10')],
      [c, target('192.0.2.11')],
    ]);
    const releases: ((v: boolean) => void)[] = [];
    const confirm = vi.fn<ConfirmFn>(() => new Promise<boolean>((r) => releases.push(r)));
    const writes = new PlcWriteService({
      service: { target: (o) => targets.get(o) },
      confirm,
    });
    const first = writes.control(a, 'STOP');
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(await writes.control(b, 'RUN')).toEqual({
      ok: false,
      error: 'Operazione già in corso su questa CPU',
    });
    expect(await writes.download(b, [compile('FC', 1)])).toMatchObject({
      ok: false,
      error: 'Operazione già in corso su questa CPU',
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    // Un'altra CPU non è bloccata.
    const other = writes.control(c, 'RUN');
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    releases.forEach((r) => r(false));
    await first;
    await other;
    // Finita la prima, la CPU è libera.
    const again = writes.control(b, 'RUN');
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(3));
    releases[2]!(false);
    expect(await again).toEqual({ ok: false, cancelled: true });
  });
});

describe('parseDownloadRequest: dimensione complessiva', () => {
  it('oltre 32 MB in totale è rifiutato', () => {
    const f = new Uint8Array(1024 * 1024);
    expect(typeof parseDownloadRequest(new Array(33).fill(f), {})).toBe('string');
    expect(typeof parseDownloadRequest(new Array(32).fill(f), {})).not.toBe('string');
  });
});
