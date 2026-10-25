import { describe, expect, it } from 'vitest';
import { S7TestClient, memoryTransportPair, type TransportFactory } from '@baaportal/s7comm';
import { FakeCpu, serve, type FakeCpuOptions } from '@baaportal/s7-server';
import type { PlcMode } from '@baaportal/ui';
import type { PlcOwner } from '../../src/main/plc/plcService';
import { readStacks, type StacksClient } from '../../src/main/plc/stacks';

const ORDER = '6ES7 315-2EH14-0AB0';
const owner = {} as PlcOwner;

function setup(cpuOpts: FakeCpuOptions = {}, known: PlcMode | undefined = 'STOP') {
  const cpu = new FakeCpu({ mode: 'STOP', ...cpuOpts });
  let opened = 0;
  const service = {
    target: () => ({
      access: { host: 'finto', rack: 0, slot: 2, connectionType: 'PG' as const },
      identity: { orderNumber: ORDER },
      linkId: 1,
    }),
    modeOf: () => known,
  };
  const connect = async (): Promise<StacksClient> => {
    opened++;
    const transport: TransportFactory = async () => {
      const [a, b] = memoryTransportPair();
      serve(cpu, b);
      return a;
    };
    return S7TestClient.connect({ host: 'finto', transport, timeoutMs: 2000 });
  };
  return { cpu, service, connect, opened: () => opened };
}

describe('readStacks', () => {
  it('impostazione sperimentale spenta → nessun collegamento', async () => {
    const t = setup();
    for (const experimental of [false, undefined as unknown as boolean, 'true' as never]) {
      const r = await readStacks(t.service, owner, { experimental, connect: t.connect });
      expect(r).toMatchObject({ ok: false });
    }
    expect(t.opened()).toBe(0);
  });

  it('modo noto RUN → run, nessun collegamento online-test aperto', async () => {
    const t = setup({ mode: 'RUN' }, 'RUN');
    const r = await readStacks(t.service, owner, { experimental: true, connect: t.connect });
    expect(r).toMatchObject({ ok: false, reason: 'run' });
    expect(t.opened()).toBe(0);
  });

  it('senza collegamento online → offline', async () => {
    const t = setup();
    const r = await readStacks({ ...t.service, target: () => undefined }, owner, {
      experimental: true,
      connect: t.connect,
    });
    expect(r).toMatchObject({ ok: false, reason: 'offline' });
  });

  it('in STOP contro FakeCpu → BSTACK OB1 + FC10, USTACK con STW, 2 LSTACK', async () => {
    const t = setup();
    const r = await readStacks(t.service, owner, { experimental: true, connect: t.connect });
    if (!r.ok) throw new Error(r.error);
    expect(r.mode).toBe('STOP');
    if (!r.bstack.ok) throw new Error(r.bstack.why);
    expect(r.bstack.value.entries.map((e) => [e.blockType, e.number])).toEqual([
      ['OB', 1],
      ['FC', 10],
    ]);
    expect(r.bstack.value.entries[0]!.ob?.priority).toBe(1);
    if (!r.ustack.ok) throw new Error(r.ustack.why);
    expect(r.ustack.value.stw).toBe(0x0106);
    expect(typeof r.ustack.value.obStartInfo).toBe('string'); // esadecimale
    expect(r.ustack.value.obStartInfo).toHaveLength(24);
    expect(r.lstack.map((l) => l.depth)).toEqual([0, 1]);
    for (const l of r.lstack) expect(l.value.ok).toBe(true);
  });

  it('CPU passata in RUN fra la sorveglianza e la rilettura → run', async () => {
    const t = setup({ mode: 'RUN' }, 'STOP'); // la sorveglianza dice STOP, la CPU è in RUN
    const r = await readStacks(t.service, owner, { experimental: true, connect: t.connect });
    expect(r).toMatchObject({ ok: false, reason: 'run' });
    expect(t.opened()).toBe(1);
  });

  it('tisMalformed [0x04] → bstack ok:false con esadecimale, ustack ok', async () => {
    const t = setup({ faults: { tisMalformed: [0x04] } });
    const r = await readStacks(t.service, owner, { experimental: true, connect: t.connect });
    if (!r.ok) throw new Error(r.error);
    expect(r.bstack).toMatchObject({ ok: false });
    if (r.bstack.ok) return;
    expect(r.bstack.hex).toMatch(/^[0-9a-f]+$/);
    expect(r.ustack.ok).toBe(true);
    expect(r.lstack).toEqual([]);
  });

  it("0xD0C5 → stack incoerente; 0xD081 sull'ISTACK → run", async () => {
    const a = setup({ faults: { tisError: { sub: 0x04, code: 0xd0c5 } } });
    const r = await readStacks(a.service, owner, { experimental: true, connect: a.connect });
    expect(r).toMatchObject({ ok: false, reason: 'error' });
    if (!r.ok) expect(r.error).toMatch(/incoerente/);
    const b = setup({ faults: { tisError: { sub: 0x03, code: 0xd081 } } });
    expect(
      await readStacks(b.service, owner, { experimental: true, connect: b.connect }),
    ).toMatchObject({ ok: false, reason: 'run' });
  });

  it('identità diversa → errore, collegamento chiuso', async () => {
    const t = setup();
    const r = await readStacks(
      { ...t.service, target: () => ({ ...t.service.target(), identity: { orderNumber: 'X' } }) },
      owner,
      { experimental: true, connect: t.connect },
    );
    expect(r).toMatchObject({ ok: false, reason: 'error' });
  });
});
