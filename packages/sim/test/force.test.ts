import { describe, expect, it } from 'vitest';
import { SimCpu, simBackend, type SimCpuOptions } from '../src';
import { buildProgram, type BlockSpec } from './programHelpers';

const PROPS: SimCpuOptions['props'] = {
  maxCycleMs: 150,
  minCycleMs: 0,
  clockMemory: { enabled: false, byte: 0 },
  retentivity: { mBytes: 0, timers: 0, counters: 0 },
  cyclicInterruptMs: 0,
};

function makeCpu(...networks: string[]): SimCpu {
  const cpu = new SimCpu({ cpuTypeId: 'cpu-315-2-pn-dp', props: PROPS, now: () => 0 });
  const ob1: BlockSpec = { kind: 'OB', number: 1, networks };
  for (const b of buildProgram([ob1]).list()) cpu.program.put(b);
  return cpu;
}

describe('forzamento nel simulatore', () => {
  it('ingresso forzato: vale nella PII anche se il campo dice altro', () => {
    const cpu = makeCpu('\tA I 0.1;\n\t= M 10.0;\n\tL IB 1;\n\tT MB 11;');
    cpu.setForce([
      { area: 'I', byte: 0, bit: 1, size: 'X', data: Uint8Array.of(1) },
      { area: 'I', byte: 1, size: 'B', data: Uint8Array.of(0x5a) },
    ]);
    cpu.run();
    cpu.memory.physIn[1] = 0xff;
    cpu.cycle();
    expect(cpu.memory.M[10]! & 1).toBe(1);
    expect(cpu.memory.M[11]).toBe(0x5a);
  });

  it('uscita forzata: il programma la scrive, ma ai moduli va il valore forzato', () => {
    const cpu = makeCpu('\tL W#16#1234;\n\tT QW 2;\n\tL QB 2;\n\tT MB 20;');
    cpu.setForce([{ area: 'Q', byte: 2, size: 'B', data: Uint8Array.of(0xab) }]);
    cpu.run();
    cpu.cycle();
    // Il programma ha letto il proprio valore (S7-300: i valori forzati si possono sovrascrivere).
    expect(cpu.memory.M[20]).toBe(0x12);
    expect([...cpu.memory.physOut.subarray(2, 4)]).toEqual([0xab, 0x34]);
  });

  it('merker forzato all’inizio del ciclo; LED FRCE; tabella vuota termina', () => {
    const cpu = makeCpu('\tL MW 30;\n\tT MW 32;');
    expect(simBackend(cpu).forceActive).toBe(false);
    cpu.setForce([{ area: 'M', byte: 30, size: 'W', data: Uint8Array.of(0, 7) }]);
    expect(simBackend(cpu).forceActive).toBe(true);
    cpu.run();
    cpu.cycle();
    expect(cpu.memory.M[33]).toBe(7);
    cpu.setForce([]);
    expect(cpu.forceActive).toBe(false);
  });

  it('voce fuori area: tutta la tabella è rifiutata e resta quella di prima', () => {
    const cpu = makeCpu('\tNOP 0;');
    cpu.setForce([{ area: 'M', byte: 0, size: 'B', data: Uint8Array.of(1) }]);
    expect(() =>
      cpu.setForce([{ area: 'Q', byte: 99_999, size: 'B', data: Uint8Array.of(1) }]),
    ).toThrow(RangeError);
    expect(cpu.forceTable).toHaveLength(1);
  });

  it('la cancellazione totale termina il forzamento (⚠️)', () => {
    const cpu = makeCpu('\tNOP 0;');
    cpu.setForce([{ area: 'M', byte: 0, size: 'B', data: Uint8Array.of(1) }]);
    cpu.memoryReset();
    expect(cpu.forceActive).toBe(false);
  });
});
