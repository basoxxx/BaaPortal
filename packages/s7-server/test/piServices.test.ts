import { describe, expect, it } from 'vitest';
import { S7WriteClient, memoryTransportPair, type TransportFactory } from '@baaportal/s7comm';
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

  it('con protezione 2 i tre servizi rispondono 0xD241', async () => {
    const cpu = new FakeCpu({ protectionLevel: 2 });
    const p = await new TestPeer(cpu).open();
    const modu = Uint8Array.from([
      0x28,
      0,
      0,
      0,
      0,
      0,
      0,
      0xfd,
      0,
      2,
      0x45,
      0x50,
      5,
      ...[...'_MODU'].map((x) => x.charCodeAt(0)),
    ]);
    expect(await p.job(modu)).toMatchObject({ rosctr: 2, errorClass: 0xd2, errorCode: 0x41 });
  });
});
