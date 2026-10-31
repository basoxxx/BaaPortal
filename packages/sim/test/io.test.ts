import { findSystemBlock } from '@baaportal/catalog';
import type { AwlBlockInfo } from '@baaportal/awl';
import { describe, expect, it } from 'vitest';
import { SimCpu, type SimCpuOptions, type SimIoModule } from '../src';
import { buildProgram, type BlockSpec } from './programHelpers';

const PROPS: SimCpuOptions['props'] = {
  maxCycleMs: 150,
  minCycleMs: 0,
  clockMemory: { enabled: false, byte: 0 },
  retentivity: { mBytes: 0, timers: 0, counters: 0 },
  cyclicInterruptMs: 0,
};

/** DI a 4 byte (I 0..3) nel posto 4, DO a 2 byte (Q 4..5) nel posto 5, DI in una stazione DP. */
const IO: SimIoModule[] = [
  { id: 'di', name: 'DI32', rack: 0, slot: 4, inputs: { start: 0, bytes: 4 } },
  { id: 'do', name: 'DO16', rack: 0, slot: 5, outputs: { start: 4, bytes: 2 } },
  { id: 'dp', name: 'ET', rack: 0, slot: 1, station: 3, inputs: { start: 100, bytes: 2 } },
];

function sfcInfo(number: number): AwlBlockInfo {
  const b = findSystemBlock({ kind: 'SFC', number })!;
  return {
    name: b.name,
    kind: 'SFC',
    number,
    iface: {
      input: b.input,
      output: b.output,
      inOut: b.inOut,
      static: [],
      temp: [],
      returnType: { kind: 'elementary', name: b.returnType },
    },
  } as unknown as AwlBlockInfo;
}

function makeCpu(specs: BlockSpec[], io = IO): SimCpu {
  const cpu = new SimCpu({ cpuTypeId: 'cpu-315-2-pn-dp', props: PROPS, now: () => 0, io });
  const sfcs = [5, 49, 59].map(sfcInfo);
  for (const b of buildProgram(specs, {}, sfcs).list()) cpu.program.put(b);
  return cpu;
}
const ob = (number: number, ...networks: string[]): BlockSpec => ({ kind: 'OB', number, networks });
const mw = (cpu: SimCpu, at: number): number => (cpu.memory.M[at]! << 8) | cpu.memory.M[at + 1]!;

describe('immagine di processo e periferia dalla configurazione hardware', () => {
  it('la PII si aggiorna solo nei byte dei moduli, la PIQ va solo ai moduli', () => {
    const cpu = makeCpu([
      ob(1, '\tL IB 0;\n\tT MB 0;\n\tL IB 8;\n\tT MB 1;\n\tL W#16#FFFF;\n\tT QW 4;\n\tT QW 8;'),
    ]);
    cpu.run();
    cpu.memory.physIn.set([7], 0);
    cpu.memory.physIn.set([9], 8);
    cpu.cycle();
    expect([cpu.memory.M[0], cpu.memory.M[1]]).toEqual([7, 0]);
    expect([...cpu.memory.physOut.subarray(4, 10)]).toEqual([0xff, 0xff, 0, 0, 0, 0]);
  });

  it('periferia senza modulo → OB122 (o STOP), con il modulo si legge', () => {
    const cpu = makeCpu([ob(1, '\tL PIB 0;\n\tT MB 0;\n\tL PIB 8;\n\tT MB 1;')]);
    cpu.run();
    cpu.memory.physIn[0] = 5;
    cpu.cycle();
    expect(cpu.memory.M[0]).toBe(5);
    expect(cpu.mode).toBe('STOP');
    expect(cpu.diagnostics.at(-1)!.code).toBe('AREA_LUNGHEZZA');
  });

  it('senza configurazione tutto il campo della CPU resta raggiungibile', () => {
    const cpu = makeCpu([ob(1, '\tL PIB 8;\n\tT MB 1;')], []);
    cpu.run();
    cpu.memory.physIn[8] = 3;
    cpu.cycle();
    expect(cpu.mode).toBe('RUN');
    expect(cpu.memory.M[1]).toBe(3);
  });
});

describe('estrazione e inserimento dal pannello', () => {
  it('modulo centrale estratto: OB82 entrante con l’indirizzo, ingressi fermi, PIB → OB122', () => {
    const cpu = makeCpu([
      ob(1, '\tL IB 0;\n\tT MB 0;'),
      ob(82, '\tL LB 0;\n\tT MB 10;\n\tL LW 6;\n\tT MW 12;'),
      ob(122, '\tL MW 20;\n\tL 1;\n\t+I;\n\tT MW 20;'),
    ]);
    cpu.run();
    cpu.memory.physIn[0] = 1;
    cpu.cycle();
    cpu.setModulePresent('di', false);
    cpu.memory.physIn[0] = 2;
    cpu.cycle();
    expect(cpu.memory.M[10]).toBe(0x39);
    expect(mw(cpu, 12)).toBe(0);
    expect(cpu.memory.M[0]).toBe(1);
    expect(cpu.modulePresent('di')).toBe(false);
    cpu.setModulePresent('di', true);
    cpu.cycle();
    expect(cpu.memory.M[10]).toBe(0x38);
    expect(cpu.memory.M[0]).toBe(2);
  });

  it('modulo di una stazione: OB86', () => {
    const cpu = makeCpu([ob(1, '\tNOP 0;'), ob(86, '\tL LW 6;\n\tT MW 12;')]);
    cpu.run();
    cpu.setModulePresent('dp', false);
    cpu.cycle();
    expect(mw(cpu, 12)).toBe(100);
    expect(() => cpu.setModulePresent('zz', false)).toThrow(RangeError);
  });
});

describe('SFC 5, 49, 59 con la configurazione', () => {
  it('GADR_LGC e LGC_GADR traducono fra posto e indirizzo; RD_REC su un modulo → 16#80B0', () => {
    const cpu = makeCpu([
      ob(
        1,
        '\tCALL SFC 5 (SUBNETID := B#16#0, RACK := W#16#0, SLOT := W#16#5, SUBSLOT := B#16#0, SUBADDR := W#16#1, RET_VAL := MW 100, IOID := MB 10, LADDR := MW 12);',
        '\tCALL SFC 5 (SUBNETID := B#16#0, RACK := W#16#0, SLOT := W#16#5, SUBSLOT := B#16#0, SUBADDR := W#16#2, RET_VAL := MW 102, IOID := MB 11, LADDR := MW 14);',
        '\tCALL SFC 49 (IOID := B#16#54, LADDR := W#16#65, RET_VAL := MW 104, AREA := MB 16, RACK := MW 18, SLOT := MW 20, SUBADDR := MW 22);',
        '\tCALL SFC 59 (REQ := TRUE, IOID := B#16#54, LADDR := W#16#0, RECNUM := B#16#1, RET_VAL := MW 106, BUSY := M 40.1, RECORD := P#M 30.0 BYTE 4);',
      ),
    ]);
    cpu.run();
    cpu.cycle();
    expect([mw(cpu, 100), cpu.memory.M[10], mw(cpu, 12)]).toEqual([0, 0x55, 5]);
    expect(mw(cpu, 102)).toBe(0x809a);
    expect([mw(cpu, 104), cpu.memory.M[16], mw(cpu, 18), mw(cpu, 20), mw(cpu, 22)]).toEqual([
      0, 2, 3, 1, 1,
    ]);
    expect(mw(cpu, 106)).toBe(0x80b0);
  });
});
