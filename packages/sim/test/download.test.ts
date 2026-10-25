import { compileBlock } from '@baaportal/mc7';
import { blockTypeCode } from '@baaportal/s7comm';
import type { AwlContext } from '@baaportal/awl';
import { describe, expect, it } from 'vitest';
import { SimCpu, connectToSim, type SimCpuOptions } from '../src';
import { EMPTY, buildFiles, el, m, type BlockSpec } from './programHelpers';

const PROPS: SimCpuOptions['props'] = {
  maxCycleMs: 150,
  minCycleMs: 0,
  clockMemory: { enabled: false, byte: 0 },
  retentivity: { mBytes: 16, timers: 2, counters: 2 },
  cyclicInterruptMs: 100,
};

const newCpu = (): SimCpu => new SimCpu({ cpuTypeId: 'cpu-315-2-pn-dp', props: PROPS });

const OB1: BlockSpec = {
  kind: 'OB',
  number: 1,
  networks: ['\tA I 0.0;\n\t= Q 4.0;', '\tCALL FC 1;', '\tL MW 10;\n\tT QW 6;'],
};
const FC1: BlockSpec = {
  kind: 'FC',
  number: 1,
  networks: ['\tOPN DB 1;\n\tL 42;\n\tT DBW 0;'],
};

/** File di un DB con due Int e valori iniziali 5 e 7. */
function dbFile(number: number): Uint8Array {
  const stat = [m('a', el('Int')), m('b', el('Int'))];
  const iface = {
    input: [],
    output: [],
    inOut: [],
    static: stat,
    temp: [],
    returnType: { kind: 'void' as const },
  };
  const ctx = {
    owner: { kind: 'DB', iface },
    symbol: () => undefined,
    block: () => undefined,
    resolve: () => null,
    allSymbols: () => [],
    allBlocks: () => [],
  } as unknown as AwlContext;
  const r = compileBlock({
    kind: 'DB',
    number,
    now: new Date(2026, 9, 20),
    header: { author: 'T', family: 'Prove', name: 'Dati', version: '0.1' },
    knowHowProtected: false,
    sections: { ...EMPTY, stat },
    initials: { a: '5', b: '7' },
    networks: [],
    ctx,
  });
  if (!r.file) throw new Error(r.diagnostics.map((d) => d.message).join('; '));
  return r.file;
}

async function loaded() {
  const cpu = newCpu();
  const c = await connectToSim(cpu);
  for (const f of buildFiles([OB1, FC1])) await c.downloadBlock(f);
  await c.downloadBlock(dbFile(1));
  return { cpu, c };
}

describe('download nella CPU simulata attraverso il server S7', () => {
  it('compila OB1+FC1 da AWL, downloadBlock via S7WriteClient, start, ciclo → Q come atteso', async () => {
    const { cpu, c } = await loaded();
    expect(cpu.program.get('OB', 1)).toBeDefined();
    expect(cpu.program.get('FC', 1)).toBeDefined();
    expect(cpu.mode).toBe('STOP');
    await c.start();
    expect(cpu.mode).toBe('RUN');
    cpu.memory.physIn[0] = 1;
    expect(cpu.cycle().ok).toBe(true);
    expect(cpu.memory.physOut[4]).toBe(1);
    await c.close();
  });

  it('stop() via client → cpu.mode STOP', async () => {
    const { cpu, c } = await loaded();
    await c.start();
    expect(await c.mode()).toBe('RUN');
    await c.stop();
    expect(cpu.mode).toBe('STOP');
    expect(await c.mode()).toBe('STOP');
    await c.close();
  });

  it('readArea DB1 dopo un ciclo legge il valore scritto dal programma', async () => {
    const { cpu, c } = await loaded();
    expect(Array.from(await c.readArea('DB', 1, 0, 4))).toEqual([0, 5, 0, 7]);
    await c.start();
    cpu.cycle();
    expect(Array.from(await c.readArea('DB', 1, 0, 2))).toEqual([0, 42]);
    await c.close();
  });

  it('writeArea M → visibile al ciclo dopo', async () => {
    const { cpu, c } = await loaded();
    await c.start();
    await c.writeArea('M', 0, 10, Uint8Array.of(0x12, 0x34));
    expect(cpu.memory.M[10]).toBe(0x12);
    cpu.cycle();
    expect(cpu.memory.physOut[6]).toBe(0x12);
    expect(cpu.memory.physOut[7]).toBe(0x34);
    expect(Array.from(await c.readArea('Q', 0, 6, 2))).toEqual([0x12, 0x34]);
    await c.close();
  });

  it('un download in RUN è accettato e vale dal ciclo successivo', async () => {
    const { cpu, c } = await loaded();
    await c.start();
    cpu.cycle();
    const [ob] = buildFiles([{ kind: 'OB', number: 1, networks: ['\tL 9;\n\tT MB 40;'] }]);
    await c.downloadBlock(ob!);
    expect(cpu.memory.M[40]).toBe(0);
    cpu.cycle();
    expect(cpu.memory.M[40]).toBe(9);
    await c.close();
  });

  it('blockList dopo il download elenca OB1 e FC1', async () => {
    const { c } = await loaded();
    expect((await c.listBlocks('OB')).map((b) => b.number)).toEqual([1]);
    expect((await c.listBlocks('FC')).map((b) => b.number)).toEqual([1]);
    expect((await c.listBlocks('DB')).map((b) => b.number)).toEqual([1]);
    expect((await c.blockCounts()).OB).toBe(1);
    expect((await c.blockInfo('FC', 1)).number).toBe(1);
    await c.close();
  });

  it('lettura e scrittura di M oltre l’area: codice item 0x05', async () => {
    const { cpu, c } = await loaded();
    const size = cpu.memory.M.length;
    await expect(c.readArea('M', 0, size - 1, 2)).rejects.toMatchObject({
      code: 'CPU_ERROR',
      detail: { returnCode: 0x05 },
    });
    await expect(c.writeArea('M', 0, size - 1, Uint8Array.of(1, 2))).rejects.toMatchObject({
      code: 'CPU_ERROR',
      detail: { returnCode: 0x05 },
    });
    expect(cpu.memory.M[size - 1]).toBe(0);
    await c.close();
  });

  it('DB assente: codice item 0x0a in lettura e in scrittura', async () => {
    const { c } = await loaded();
    await expect(c.readArea('DB', 99, 0, 2)).rejects.toMatchObject({
      detail: { returnCode: 0x0a },
    });
    await expect(c.writeArea('DB', 99, 0, Uint8Array.of(1, 2))).rejects.toMatchObject({
      detail: { returnCode: 0x0a },
    });
    await c.close();
  });

  it('T e C: zero in lettura, scrittura vietata dal filtro del client', async () => {
    const { c } = await loaded();
    for (const area of ['T', 'C'] as const) {
      const size = area === 'T' ? 'TIMER' : 'COUNTER';
      const [r] = await c.readItems([{ area, db: 0, start: 0, size, count: 1 }]);
      expect(r).toMatchObject({ ok: true });
      expect(Array.from(r?.ok ? r.data : [1])).toEqual([0, 0]);
      // La scrittura non parte nemmeno: il filtro del client ammette solo I, Q, M e DB.
      await expect(
        c.writeItems([{ area, db: 0, start: 0, size, count: 1, data: Uint8Array.of(1, 2) }]),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    await c.close();
  });

  it('T: parola BCD con la base come LC, big-endian', async () => {
    const { cpu, c } = await loaded();
    cpu.timers.startOp(1, 'SP', true, 0x3999); // 999 · 10 s, a orologio reale resta 999
    const [r] = await c.readItems([{ area: 'T', db: 0, start: 0, size: 'TIMER', count: 2 }]);
    expect(Array.from(r?.ok ? r.data : [])).toEqual([0, 0, 0x39, 0x99]);
    await c.close();
  });

  it('C: parola BCD come LC C, big-endian', async () => {
    const { cpu, c } = await loaded();
    cpu.counters.setValue(1, 123);
    const [r] = await c.readItems([{ area: 'C', db: 0, start: 0, size: 'COUNTER', count: 2 }]);
    expect(Array.from(r?.ok ? r.data : [])).toEqual([0, 0, 0x01, 0x23]);
    await c.close();
  });

  it('un download che la CPU non sa caricare è rifiutato e la CPU resta com’era', async () => {
    const { cpu, c } = await loaded();
    await c.start();
    const [ob2] = buildFiles([{ kind: 'OB', number: 2, networks: ['\tL 9;\n\tT MB 41;'] }]);
    // il file è ben formato per il protocollo, ma il tipo (SFC) la CPU simulata non lo carica
    const bad = ob2!.slice();
    bad[5] = blockTypeCode('SFC');
    const before = cpu.program.list().length;
    await expect(c.downloadBlock(bad)).rejects.toThrow();
    expect(cpu.program.list()).toHaveLength(before);
    expect(cpu.program.get('OB', 2)).toBeUndefined();
    expect(cpu.mode).toBe('RUN');
    expect(cpu.cycle().ok).toBe(true);
    // la connessione serve ancora
    expect(await c.mode()).toBe('RUN');
    await c.close();
  });

  it('il modo letto dal client segue cpu.stop() chiamato sulla CPU', async () => {
    const { cpu, c } = await loaded();
    await c.start();
    expect(await c.mode()).toBe('RUN');
    cpu.stop();
    expect(await c.mode()).toBe('STOP');
    cpu.run();
    expect(await c.mode()).toBe('RUN');
    await c.close();
  });
});

describe('cancellazione di blocchi nella CPU simulata (_DELE)', () => {
  it('cancella un DB e un FC: upload e blockInfo non li trovano più, la lista si svuota', async () => {
    const { cpu, c } = await loaded();
    await c.deleteBlock('DB', 1);
    await c.deleteBlock('FC', 1);
    expect(cpu.program.get('FC', 1)).toBeUndefined();
    expect(cpu.memory.dbs.has(1)).toBe(false);
    for (const [t, n] of [
      ['DB', 1],
      ['FC', 1],
    ] as const) {
      await expect(c.upload(t, n)).rejects.toMatchObject({ code: 'CPU_ERROR' });
      await expect(c.blockInfo(t, n)).rejects.toMatchObject({ code: 'CPU_ERROR' });
    }
    expect((await c.listBlocks('FC')).length).toBe(0);
    expect((await c.listBlocks('OB')).map((b) => b.number)).toEqual([1]);
    // un blocco già cancellato: errore della CPU
    await expect(c.deleteBlock('FC', 1)).rejects.toMatchObject({ code: 'CPU_ERROR' });
    await c.close();
  });
});
