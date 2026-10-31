import { describe, expect, it } from 'vitest';
import { SimCpu, type SimCpuOptions } from '../src';
import { buildProgram } from './programHelpers';

const PROPS: SimCpuOptions['props'] = {
  maxCycleMs: 150,
  minCycleMs: 0,
  clockMemory: { enabled: false, byte: 0 },
  retentivity: { mBytes: 0, timers: 0, counters: 0 },
  cyclicInterruptMs: 0,
};

describe('proprietà della CPU senza riavvio', () => {
  it('merker di clock e OB35 cambiano al ciclo dopo, in RUN', () => {
    const clock = { t: 0 };
    const cpu = new SimCpu({ cpuTypeId: 'cpu-315-2-pn-dp', props: PROPS, now: () => clock.t });
    const p = buildProgram([
      { kind: 'OB', number: 1, networks: ['\tNOP 0;'] },
      { kind: 'OB', number: 35, networks: ['\tL MW 0;\n\tL 1;\n\t+I;\n\tT MW 0;'] },
    ]);
    for (const b of p.list()) cpu.program.put(b);
    cpu.run();
    clock.t = 150;
    cpu.cycle();
    expect(cpu.memory.M[100]).toBe(0);
    expect(cpu.memory.M[1]).toBe(0);
    cpu.setProps({ ...PROPS, clockMemory: { enabled: true, byte: 100 }, cyclicInterruptMs: 100 });
    cpu.cycle();
    expect(cpu.memory.M[100]! & 1).toBe(1); // 10 Hz: alto nella seconda metà di 100 ms
    clock.t = 250;
    cpu.cycle();
    expect(cpu.memory.M[1]).toBe(1);
    expect(cpu.mode).toBe('RUN');
  });
});
