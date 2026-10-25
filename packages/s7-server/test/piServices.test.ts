import { describe, expect, it } from 'vitest';
import {
  S7WriteClient,
  encodeCompressMemory,
  encodeCopyRamToRom,
  encodeDeleteBlock,
  memoryTransportPair,
  type TransportFactory,
} from '@baaportal/s7comm';
import { FakeCpu, serve, type CpuBackend } from '../src';
import { TestPeer, blockFile, seq } from './helpers';

function connect(cpu: CpuBackend): Promise<S7WriteClient> {
  const transport: TransportFactory = async () => {
    const [a, b] = memoryTransportPair();
    serve(cpu, b);
    return a;
  };
  return S7WriteClient.connect({ host: 'finto', transport, timeoutMs: 1500 });
}

describe('_DELE, _MODU e _GARB contro il server di prova', () => {
  it('deleteBlock toglie il blocco dalla lista; il secondo giro è un errore CPU', async () => {
    const cpu = new FakeCpu();
    const c = await connect(cpu);
    await c.downloadBlock(blockFile('FC', 9, seq(40, 1)));
    expect((await c.listBlocks('FC')).map((b) => b.number)).toContain(9);
    await c.deleteBlock('FC', 9);
    expect((await c.listBlocks('FC')).map((b) => b.number)).not.toContain(9);
    await expect(c.deleteBlock('FC', 9)).rejects.toMatchObject({ code: 'CPU_ERROR' });
  });

  it('il server rifiuta _DELE con filesystem B', async () => {
    const cpu = new FakeCpu();
    cpu.addDb(1, seq(8));
    const p = await new TestPeer(cpu).open();
    expect(await p.job(encodeDeleteBlock('DB', 1, 'B'))).toMatchObject({ rosctr: 2 });
    expect(cpu.block('DB', 1)).toBeDefined();
    await p.job(encodeDeleteBlock('DB', 1, 'A'));
    expect(cpu.block('DB', 1)).toBeUndefined();
  });

  it('copyRamToRom e compressMemory rispondono OK', async () => {
    const c = await connect(new FakeCpu());
    await expect(c.copyRamToRom()).resolves.toBeUndefined();
    await expect(c.compressMemory()).resolves.toBeUndefined();
  });

  it('un backend senza i tre metodi risponde "non implementato" (0x8104)', async () => {
    const cpu = new FakeCpu();
    const bare = Object.create(cpu) as CpuBackend;
    Object.defineProperties(bare, {
      deleteBlock: { value: undefined },
      copyRamToRom: { value: undefined },
      compressMemory: { value: undefined },
    });
    const c = await connect(bare);
    await expect(c.copyRamToRom()).rejects.toMatchObject({ code: 'CPU_ERROR' });
    await expect(c.compressMemory()).rejects.toMatchObject({ code: 'CPU_ERROR' });
    await expect(c.deleteBlock('FC', 1)).rejects.toMatchObject({ code: 'CPU_ERROR' });
  });

  it('deleteBlock rifiuta SDB, SFC e SFB senza inviare nulla', async () => {
    const c = await connect(new FakeCpu());
    for (const t of ['SDB', 'SFC', 'SFB'] as const) {
      await expect(c.deleteBlock(t, 1)).rejects.toMatchObject({ code: 'PROTOCOL' });
    }
  });

  it('con protezione 2 _MODU, _GARB e _DELE rispondono 0xD241 e lo stato non cambia', async () => {
    const cpu = new FakeCpu({ protectionLevel: 2 });
    cpu.addDb(1, seq(8));
    const before = cpu.snapshot();
    const p = await new TestPeer(cpu).open();
    for (const param of [
      encodeCopyRamToRom(),
      encodeCompressMemory(),
      encodeDeleteBlock('DB', 1, 'A'),
    ]) {
      expect(await p.job(param)).toMatchObject({ rosctr: 2, errorClass: 0xd2, errorCode: 0x41 });
    }
    expect(cpu.snapshot()).toBe(before);
    expect(cpu.block('DB', 1)).toBeDefined();
  });
});
