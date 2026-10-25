import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const electronApp = vi.hoisted(() => ({ isPackaged: false }));
vi.mock('electron', () => ({ app: electronApp }));
import { planReads, S7Error, type S7Client } from '@baaportal/s7comm';
import { connectTcp } from '@baaportal/s7comm/node';
import { listen, type ListeningCpu } from '@baaportal/s7-server/node';
import { SimCpu, simBackend } from '@baaportal/sim';
import type { PlcAccess, PlcWatchTarget } from '@baaportal/ui';
import type { ConfirmFn, WriteConfirmTexts } from '../../src/main/plc/confirm';
import { PlcService, type PlcOwner } from '../../src/main/plc/plcService';
import { PlcWriteService, type PlcWriteOwner } from '../../src/main/plc/plcWrite';
import {
  ONLINE_MAX_ITEMS,
  confirmLine,
  parseWatchItems,
  readWatch,
  toReadItem,
} from '../../src/main/plc/watchOnline';

class FakeOwner implements PlcWriteOwner, PlcOwner {
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

const PROPS = {
  maxCycleMs: 150,
  minCycleMs: 0,
  clockMemory: { enabled: false, byte: 0 },
  retentivity: { mBytes: 16, timers: 0, counters: 8 },
  cyclicInterruptMs: 0,
};

const M = (size: PlcWatchTarget['size'], byte: number, bit?: number): PlcWatchTarget => ({
  area: 'M',
  size,
  byte,
  ...(bit === undefined ? {} : { bit }),
});

describe('watch online contro il PLC di prova', () => {
  let cpu: SimCpu;
  let plc: ListeningCpu;
  let service: PlcService;
  let writes: PlcWriteService;
  let confirm: ReturnType<typeof vi.fn<ConfirmFn>>;
  let owner: FakeOwner;
  const access = (): PlcAccess => ({
    host: '127.0.0.1',
    port: plc.port,
    rack: 0,
    slot: 2,
    connectionType: 'PG',
  });
  beforeEach(async () => {
    cpu = new SimCpu({ cpuTypeId: 'cpu-315-2-pn-dp', props: PROPS });
    cpu.run();
    cpu.memory.dbs.set(5, {
      data: new Uint8Array(32),
      initial: new Uint8Array(32),
      retentive: false,
    });
    plc = await listen(simBackend(cpu), { port: 0 });
    service = new PlcService({ intervalMs: 50, readTimeoutMs: 500 });
    confirm = vi.fn<ConfirmFn>(async () => true);
    writes = new PlcWriteService({ service, confirm });
    owner = new FakeOwner();
    expect((await service.connect(owner, access())).ok).toBe(true);
  });
  afterEach(async () => {
    await writes.abortAll();
    await service.closeAll();
    await plc.close();
  });

  it('readWatch: M, DB, I, PI, T e C con i valori della CPU', async () => {
    cpu.memory.M.set([0x12, 0x34, 0x56, 0x78], 10);
    cpu.memory.M[20] = 0b0000_0100;
    cpu.memory.dbs.get(5)!.data.set([0xca, 0xfe], 4);
    cpu.memory.I[3] = 0x81;
    cpu.memory.physIn[2] = 0x7f;
    cpu.counters.setValue(3, 123);
    const items: PlcWatchTarget[] = [
      M('B', 10),
      M('W', 10),
      M('D', 10),
      M('X', 20, 2),
      M('X', 20, 3),
      { area: 'DB', db: 5, size: 'W', byte: 4 },
      { area: 'I', size: 'B', byte: 3 },
      { area: 'PI', size: 'B', byte: 2 },
      { area: 'T', size: 'W', byte: 0 },
      { area: 'C', size: 'W', byte: 3 },
    ];
    const r = await readWatch(service, owner, items);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const bytes = r.values.map((v) => ('bytes' in v ? Array.from(v.bytes) : v));
    expect(bytes).toEqual([
      [0x12],
      [0x12, 0x34],
      [0x12, 0x34, 0x56, 0x78],
      [1],
      [0],
      [0xca, 0xfe],
      [0x81],
      [0x7f],
      [0, 0],
      [0x01, 0x23],
    ]);
  });

  for (const pdu of [480, 240]) {
    it(`60 item validi con PDU ${pdu} → tante richieste read var quante ne pianifica planReads, valori in ordine`, async () => {
      for (let i = 0; i < 60; i++) cpu.memory.M[i] = i + 1;
      await service.closeAll();
      await plc.close();
      const backend = simBackend(cpu);
      backend.config.pduLength = pdu;
      plc = await listen(backend, { port: 0 });
      let requests = 0;
      let client: S7Client | undefined;
      const recorder = {
        record: (dir: 'tx' | 'rx', b: Uint8Array) => {
          // TPKT già tolto: COTP DT (3 byte), poi PDU S7 (0x32), ROSCTR 1, parametro dal byte 10.
          if (dir === 'tx' && b[3] === 0x32 && b[4] === 1 && b[3 + 10] === 0x04) requests++;
        },
        frames: () => [],
      };
      service = new PlcService({
        intervalMs: 5000,
        connect: async (o) => {
          client = await connectTcp({ ...o, recorder });
          return client;
        },
      });
      owner = new FakeOwner();
      expect((await service.connect(owner, access())).ok).toBe(true);
      const items = Array.from({ length: 60 }, (_, i) => M('B', i));
      const r = await readWatch(service, owner, items);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(client!.pduLength).toBe(pdu);
      const expected = planReads(items.map(toReadItem), client!.pduLength).length;
      expect(expected).toBe(pdu === 480 ? 3 : 4);
      expect(requests).toBe(expected);
      expect(r.values.map((v) => ('bytes' in v ? v.bytes[0] : -1))).toEqual(
        Array.from({ length: 60 }, (_, i) => i + 1),
      );
    });
  }

  it('righe miste: DB inesistente → errore solo sulla sua riga, le altre lette', async () => {
    cpu.memory.M[1] = 7;
    const r = await readWatch(service, owner, [
      M('B', 1),
      { area: 'DB', db: 99, size: 'W', byte: 0 },
      M('B', 1),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.values[0]).toEqual({ bytes: Uint8Array.of(7) });
    expect(r.values[1]).toEqual({ error: expect.stringContaining('non disponibile') });
    expect(r.values[2]).toEqual({ bytes: Uint8Array.of(7) });
  });

  it('201 item → errore prima di leggere', async () => {
    const read = vi.spyOn(service, 'read');
    const r = await readWatch(
      service,
      owner,
      Array.from({ length: ONLINE_MAX_ITEMS + 1 }, (_, i) => M('B', i)),
    );
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('Troppi') });
    expect(read).not.toHaveBeenCalled();
  });

  it('area PQ o operando non valido dal renderer → errore della sola riga, le altre lette', async () => {
    cpu.memory.M[1] = 7;
    const r = await readWatch(service, owner, [
      M('B', 1),
      { area: 'PQ', size: 'B', byte: 0 },
      { area: 'DB', db: 0, size: 'W', byte: 0 },
      M('B', 1),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.values[0]).toEqual({ bytes: Uint8Array.of(7) });
    expect(r.values[1]).toEqual({ error: expect.stringContaining('PQ') });
    expect(r.values[2]).toMatchObject({ error: expect.any(String) });
    expect(r.values[3]).toEqual({ bytes: Uint8Array.of(7) });
    // solo righe non valide: nessuna lettura
    const read = vi.spyOn(service, 'read');
    const only = await readWatch(service, owner, [{ area: 'PQ', size: 'B', byte: 0 }]);
    expect(only).toEqual({ ok: true, values: [{ error: expect.any(String) }] });
    expect(read).not.toHaveBeenCalled();
    expect(parseWatchItems([{ area: 'L', size: 'B', byte: 0 }])).toEqual(expect.any(String));
    expect(parseWatchItems([{ area: 'M', size: 'Q', byte: 0 }])).toEqual(expect.any(String));
    expect(parseWatchItems([{ area: 'M', size: 'X', byte: 0, bit: 8 }])).toEqual(
      expect.any(String),
    );
    expect(parseWatchItems([{ area: 'DB', size: 'B', byte: 0 }])).toEqual(expect.any(String));
    expect(parseWatchItems('x')).toEqual(expect.any(String));
    expect(await readWatch(service, owner, 'x')).toMatchObject({ ok: false });
  });

  it('toReadItem: PI diventa P, T e C contano 1, X diventa BIT', () => {
    expect(toReadItem({ area: 'PI', size: 'W', byte: 4 })).toMatchObject({
      area: 'P',
      size: 'WORD',
    });
    expect(toReadItem({ area: 'T', size: 'W', byte: 2 })).toMatchObject({
      area: 'T',
      size: 'TIMER',
      count: 1,
      start: 2,
    });
    expect(toReadItem({ area: 'C', size: 'W', byte: 2 })).toMatchObject({ size: 'COUNTER' });
    expect(toReadItem(M('X', 1, 5))).toMatchObject({ size: 'BIT', bit: 5, count: 1 });
  });

  it('readWatch senza collegamento → errore', async () => {
    await service.disconnect(owner);
    expect(await readWatch(service, owner, [M('B', 0)])).toMatchObject({ ok: false });
  });

  // ---- writeVars ---------------------------------------------------------------------------

  const W = (target: PlcWatchTarget, ...data: number[]) => ({
    target,
    data: Uint8Array.from(data),
  });

  it('writeVars: la conferma elenca «MW 10 ← 16#002A» e «M 0.0 ← 1»', async () => {
    let texts: WriteConfirmTexts | undefined;
    confirm.mockImplementationOnce(async (_o, t) => {
      texts = t;
      return true;
    });
    const r = await writes.writeVars(owner, [W(M('W', 10), 0, 0x2a), W(M('X', 0, 0), 1)]);
    expect(r).toEqual({ ok: true, results: [{ ok: true }, { ok: true }] });
    expect(texts!.detail).toContain('MW 10 ← 16#002A');
    expect(texts!.detail).toContain('M 0.0 ← 1');
    expect(texts!.confirmLabel).toBe('Comanda');
  });

  it('writeVars: la lista della conferma è troncata dopo 20 righe', async () => {
    let texts: WriteConfirmTexts | undefined;
    confirm.mockImplementationOnce(async (_o, t) => {
      texts = t;
      return true;
    });
    const items = Array.from({ length: 25 }, (_, i) => W(M('B', i), i));
    const r = await writes.writeVars(owner, items);
    expect(r.ok).toBe(true);
    const lines = texts!.detail.split('\n');
    expect(lines.filter((l) => l.includes('←'))).toHaveLength(20);
    expect(texts!.detail).toContain('… e altri 5');
  });

  it('confirmLine: byte, doppia parola e DB', () => {
    expect(confirmLine(M('B', 3), Uint8Array.of(5))).toBe('MB 3 ← 16#05');
    expect(confirmLine(M('D', 4), Uint8Array.of(0, 1, 0xff, 0x10))).toBe('MD 4 ← 16#0001FF10');
    expect(confirmLine({ area: 'DB', db: 5, size: 'X', byte: 2, bit: 7 }, Uint8Array.of(0))).toBe(
      'DB5.DBX 2.7 ← 0',
    );
  });

  it('writeVars: senza conferma nessun collegamento', async () => {
    const connect = vi.fn();
    const w = new PlcWriteService({ service, confirm: async () => false, connect });
    expect(await w.writeVars(owner, [W(M('B', 0), 1)])).toEqual({ ok: false, cancelled: true });
    expect(connect).not.toHaveBeenCalled();
    expect(cpu.memory.M[0]).toBe(0);
  });

  it('writeVars: PI, PQ, T, C, L o lunghezza dei dati diversa → errore prima della conferma', async () => {
    const bad: unknown[] = [
      [W({ area: 'PI', size: 'B', byte: 0 }, 1)],
      [W({ area: 'PQ', size: 'B', byte: 0 }, 1)],
      [W({ area: 'T', size: 'W', byte: 0 }, 0, 0)],
      [W({ area: 'C', size: 'W', byte: 0 }, 0, 0)],
      [W(M('W', 0), 1)],
      [W(M('B', 0), 1, 2)],
      [W(M('X', 0, 0), 2)],
      [{ target: M('B', 0), data: [1] }],
      [],
      'x',
      [W(M('B', 0), 1), W(M('W', 0), 1)],
    ];
    for (const b of bad) {
      expect(await writes.writeVars(owner, b), JSON.stringify(b)).toMatchObject({ ok: false });
    }
    expect(confirm).not.toHaveBeenCalled();
  });

  it('writeVars contro il PLC di prova → la lettura dopo dà i valori scritti', async () => {
    const r = await writes.writeVars(owner, [
      W(M('W', 10), 0, 0x2a),
      W(M('D', 12), 1, 2, 3, 4),
      W(M('X', 20, 3), 1),
      W({ area: 'DB', db: 5, size: 'W', byte: 8 }, 0xbe, 0xef),
      W({ area: 'Q', size: 'B', byte: 1 }, 0x55),
    ]);
    expect(r).toEqual({ ok: true, results: Array(5).fill({ ok: true }) });
    const read = await readWatch(service, owner, [
      M('W', 10),
      M('D', 12),
      M('X', 20, 3),
      { area: 'DB', db: 5, size: 'W', byte: 8 },
      { area: 'Q', size: 'B', byte: 1 },
    ]);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.values.map((v) => ('bytes' in v ? Array.from(v.bytes) : v))).toEqual([
      [0, 0x2a],
      [1, 2, 3, 4],
      [1],
      [0xbe, 0xef],
      [0x55],
    ]);
  });

  it('writeVars: un item rifiutato dalla CPU → errore solo per quell’item', async () => {
    const r = await writes.writeVars(owner, [
      W(M('B', 1), 9),
      W({ area: 'DB', db: 99, size: 'B', byte: 0 }, 1),
      W(M('B', 2), 8),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok || !('results' in r)) return;
    expect(r.results[0]).toEqual({ ok: true });
    expect(r.results[1]).toMatchObject({ ok: false });
    expect(r.results[2]).toEqual({ ok: true });
    expect(cpu.memory.M[1]).toBe(9);
    expect(cpu.memory.M[2]).toBe(8);
  });

  it('writeVars senza collegamento → errore, nessuna conferma', async () => {
    await service.disconnect(owner);
    expect(await writes.writeVars(owner, [W(M('B', 0), 1)])).toMatchObject({ ok: false });
    expect(confirm).not.toHaveBeenCalled();
  });

  describe('writeVars: gruppi per richiesta', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ target: M('B', i), data: Uint8Array.of(i) }));
    const fake = (failGroup?: number, failWith: Error = new Error('connessione caduta')) => {
      const log: string[] = [];
      let n = 0;
      const client = {
        pduLength: 480,
        close: vi.fn(async () => void log.push('close')),
        identity: vi.fn(async () => ({
          orderNumber: '6ES7 315-2EH14-0AB0',
          serialNumber: undefined,
        })),
        writeItems: vi.fn(async (g: unknown[]) => {
          n++;
          log.push(`w${g.length}`);
          if (n === failGroup) throw failWith;
          return g.map(() => ({ returnCode: 0xff, name: 'ok' }));
        }),
      };
      return { client, log };
    };
    const svc = () => ({
      target: () => ({
        access: { host: '192.0.2.10', rack: 0, slot: 2, connectionType: 'PG' as const },
        identity: { orderNumber: '6ES7 315-2EH14-0AB0' },
        linkId: 1,
      }),
    });

    it('gruppo 1 ok, gruppo 2 lancia, gruppo 3 non scritto; close chiamato', async () => {
      const { client, log } = fake(2);
      const w = new PlcWriteService({
        service: svc(),
        confirm,
        connect: async () => client as never,
      });
      const r = await w.writeVars(owner, many(45));
      expect(r.ok).toBe(true);
      if (!r.ok || !('results' in r)) return;
      expect(r.results.slice(0, 20).every((x) => x.ok)).toBe(true);
      for (const x of r.results.slice(20, 40)) {
        expect(x).toEqual({
          ok: false,
          error: 'Esito sconosciuto: la CPU potrebbe averlo scritto',
        });
      }
      for (const x of r.results.slice(40)) {
        expect(x).toEqual({
          ok: false,
          error: 'Non scritto: scrittura interrotta dopo un errore',
        });
      }
      expect(r.results).toHaveLength(45);
      expect(log).toEqual(['w20', 'w20', 'close']);
    });

    it('la CPU rifiuta la richiesta (CPU_ERROR): «Rifiutato dalla CPU», gruppi dopo non scritti, nessuna ripetizione', async () => {
      const { client, log } = fake(2, new S7Error('CPU_ERROR', 'protezione 0xD241'));
      const w = new PlcWriteService({
        service: svc(),
        confirm,
        connect: async () => client as never,
      });
      const r = await w.writeVars(owner, many(45));
      expect(r.ok).toBe(true);
      if (!r.ok || !('results' in r)) return;
      expect(r.results.slice(0, 20).every((x) => x.ok)).toBe(true);
      for (const x of r.results.slice(20, 40)) {
        expect(x).toEqual({ ok: false, error: 'Rifiutato dalla CPU: protezione 0xD241' });
      }
      for (const x of r.results.slice(40)) {
        expect(x).toEqual({
          ok: false,
          error: 'Non scritto: scrittura interrotta dopo un errore',
        });
      }
      expect(log).toEqual(['w20', 'w20', 'close']);
    });

    it('la conferma annuncia le richieste (stima con PDU 240) quando sono più d’una', async () => {
      const seen: string[] = [];
      const { client } = fake();
      const w = new PlcWriteService({
        service: svc(),
        confirm: async (_o, t) => {
          seen.push(t.detail);
          return true;
        },
        connect: async () => client as never,
      });
      await w.writeVars(owner, many(45));
      await w.writeVars(owner, many(2));
      expect(seen[0]).toContain(
        'Le scritture partono in più richieste (fino a 4): se una fallisce, quelle precedenti restano scritte.',
      );
      expect(seen[1]).not.toContain('Le scritture partono');
    });

    it("errore di rete: nessun «Uscita dall'app» nei risultati", async () => {
      const { client } = fake(1);
      const w = new PlcWriteService({
        service: svc(),
        confirm,
        connect: async () => client as never,
      });
      const r = await w.writeVars(owner, many(25));
      if (!r.ok || !('results' in r)) throw new Error('atteso results');
      expect(JSON.stringify(r.results)).not.toContain('Uscita');
    });
  });
});
