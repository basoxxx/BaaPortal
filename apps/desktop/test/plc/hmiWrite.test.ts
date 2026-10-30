import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const electronApp = vi.hoisted(() => ({ isPackaged: false }));
vi.mock('electron', () => ({ app: electronApp }));
import { listen, type ListeningCpu } from '@baaportal/s7-server/node';
import { SimCpu, simBackend } from '@baaportal/sim';
import type { PlcAccess, PlcWatchTarget } from '@baaportal/ui';
import type { ConfirmFn, WriteConfirmTexts } from '../../src/main/plc/confirm';
import { PlcService, type PlcOwner } from '../../src/main/plc/plcService';
import { PlcWriteService, type PlcWriteOwner } from '../../src/main/plc/plcWrite';

class FakeOwner implements PlcWriteOwner, PlcOwner {
  isDestroyed(): boolean {
    return false;
  }
  send(): void {}
  once(): void {}
  removeListener(): void {}
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
    writes = new PlcWriteService({ service, confirm });
    owner = new FakeOwner();
    expect((await service.connect(owner, access())).ok).toBe(true);
  });
  afterEach(async () => {
    await writes.abortAll();
    await service.closeAll();
    await plc.close();
  });

  it('senza la conferma del runtime ogni scrittura è rifiutata, senza finestra né collegamento', async () => {
    const r = await writes.hmiWrite(owner, W(BIT, 1));
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
    expect(await writes.hmiArm(owner)).toEqual({ ok: true });
    expect(texts!.message).toMatch(/^Il runtime HMI può scrivere nella CPU /);
    expect(texts!.detail).toContain('senza altre conferme');
    expect(texts!.confirmLabel).toBe('Consenti scritture');
    expect(await writes.hmiWrite(owner, W(BIT, 1))).toEqual({ ok: true, results: [{ ok: true }] });
    expect(cpu.memory.M[3]).toBe(0b100);
    expect(await writes.hmiWrite(owner, W(BIT, 0))).toMatchObject({ ok: true });
    expect(cpu.memory.M[3]).toBe(0);
    expect(confirm).toHaveBeenCalledTimes(1);
    writes.hmiDisarm(owner);
    expect(await writes.hmiWrite(owner, W(BIT, 1))).toMatchObject({ ok: false });
    expect(cpu.memory.M[3]).toBe(0);
  });

  it('conferma annullata → nessuna scrittura', async () => {
    confirm.mockImplementationOnce(async () => false);
    expect(await writes.hmiArm(owner)).toEqual({ ok: false, cancelled: true });
    expect(await writes.hmiWrite(owner, W(BIT, 1))).toMatchObject({ ok: false });
    expect(cpu.memory.M[3]).toBe(0);
  });

  it('collegamento online nuovo: la conferma di prima non vale più', async () => {
    expect(await writes.hmiArm(owner)).toEqual({ ok: true });
    await service.disconnect(owner);
    expect((await service.connect(owner, access())).ok).toBe(true);
    expect(await writes.hmiWrite(owner, W(BIT, 1))).toMatchObject({ ok: false });
    expect(cpu.memory.M[3]).toBe(0);
  });

  it('gli stessi controlli di «Comanda»: PI, T e lunghezze sbagliate rifiutate anche con la conferma', async () => {
    expect(await writes.hmiArm(owner)).toEqual({ ok: true });
    for (const bad of [
      W({ area: 'PI', size: 'B', byte: 0 }, 1),
      W({ area: 'T', size: 'W', byte: 0 }, 0, 0),
      W(BIT, 2),
      W({ area: 'M', size: 'W', byte: 0 }, 1),
    ]) {
      expect(await writes.hmiWrite(owner, bad), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
  });

  it('senza collegamento online la conferma non parte', async () => {
    await service.disconnect(owner);
    expect(await writes.hmiArm(owner)).toEqual({ ok: false, error: 'Nessun collegamento online' });
    expect(confirm).not.toHaveBeenCalled();
  });
});
