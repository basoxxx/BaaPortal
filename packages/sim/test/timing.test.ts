import { findSystemBlock } from '@baaportal/catalog';
import type { AwlBlockInfo } from '@baaportal/awl';
import { readBlockFile } from '@baaportal/mc7';
import { describe, expect, it } from 'vitest';
import { SimCpu, type SimCpuOptions } from '../src';
import { buildFiles, buildProgram, type BlockSpec } from './programHelpers';

const PROPS: SimCpuOptions['props'] = {
  maxCycleMs: 150,
  minCycleMs: 0,
  clockMemory: { enabled: false, byte: 0 },
  retentivity: { mBytes: 0, timers: 0, counters: 0 },
  cyclicInterruptMs: 10,
};

const WAIT: AwlBlockInfo = (() => {
  const b = findSystemBlock({ kind: 'SFC', number: 47 })!;
  return {
    name: b.name,
    kind: 'SFC',
    number: 47,
    iface: {
      input: b.input,
      output: [],
      inOut: [],
      static: [],
      temp: [],
      returnType: { kind: 'void' },
    },
  } as unknown as AwlBlockInfo;
})();

function makeCpu(
  specs: BlockSpec[],
  props: Partial<SimCpuOptions['props']> = {},
  cpuTypeId = 'cpu-315-2-pn-dp',
) {
  const clock = { t: 0 };
  const cpu = new SimCpu({ cpuTypeId, props: { ...PROPS, ...props }, now: () => clock.t });
  for (const b of buildProgram(specs, {}, [WAIT]).list()) cpu.program.put(b);
  return { cpu, clock };
}
const ob = (number: number, ...networks: string[]): BlockSpec => ({ kind: 'OB', number, networks });
const nops = (n: number): string => '\tNOP 0;\n'.repeat(n);

describe('OB35: latenza e scadenze perse', () => {
  it('OB35 parte entro 128 istruzioni dalla scadenza, non al tick di 1024', () => {
    // WAIT porta il tempo oltre la scadenza; dopo 300 NOP l'OB1 scrive MW 30; OB35 copia MW 30 in MW 32.
    const { cpu } = makeCpu([
      ob(1, `\tCALL SFC 47 (WT := 12000);\n${nops(300)}\tL 1;\n\tT MW 30;`),
      ob(35, '\tL MW 30;\n\tT MW 32;\n\tL MW 34;\n\tL 1;\n\t+I;\n\tT MW 34;'),
    ]);
    cpu.run();
    cpu.cycle();
    expect(cpu.memory.M[35]).toBe(1);
    expect(cpu.memory.M[33]).toBe(0); // prima di `T MW 30`
  });

  it('avvii di OB35 saltati: voce ALLARME_PERSO (16#3503) con il numero', () => {
    const { cpu, clock } = makeCpu([ob(1, '\tNOP 0;'), ob(35, '\tNOP 0;')]);
    cpu.run();
    clock.t = 45; // scadenze a 10, 20, 30, 40: tre perse
    cpu.cycle();
    const lost = cpu.diagnostics.filter((d) => d.code === 'ALLARME_PERSO');
    expect(lost).toHaveLength(1);
    expect(lost[0]!.eventId).toBe(0x3503);
    expect(lost[0]!.detail).toContain('3 avvii');
  });
});

describe('OB80 in coda dentro OB82', () => {
  it('il superamento del tempo in OB82 fa partire OB80 dopo la fine di OB82, non annidato', () => {
    // OB82 aspetta 200 ms (oltre i 150 del ciclo); OB80 annota se OB82 era finito (MW 40 = 1).
    const { cpu } = makeCpu(
      [
        ob(1, nops(1100)),
        ob(82, `\tCALL SFC 47 (WT := 30000);\n`.repeat(7) + '\tL 1;\n\tT MW 40;'),
        ob(80, '\tL MW 40;\n\tT MW 42;'),
      ],
      { cyclicInterruptMs: 0 },
    );
    cpu.run();
    cpu.raiseInterrupt(82, { address: 0 });
    expect(cpu.cycle().ok).toBe(true);
    expect(cpu.memory.M[43]).toBe(1);
  });
});

describe('profondità dei blocchi dal catalogo', () => {
  const chain = (n: number): BlockSpec[] => [
    ob(1, '\tUC FC 1;'),
    ...Array.from({ length: n }, (_, i) => ({
      kind: 'FC' as const,
      number: i + 1,
      networks: [i + 1 < n ? `\tUC FC ${i + 2};` : '\tSET;\n\t= M 0.0;'],
    })),
  ];

  it('CPU 312: 8 blocchi annidati riescono, 9 danno STACK_BLOCCHI_PIENO', () => {
    const ok = makeCpu(chain(8), { cyclicInterruptMs: 0 }, 'cpu-312');
    ok.cpu.run();
    ok.cpu.cycle();
    expect(ok.cpu.memory.M[0]).toBe(1);
    const ko = makeCpu(chain(9), { cyclicInterruptMs: 0 }, 'cpu-312');
    ko.cpu.run();
    ko.cpu.cycle();
    expect(ko.cpu.diagnostics.at(-1)!.code).toBe('STACK_BLOCCHI_PIENO');
  });
});

describe('download', () => {
  it('un blocco con la sezione ADD corrotta è rifiutato, quello buono si carica', () => {
    const [file] = buildFiles([ob(1, '\tNOP 0;', '\tNOP 0;')]);
    const cpu = new SimCpu({ cpuTypeId: 'cpu-315-2-pn-dp', props: PROPS });
    cpu.loadBlock(file!);
    const add = readBlockFile(file!).addRaw;
    const bad = file!.slice();
    const at = indexOf(bad, add);
    bad[at] = 0xff; // numero di reti impossibile
    bad[at + 1] = 0x7f;
    expect(() => cpu.loadBlock(bad)).toThrow(/ADD/);
  });
});

function indexOf(hay: Uint8Array, needle: Uint8Array): number {
  for (let i = 0; i + needle.length <= hay.length; i++)
    if (needle.every((b, j) => hay[i + j] === b)) return i;
  throw new Error('ADD non trovata');
}
