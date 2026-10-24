import { describe, expect, it } from 'vitest';
import { SimCpu, type SimCpuOptions } from '../src';
import { buildFiles, buildProgram, type BlockSpec } from './programHelpers';

const PROPS: SimCpuOptions['props'] = {
  maxCycleMs: 150,
  minCycleMs: 0,
  clockMemory: { enabled: false, byte: 0 },
  retentivity: { mBytes: 16, timers: 2, counters: 2 },
  cyclicInterruptMs: 100,
};

function makeCpu(specs: BlockSpec[]): SimCpu {
  const cpu = new SimCpu({ cpuTypeId: 'cpu-315-2-pn-dp', props: PROPS, now: () => 0 });
  for (const b of buildProgram(specs).list()) cpu.program.put(b);
  return cpu;
}

const ob1 = (...networks: string[]): BlockSpec => ({ kind: 'OB', number: 1, networks });
const fc1: BlockSpec = {
  kind: 'FC',
  number: 1,
  networks: ['\tL 7;\n\tL 9;\n\tSET;\n\tT MW 10;'],
};

describe('osservazione', () => {
  it('monitor di FC1: RLO e ACCU dopo ogni riga, prima esecuzione nel ciclo', () => {
    const cpu = makeCpu([ob1('\tCALL FC 1;\n\tCALL FC 1;'), fc1]);
    cpu.setMonitor({ kind: 'FC', number: 1 });
    cpu.run();
    cpu.cycle();
    const s = cpu.monitorSnapshot()!;
    // una voce per istruzione di FC1 (L, L, SET, T, BE), una sola volta nonostante due chiamate
    const offsets = s.map((x) => x.offset);
    expect(new Set(offsets).size).toBe(offsets.length);
    expect(s.length).toBeGreaterThanOrEqual(4);
    expect(s[0]).toMatchObject({ accu1: 7 });
    expect(s[1]).toMatchObject({ accu1: 9, accu2: 7 });
    expect(s[2]).toMatchObject({ rlo: true, sta: true });
    expect(s[2]!.stw & 0b10).toBe(0b10);
    // la seconda chiamata trova gli stessi valori ma non aggiunge voci: ciclo successivo ricomincia
    cpu.cycle();
    expect(cpu.monitorSnapshot()!.length).toBe(s.length);
  });

  it('monitor azzerato quando FC1 è ricaricata', () => {
    const cpu = makeCpu([ob1('\tCALL FC 1;'), fc1]);
    cpu.setMonitor({ kind: 'FC', number: 1 });
    cpu.run();
    cpu.cycle();
    expect(cpu.monitorSnapshot()!.length).toBeGreaterThan(0);
    const files = buildFiles([fc1]);
    cpu.loadBlock(files[0]!);
    expect(cpu.monitorSnapshot()).toBeUndefined();
    cpu.cycle();
    expect(cpu.monitorSnapshot()).toBeUndefined();
  });

  it('nessuna traccia senza monitor', () => {
    const cpu = makeCpu([ob1('\tCALL FC 1;'), fc1]);
    cpu.run();
    cpu.cycle();
    expect(cpu.monitorSnapshot()).toBeUndefined();
    cpu.setMonitor({ kind: 'FC', number: 1 });
    cpu.setMonitor(undefined);
    expect(cpu.monitorSnapshot()).toBeUndefined();
  });

  it('stack dei blocchi nella voce di STOP per un errore in FC2 chiamata da FC1', () => {
    const cpu = makeCpu([
      ob1('\tCALL FC 1;'),
      { kind: 'FC', number: 1, networks: ['\tNOP 0;\n\tCALL FC 2;'] },
      { kind: 'FC', number: 2, networks: ['\tNOP 0;\n\tL MB 4000;'] },
    ]);
    cpu.run();
    const r = cpu.cycle();
    expect(r.ok).toBe(false);
    const st = r.error!.stack!;
    expect(st.map((x) => `${x.kind}${x.number}`)).toEqual(['FC2', 'FC1', 'OB1']);
    expect(st[0]!.offset).toBe(r.error!.offset);
    expect(cpu.diagnostics.at(-1)!.stack).toEqual(st);
  });
});
