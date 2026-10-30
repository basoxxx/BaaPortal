import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const electronApp = vi.hoisted(() => ({ isPackaged: false }));
vi.mock('electron', () => ({ app: electronApp }));
import { listen, type ListeningCpu } from '@baaportal/s7-server/node';
import { SimCpu, simBackend } from '@baaportal/sim';
import { connectWriteTcp } from '@baaportal/s7comm/node';
import type { PlcAccess, PlcWatchTarget } from '@baaportal/ui';
import type { ConfirmFn, WriteConfirmTexts } from '../../src/main/plc/confirm';
import { PlcService, type PlcOwner } from '../../src/main/plc/plcService';
import { PlcWriteService, type PlcWriteOwner } from '../../src/main/plc/plcWrite';

class FakeOwner extends EventEmitter implements PlcWriteOwner, PlcOwner {
  isDestroyed(): boolean {
    return false;
  }
  send(): void {}
}

const PROPS = {
  maxCycleMs: 150,
  minCycleMs: 0,
  clockMemory: { enabled: false, byte: 0 },
  retentivity: { mBytes: 16, timers: 0, counters: 8 },
  cyclicInterruptMs: 0,
};
const BIT: PlcWatchTarget = { area: 'M', byte: 3, bit: 2, size: 'X' };
const W = (target: PlcWatchTarget, ...data: number[]) => [{ target, data: Uint8Array.from(data) }];

describe('scritture del runtime HMI contro il PLC di prova', () => {
  let cpu: SimCpu;
  let plc: ListeningCpu;
  let service: PlcService;
  let writes: PlcWriteService;
  let confirm: ReturnType<typeof vi.fn<ConfirmFn>>;
  let owner: FakeOwner;
  let connects: number;
  const access = (): PlcAccess => ({
    host: '127.0.0.1',
    port: plc.port,
    rack: 0,
    slot: 2,
    connectionType: 'PG',
  });
  beforeEach(async () => {
    cpu = new SimCpu({ cpuTypeId: 'cpu-315-2-pn-dp', props: PROPS });
    plc = await listen(simBackend(cpu), { port: 0 });
    service = new PlcService({ intervalMs: 50, readTimeoutMs: 500 });
    confirm = vi.fn<ConfirmFn>(async () => true);
    connects = 0;
    writes = new PlcWriteService({
      service,
      confirm,
      connect: (o) => {
        connects++;
        return connectWriteTcp(o);
      },
    });
    owner = new FakeOwner();
    expect((await service.connect(owner, access())).ok).toBe(true);
  });
  afterEach(async () => {
    await writes.abortAll();
    await service.closeAll();
    await plc.close();
  });

  /** Conferma del runtime: il token del permesso. */
  const arm = async (): Promise<string> => {
    const r = await writes.hmiArm(owner);
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r.token;
  };

  it('senza la conferma del runtime ogni scrittura è rifiutata, senza finestra né collegamento', async () => {
    const r = await writes.hmiWrite(owner, 'nessuno', W(BIT, 1));
    expect(r).toEqual({
      ok: false,
      error: 'Scritture HMI non consentite: riavviare il runtime in scrittura',
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(cpu.memory.M[3]).toBe(0);
  });

  it('una conferma sola, poi le scritture vanno nella CPU; revocata, di nuovo rifiutate', async () => {
    let texts: WriteConfirmTexts | undefined;
    confirm.mockImplementationOnce(async (_o, t) => {
      texts = t;
      return true;
    });
    const token = await arm();
    expect(texts!.message).toMatch(/^Il runtime HMI può scrivere nella CPU /);
    expect(texts!.detail).toContain('senza altre conferme');
    expect(texts!.confirmLabel).toBe('Consenti scritture');
    expect(await writes.hmiWrite(owner, token, W(BIT, 1))).toEqual({
      ok: true,
      results: [{ ok: true }],
    });
    expect(cpu.memory.M[3]).toBe(0b100);
    expect(await writes.hmiWrite(owner, token, W(BIT, 0))).toMatchObject({ ok: true });
    expect(cpu.memory.M[3]).toBe(0);
    expect(confirm).toHaveBeenCalledTimes(1);
    await writes.hmiDisarm(owner, token);
    expect(await writes.hmiWrite(owner, token, W(BIT, 1))).toMatchObject({ ok: false });
    expect(cpu.memory.M[3]).toBe(0);
  });

  it('conferma annullata → nessuna scrittura', async () => {
    confirm.mockImplementationOnce(async () => false);
    expect(await writes.hmiArm(owner)).toEqual({ ok: false, cancelled: true });
    expect(writes.hmiSessions()).toBe(0);
    expect(connects).toBe(0);
    expect(cpu.memory.M[3]).toBe(0);
  });

  it('collegamento online nuovo: la conferma di prima non vale più', async () => {
    const token = await arm();
    await service.disconnect(owner);
    expect((await service.connect(owner, access())).ok).toBe(true);
    expect(await writes.hmiWrite(owner, token, W(BIT, 1))).toMatchObject({ ok: false });
    expect(cpu.memory.M[3]).toBe(0);
  });

  it('gli stessi controlli di «Comanda»: PI, T e lunghezze sbagliate rifiutate anche con la conferma', async () => {
    const token = await arm();
    for (const bad of [
      W({ area: 'PI', size: 'B', byte: 0 }, 1),
      W({ area: 'T', size: 'W', byte: 0 }, 0, 0),
      W(BIT, 2),
      W({ area: 'M', size: 'W', byte: 0 }, 1),
    ]) {
      expect(await writes.hmiWrite(owner, token, bad), JSON.stringify(bad)).toMatchObject({
        ok: false,
      });
    }
  });

  it('senza collegamento online la conferma non parte', async () => {
    await service.disconnect(owner);
    expect(await writes.hmiArm(owner)).toEqual({ ok: false, error: 'Nessun collegamento online' });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('un collegamento in scrittura solo, aperto alla conferma e riusato da pressioni e rilasci', async () => {
    const token = await arm();
    expect(connects).toBe(1);
    for (let i = 0; i < 3; i++) {
      expect(await writes.hmiWrite(owner, token, W(BIT, 1), true)).toMatchObject({ ok: true });
      expect(await writes.hmiWrite(owner, token, W(BIT, 0))).toMatchObject({ ok: true });
    }
    expect(connects).toBe(1);
  });

  it("il permesso è per token: revocarne uno non tocca l'altro, e un token vale solo per la sua finestra", async () => {
    const first = await arm();
    const second = await arm();
    expect(first).not.toBe(second);
    await writes.hmiDisarm(owner, first);
    expect(await writes.hmiWrite(owner, first, W(BIT, 1))).toMatchObject({ ok: false });
    expect(await writes.hmiWrite(owner, second, W(BIT, 1))).toMatchObject({ ok: true });
    expect(cpu.memory.M[3]).toBe(0b100);
    const other = new FakeOwner();
    expect((await service.connect(other, access())).ok).toBe(true);
    expect(await writes.hmiWrite(other, second, W(BIT, 0))).toMatchObject({ ok: false });
    await writes.hmiDisarm(other, second); // non è suo: non lo revoca
    expect(await writes.hmiWrite(owner, second, W(BIT, 0))).toMatchObject({ ok: true });
    expect(cpu.memory.M[3]).toBe(0);
  });

  it('revoca con un impulso premuto: il processo principale scrive lo 0', async () => {
    const token = await arm();
    await writes.hmiWrite(owner, token, W(BIT, 1), true);
    expect(cpu.memory.M[3]).toBe(0b100);
    await writes.hmiDisarm(owner, token);
    expect(cpu.memory.M[3]).toBe(0);
  });

  it.each(['did-navigate', 'render-process-gone', 'destroyed'])(
    'pagina finita (%s): impulsi a 0 e ogni token della finestra revocato',
    async (event) => {
      const a = await arm();
      const b = await arm();
      await writes.hmiWrite(owner, a, W(BIT, 1), true);
      expect(cpu.memory.M[3]).toBe(0b100);
      owner.emit(event);
      await vi.waitFor(() => expect(cpu.memory.M[3]).toBe(0));
      expect(writes.hmiSessions()).toBe(0);
      expect(await writes.hmiWrite(owner, b, W(BIT, 1))).toMatchObject({ ok: false });
      expect(cpu.memory.M[3]).toBe(0);
    },
  );

  it('collegamento online finito con un impulso premuto: lo 0 parte lo stesso', async () => {
    const token = await arm();
    await writes.hmiWrite(owner, token, W(BIT, 1), true);
    await service.disconnect(owner);
    await vi.waitFor(() => expect(cpu.memory.M[3]).toBe(0));
    expect(writes.hmiSessions()).toBe(0);
  });

  it("uscita dall'app con un impulso premuto: lo 0 prima di chiudere", async () => {
    const token = await arm();
    await writes.hmiWrite(owner, token, W(BIT, 1), true);
    await writes.abortAll();
    expect(cpu.memory.M[3]).toBe(0);
  });

  it("un'altra scrittura in corso: la pressione è rifiutata, il rilascio aspetta e scrive", async () => {
    const token = await arm();
    await writes.hmiWrite(owner, token, W(BIT, 1), true);
    let answer!: (yes: boolean) => void;
    confirm.mockImplementationOnce(() => new Promise<boolean>((r) => (answer = r)));
    const other = writes.writeVars(owner, W({ area: 'M', byte: 8, size: 'B' }, 7));
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    expect(await writes.hmiWrite(owner, token, W(BIT, 1), true)).toEqual({
      ok: false,
      error: 'Operazione già in corso',
    });
    const release = writes.hmiWrite(owner, token, W(BIT, 0));
    await new Promise((r) => setTimeout(r, 100));
    expect(cpu.memory.M[3]).toBe(0b100); // aspetta la fine dell'altra
    answer(false);
    expect(await other).toEqual({ ok: false, cancelled: true });
    expect(await release).toEqual({ ok: true, results: [{ ok: true }] });
    expect(cpu.memory.M[3]).toBe(0);
  });

  it("un'altra scrittura che non finisce: dopo l'attesa il rilascio scrive comunque", async () => {
    const token = await arm();
    await writes.hmiWrite(owner, token, W(BIT, 1), true);
    let answer!: (yes: boolean) => void;
    confirm.mockImplementationOnce(() => new Promise<boolean>((r) => (answer = r)));
    const other = writes.writeVars(owner, W({ area: 'M', byte: 8, size: 'B' }, 7));
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    expect(await writes.hmiWrite(owner, token, W(BIT, 0))).toMatchObject({ ok: true });
    expect(cpu.memory.M[3]).toBe(0);
    answer(false);
    await other;
  });
});
