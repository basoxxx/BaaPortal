import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const electronApp = vi.hoisted(() => ({ isPackaged: false }));
vi.mock('electron', () => ({ app: electronApp }));
import { listen, type ListeningCpu } from '@baaportal/s7-server/node';
import { SimCpu, simBackend } from '@baaportal/sim';
import type { PlcAccess, PlcClockRequest } from '@baaportal/ui';
import type { ConfirmFn, WriteConfirmTexts } from '../../src/main/plc/confirm';
import { readDiagnostics } from '../../src/main/plc/diagnostics';
import { PlcService, type PlcOwner } from '../../src/main/plc/plcService';
import { PlcWriteService, type PlcWriteOwner, type WriteClient } from '../../src/main/plc/plcWrite';

class FakeOwner implements PlcWriteOwner {
  private listeners = new Set<() => void>();
  isDestroyed(): boolean {
    return false;
  }
  send(): void {}
  once(_e: 'destroyed', cb: () => void): void {
    this.listeners.add(cb);
  }
  removeListener(_e: 'destroyed', cb: () => void): void {
    this.listeners.delete(cb);
  }
}

const target = {
  access: { host: '192.0.2.10', rack: 0, slot: 2, connectionType: 'PG' as const },
  identity: {
    orderNumber: '6ES7 315-2EH14-0AB0',
    moduleName: 'CPU 315-2 PN/DP',
    serial: 'S C-ABC',
  },
  linkId: 1,
};
const ID = { orderNumber: '6ES7 315-2EH14-0AB0', serialNumber: 'S C-ABC' };
const MANUAL = (time: Partial<Record<string, number>> = {}): PlcClockRequest =>
  ({
    source: 'manual',
    time: { year: 2026, month: 3, day: 29, hour: 2, minute: 30, second: 0, ...time },
  }) as PlcClockRequest;

describe('setClock con collegamento finto', () => {
  let confirm: ReturnType<typeof vi.fn<ConfirmFn>>;
  let written: unknown[];
  let opened: number;
  let nowMs: number;
  let writes: PlcWriteService;
  const owner = new FakeOwner();
  const mk = (): PlcWriteService =>
    new PlcWriteService({
      service: { target: () => target },
      confirm,
      now: () => nowMs,
      connect: async () => {
        opened++;
        return {
          close: vi.fn(async () => undefined),
          identity: vi.fn(async () => ID as never),
          setClock: vi.fn(async (t) => void written.push(t)),
        } as unknown as WriteClient;
      },
    });
  beforeEach(() => {
    confirm = vi.fn<ConfirmFn>(async () => true);
    written = [];
    opened = 0;
    nowMs = new Date(2026, 9, 20, 10, 30, 15, 250).getTime();
    writes = mk();
  });

  it('senza conferma nessun collegamento', async () => {
    confirm.mockResolvedValue(false);
    expect(await writes.setClock(owner, { source: 'pc' })).toEqual({ ok: false, cancelled: true });
    expect(opened).toBe(0);
    expect(written).toEqual([]);
  });

  it("pc: l'ora scritta è quella dopo la conferma, non quella della richiesta", async () => {
    confirm.mockImplementationOnce(async () => {
      nowMs = new Date(2026, 9, 20, 10, 31, 45, 100).getTime(); // l'utente ha tardato
      return true;
    });
    const r = await writes.setClock(owner, { source: 'pc' });
    const want = { year: 2026, month: 10, day: 20, hour: 10, minute: 31, second: 45, ms: 100 };
    expect(r).toEqual({ ok: true, written: want });
    expect(written).toEqual([want]);
  });

  it('pc alle 23:59:59.999 del 31/12 → data e ora dello stesso istante, un solo now dopo la conferma', async () => {
    const seq = [
      new Date(2026, 11, 31, 23, 59, 58, 0).getTime(), // anteprima per la conferma
      new Date(2026, 11, 31, 23, 59, 59, 999).getTime(), // dopo la conferma
    ];
    let calls = 0;
    let callsAtConfirm = -1;
    nowMs = 0;
    writes = new PlcWriteService({
      service: { target: () => target },
      confirm: async () => {
        callsAtConfirm = calls;
        return true;
      },
      now: () => seq[calls++] ?? new Date(2027, 0, 1, 0, 0, 0, 0).getTime(),
      connect: async () =>
        ({
          close: async () => undefined,
          identity: async () => ID as never,
          setClock: async (t: unknown) => void written.push(t),
        }) as unknown as WriteClient,
    });
    const r = await writes.setClock(owner, { source: 'pc' });
    const want = { year: 2026, month: 12, day: 31, hour: 23, minute: 59, second: 59, ms: 999 };
    expect(r).toEqual({ ok: true, written: want });
    expect(written).toEqual([want]);
    expect(calls - callsAtConfirm).toBe(1);
  });

  it("pc con l'anno del PC a 2095 → errore prima della conferma, nessun collegamento", async () => {
    nowMs = new Date(2095, 0, 1, 0, 0, 0).getTime();
    const r = await writes.setClock(owner, { source: 'pc' });
    expect(r).toMatchObject({
      ok: false,
      error: expect.stringContaining("L'ora del PC non è impostabile"),
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(opened).toBe(0);
  });

  it('linkId cambiato durante la conferma → errore, nessun collegamento', async () => {
    let id = 1;
    const w = new PlcWriteService({
      service: { target: () => ({ ...target, linkId: id }) },
      confirm: async () => {
        id = 2;
        return true;
      },
      connect: async () => {
        opened++;
        return {} as never;
      },
    });
    expect(await w.setClock(owner, { source: 'pc' })).toMatchObject({ ok: false });
    expect(opened).toBe(0);
  });

  it('numero di serie diverso → setClock non chiamato, collegamento chiuso', async () => {
    const setClock = vi.fn();
    const close = vi.fn(async () => undefined);
    const w = new PlcWriteService({
      service: { target: () => target },
      confirm,
      connect: async () =>
        ({
          close,
          setClock,
          identity: async () => ({ ...ID, serialNumber: 'S C-ALTRO' }) as never,
        }) as unknown as WriteClient,
    });
    const r = await w.setClock(owner, { source: 'pc' });
    expect(r).toMatchObject({
      ok: false,
      error: expect.stringContaining('non è quella confermata'),
    });
    expect(setClock).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it('interruptAll durante la conferma → annullato, nessun collegamento', async () => {
    let release!: (v: boolean) => void;
    confirm.mockImplementationOnce(() => new Promise<boolean>((r) => (release = r)));
    const p = writes.setClock(owner, { source: 'pc' });
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    writes.interruptAll();
    release(true);
    expect(await p).toEqual({ ok: false, cancelled: true });
    expect(opened).toBe(0);
    expect(written).toEqual([]);
  });

  it("manuale 2026-03-29 02:30:00 → scritta così com'è", async () => {
    const r = await writes.setClock(owner, MANUAL());
    const want = { year: 2026, month: 3, day: 29, hour: 2, minute: 30, second: 0, ms: 0 };
    expect(r).toEqual({ ok: true, written: want });
    expect(written).toEqual([want]);
  });

  it('manuale 2026-02-29, 2090-01-01, 24:00 e altre → errore prima della conferma', async () => {
    const bad: PlcClockRequest[] = [
      MANUAL({ month: 2, day: 29 }),
      MANUAL({ year: 2090, month: 1, day: 1 }),
      MANUAL({ year: 1989 }),
      MANUAL({ hour: 24 }),
      MANUAL({ minute: 60 }),
      MANUAL({ second: 60 }),
      MANUAL({ month: 4, day: 31 }),
      MANUAL({ hour: 1.5 }),
      { source: 'altro' } as never,
      { source: 'manual' } as never,
      null as never,
    ];
    for (const b of bad) expect(await writes.setClock(owner, b)).toMatchObject({ ok: false });
    expect(confirm).not.toHaveBeenCalled();
    expect(opened).toBe(0);
    // 29 febbraio in un anno bisestile: valido
    expect(await writes.setClock(owner, MANUAL({ year: 2028, month: 2, day: 29 }))).toMatchObject({
      ok: true,
    });
  });

  it('il testo della conferma nomina modulo, indirizzo e ora', async () => {
    await writes.setClock(owner, { source: 'pc' });
    const t = confirm.mock.calls[0]![1] as WriteConfirmTexts;
    expect(t.title).toBe('Imposta ora');
    expect(t.message).toContain('CPU 315-2 PN/DP');
    expect(t.message).toContain('192.0.2.10');
    expect(t.detail).toContain('Ora del PC al momento della conferma');
    expect(t.detail).toContain('20/10/2026 10:30:15');
    expect(t.detail).toContain("Gli interrupt dall'orologio (OB10) possono saltare");
    await writes.setClock(owner, MANUAL());
    const m = confirm.mock.calls[1]![1] as WriteConfirmTexts;
    expect(m.detail).toContain('29/03/2026 02:30:00');
  });

  it("durante un'altra scrittura sulla stessa CPU → già in corso", async () => {
    let release!: (v: boolean) => void;
    confirm.mockImplementationOnce(() => new Promise<boolean>((r) => (release = r)));
    const first = writes.setClock(owner, { source: 'pc' });
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(await writes.setClock(owner, { source: 'pc' })).toEqual({
      ok: false,
      error: 'Operazione già in corso',
    });
    // un'altra finestra sulla stessa CPU
    expect(await writes.setClock(new FakeOwner(), { source: 'pc' })).toEqual({
      ok: false,
      error: 'Operazione già in corso su questa CPU',
    });
    release(true);
    expect(await first).toMatchObject({ ok: true });
  });
});

describe('setClock contro il PLC di prova', () => {
  let cpu: SimCpu;
  let plc: ListeningCpu;
  let service: PlcService;
  let owner: FakeOwner;
  beforeEach(async () => {
    cpu = new SimCpu({
      cpuTypeId: 'cpu-315-2-pn-dp',
      props: {
        maxCycleMs: 150,
        minCycleMs: 0,
        clockMemory: { enabled: false, byte: 0 },
        retentivity: { mBytes: 16, timers: 0, counters: 8 },
        cyclicInterruptMs: 0,
      },
    });
    cpu.run();
    plc = await listen(simBackend(cpu), { port: 0 });
    service = new PlcService({ intervalMs: 1000 });
    owner = new FakeOwner();
    const access: PlcAccess = {
      host: '127.0.0.1',
      port: plc.port,
      rack: 0,
      slot: 2,
      connectionType: 'PG',
    };
    expect((await service.connect(owner as PlcOwner, access)).ok).toBe(true);
  });
  afterEach(async () => {
    await service.closeAll();
    await plc.close();
  });

  it("readDiagnostics(clock) dà l'ora scritta (± 1 s)", async () => {
    const writes = new PlcWriteService({ service, confirm: async () => true });
    const r = await writes.setClock(owner, MANUAL({ year: 2027, month: 6, day: 15, hour: 8 }));
    expect(r).toMatchObject({ ok: true });
    const d = await readDiagnostics(service, owner, ['clock']);
    if (!d.ok || !d.data.clock?.ok) throw new Error('lettura fallita');
    const c = d.data.clock.value;
    const got = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second, c.ms);
    const want = Date.UTC(2027, 5, 15, 8, 30, 0);
    expect(got - want).toBeGreaterThanOrEqual(0);
    expect(got - want).toBeLessThanOrEqual(1000);
  });
});
