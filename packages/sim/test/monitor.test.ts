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

function makeCpu(specs: BlockSpec[], clock?: { t: number; step: number }): SimCpu {
  const cpu = new SimCpu({
    cpuTypeId: 'cpu-315-2-pn-dp',
    props: PROPS,
    now: clock
      ? () => {
          const v = clock.t;
          clock.t += clock.step;
          return v;
        }
      : () => 0,
  });
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
  it('last: la riga di FC1 chiamato due volte tiene la seconda esecuzione', () => {
    const fc: BlockSpec = {
      kind: 'FC',
      number: 1,
      networks: ['\tL MW 20;\n\tL 1;\n\t+I;\n\tT MW 20;'],
    };
    const run = (last: boolean): number => {
      const cpu = makeCpu([ob1('\tCALL FC 1;\n\tCALL FC 1;'), fc]);
      cpu.setMonitor({ kind: 'FC', number: 1, ...(last ? { last } : {}) });
      cpu.run();
      cpu.cycle();
      const steps = cpu.monitorSnapshot()!;
      return steps[steps.length - 1]!.accu1;
    };
    expect(run(false)).toBe(1);
    expect(run(true)).toBe(2);
  });

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

  it('FC1: esattamente 5 passi, l’ultimo è BE con lo stato prima dell’uscita', () => {
    const cpu = makeCpu([ob1('\tCALL FC 1;'), fc1]);
    cpu.setMonitor({ kind: 'FC', number: 1 });
    cpu.run();
    cpu.cycle();
    const s = cpu.monitorSnapshot()!;
    expect(s).toHaveLength(5);
    const be = s[4]!;
    expect(be.offset).toBe(cpu.program.get('FC', 1)!.code.length - 2);
    // BE ha ancora lo stato dell'ultima riga: prima dell'uscita (che imposta STA = 1) niente cambia
    expect(be.rlo).toBe(s[3]!.rlo);
    expect(be.accu1).toBe(s[3]!.accu1);
    expect(be.stw).toBe(s[3]!.stw);
  });

  it('un ciclo e una seconda chiamata non sovrascrivono i valori della prima esecuzione', () => {
    const loop: BlockSpec = {
      kind: 'FC',
      number: 3,
      networks: ['\tL MB 50;\n\tL 3;\nM001:\tT MB 20;\n\tLOOP M001;'],
    };
    const cpu = makeCpu([
      ob1('\tL 1;\n\tT MB 50;\n\tCALL FC 3;\n\tL 2;\n\tT MB 50;\n\tCALL FC 3;'),
      loop,
    ]);
    cpu.setMonitor({ kind: 'FC', number: 3 });
    cpu.run();
    cpu.cycle();
    const s = cpu.monitorSnapshot()!;
    expect(s).toHaveLength(5); // L, L, T, LOOP, BE: il giro del LOOP e la seconda chiamata non aggiungono
    expect(s[0]).toMatchObject({ accu1: 1 });
    expect(s[1]).toMatchObject({ accu1: 3, accu2: 1 });
    expect(s[2]).toMatchObject({ accu1: 3 }); // T alla prima passata
    expect(s[3]).toMatchObject({ accu1: 2 }); // LOOP alla prima passata
  });

  it('osserva un OB', () => {
    const cpu = makeCpu([ob1('\tL 4;\n\tT MW 10;')]);
    cpu.setMonitor({ kind: 'OB', number: 1 });
    cpu.run();
    cpu.cycle();
    const s = cpu.monitorSnapshot()!;
    expect(s).toHaveLength(3);
    expect(s[0]).toMatchObject({ offset: 0, accu1: 4 });
  });

  it('OB35 che interrompe il blocco osservato non si mescola all’OB1', () => {
    const clock = { t: 0, step: 0 };
    const nops = '\tNOP 0;\n'.repeat(1100);
    const cpu = makeCpu(
      [
        ob1('\tL 1;\n\tT MB 100;\n\tCALL FC 2;'),
        { kind: 'OB', number: 35, networks: ['\tL 99;\n\tT MB 100;\n\tCALL FC 2;'] },
        { kind: 'FC', number: 2, networks: [`\tL MB 100;\n${nops}\tT MB 101;`] },
      ],
      clock,
    );
    cpu.setMonitor({ kind: 'FC', number: 2 });
    cpu.run();
    clock.t = 95;
    clock.step = 2; // letture dell'orologio ogni 128 istruzioni (DEADLINE_EVERY)
    expect(cpu.cycle().ok).toBe(true);
    expect(cpu.memory.M[100]).toBe(99); // OB35 ha girato dentro FC2 (poi: L, nops e T dell'OB1)
    const s = cpu.monitorSnapshot()!;
    expect(s).toHaveLength(1 + 1100 + 1 + 1);
    expect(new Set(s.map((x) => x.accu1))).toEqual(new Set([1]));
  });

  it('stack con un errore dentro OB121: gestore, blocco che ha sbagliato, chiamanti', () => {
    const cpu = makeCpu([
      ob1('\tCALL FC 2;'),
      { kind: 'FC', number: 2, networks: ['\tNOP 0;\n\tL MB 4000;'] },
      ob121(),
    ]);
    cpu.run();
    const r = cpu.cycle();
    expect(r.ok).toBe(false);
    expect(r.error!.stack!.map((x) => `${x.kind}${x.number}`)).toEqual(['OB121', 'FC2', 'OB1']);
  });
});

function ob121(): BlockSpec {
  return { kind: 'OB', number: 121, networks: ['\tL MB 4000;'] };
}
