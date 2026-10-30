import { SimCpu } from '@baaportal/sim';
import { describe, expect, it } from 'vitest';
import {
  blockToMc7File,
  createCodeBlock,
  createInstanceDb,
  iecStandardLibrary,
  parseLibrary,
  type CodeBlock,
} from '../src/index';
import { cpu315pn, makeDevice, now, seq } from './fixtures';

const lib = iecStandardLibrary();
const blockOf = (name: string) =>
  structuredClone(lib.items.find((i) => i.name === name)!.blocks[0]!) as CodeBlock;

/** Esegue un ciclo di OB1 (AWL) con i blocchi della libreria dati; restituisce la CPU. */
function run(names: string[], ob1: string, cycles = 1, before?: (cpu: SimCpu) => void): SimCpu {
  const dev = makeDevice(seq('d'));
  dev.blocks.length = 0;
  for (const n of names) dev.blocks.push(blockOf(n));
  const ob = createCodeBlock({ kind: 'OB', number: 1, name: 'Main', language: 'AWL' });
  ob.networks[0]!.source = ob1;
  dev.blocks.push(ob);
  for (const n of names.filter((x) => blockOf(x).kind === 'FB')) {
    dev.blocks.push(
      createInstanceDb({ number: 10 + dev.blocks.length, name: `${n}_DB`, instanceOf: n }),
    );
  }
  const cpu = new SimCpu({
    cpuTypeId: 'cpu-315-2-pn-dp',
    props: {
      maxCycleMs: 150,
      minCycleMs: 0,
      clockMemory: { enabled: false, byte: 0 },
      retentivity: { mBytes: 16, timers: 2, counters: 2 },
      cyclicInterruptMs: 100,
    },
  });
  for (const b of dev.blocks) {
    const r = blockToMc7File(b, dev, cpu315pn, now);
    expect(
      r.diagnostics.filter((d) => d.severity === 'error'),
      b.name,
    ).toEqual([]);
    cpu.loadBlock(r.file!);
  }
  before?.(cpu);
  cpu.run();
  for (let i = 0; i < cycles; i++) expect(cpu.cycle().ok).toBe(true);
  return cpu;
}

const word = (cpu: SimCpu, at: number) =>
  (((cpu.memory.M[at]! << 8) | cpu.memory.M[at + 1]!) << 16) >> 16;
const dword = (cpu: SimCpu, at: number) =>
  new DataView(cpu.memory.M.buffer, cpu.memory.M.byteOffset).getInt32(at);
const real = (cpu: SimCpu, at: number) =>
  new DataView(cpu.memory.M.buffer, cpu.memory.M.byteOffset).getFloat32(at);
const bit = (cpu: SimCpu, at: number, b: number) => (cpu.memory.M[at]! >> b) & 1;

describe('libreria standard IEC', () => {
  it('è valida, con nomi e numeri unici, un FC per tipo e gli FB di fronte e bistabili', () => {
    expect(parseLibrary(JSON.parse(JSON.stringify(lib)))).toEqual(lib);
    const blocks = lib.items.flatMap((i) => i.blocks);
    expect(new Set(blocks.map((b) => b.name)).size).toBe(blocks.length);
    expect(new Set(blocks.map((b) => `${b.kind}${b.number}`)).size).toBe(blocks.length);
    expect(blocks.filter((b) => b.kind === 'FC')).toHaveLength(15);
    expect(blocks.filter((b) => b.kind === 'FB').map((b) => b.name)).toEqual([
      'R_TRIG',
      'F_TRIG',
      'SR',
      'RS',
    ]);
    expect(blocks.every((b) => b.number >= 500 && b.header.comment !== '')).toBe(true);
  });

  it('LIMIT, MAX, MIN, SEL e MUX su INT', () => {
    const cpu = run(
      ['LIMIT_INT', 'MAX_INT', 'MIN_INT', 'SEL_INT', 'MUX_INT'],
      [
        'CALL "LIMIT_INT" (MN := 0, IN := -5, MX := 100, RET_VAL := MW 0)',
        'CALL "LIMIT_INT" (MN := 0, IN := 50, MX := 100, RET_VAL := MW 2)',
        'CALL "LIMIT_INT" (MN := 0, IN := 300, MX := 100, RET_VAL := MW 4)',
        'CALL "MAX_INT" (IN1 := -3, IN2 := 7, RET_VAL := MW 6)',
        'CALL "MAX_INT" (IN1 := 9, IN2 := 7, RET_VAL := MW 8)',
        'CALL "MIN_INT" (IN1 := -3, IN2 := 7, RET_VAL := MW 10)',
        'CALL "MIN_INT" (IN1 := 9, IN2 := 7, RET_VAL := MW 12)',
        'CALL "SEL_INT" (G := FALSE, IN0 := 11, IN1 := 22, RET_VAL := MW 14)',
        'CALL "SEL_INT" (G := TRUE, IN0 := 11, IN1 := 22, RET_VAL := MW 16)',
        'CALL "MUX_INT" (K := 2, IN0 := 1, IN1 := 2, IN2 := 3, IN3 := 4, RET_VAL := MW 18)',
        'CALL "MUX_INT" (K := 0, IN0 := 1, IN1 := 2, IN2 := 3, IN3 := 4, RET_VAL := MW 20)',
        'CALL "MUX_INT" (K := 3, IN0 := 1, IN1 := 2, IN2 := 3, IN3 := 4, RET_VAL := MW 22)',
        'CALL "MUX_INT" (K := 4, IN0 := 1, IN1 := 2, IN2 := 3, IN3 := 4, RET_VAL := MW 24)',
        'SAVE',
        'A BR',
        '= M 30.0',
        'CALL "MUX_INT" (K := -1, IN0 := 1, IN1 := 2, IN2 := 3, IN3 := 4, RET_VAL := MW 26)',
        'A BR',
        '= M 30.1',
        'CALL "MUX_INT" (K := 1, IN0 := 1, IN1 := 2, IN2 := 3, IN3 := 4, RET_VAL := MW 28)',
        'A BR',
        '= M 30.2',
      ].join('\n'),
    );
    expect(
      [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28].map((a) => word(cpu, a)),
    ).toEqual([0, 50, 100, 7, 9, -3, 7, 11, 22, 3, 1, 4, 0, 0, 2]);
    // ENO (BR) è 0 con K fuori campo, 1 altrimenti.
    expect([bit(cpu, 30, 1), bit(cpu, 30, 2)]).toEqual([0, 1]);
  });

  it('le varianti DINT e REAL', () => {
    const cpu = run(
      [
        'LIMIT_DINT',
        'MAX_DINT',
        'MIN_DINT',
        'SEL_DINT',
        'MUX_DINT',
        'LIMIT_REAL',
        'MAX_REAL',
        'MIN_REAL',
        'SEL_REAL',
        'MUX_REAL',
      ],
      [
        'CALL "LIMIT_DINT" (MN := L#-100000, IN := L#-200000, MX := L#100000, RET_VAL := MD 0)',
        'CALL "MAX_DINT" (IN1 := L#70000, IN2 := L#-70000, RET_VAL := MD 4)',
        'CALL "MIN_DINT" (IN1 := L#70000, IN2 := L#-70000, RET_VAL := MD 8)',
        'CALL "SEL_DINT" (G := TRUE, IN0 := L#1, IN1 := L#123456, RET_VAL := MD 12)',
        'CALL "MUX_DINT" (K := 1, IN0 := L#1, IN1 := L#99999, IN2 := L#3, IN3 := L#4, RET_VAL := MD 16)',
        'CALL "LIMIT_REAL" (MN := 0.0, IN := 7.5, MX := 5.0, RET_VAL := MD 20)',
        'CALL "MAX_REAL" (IN1 := 1.5, IN2 := -2.5, RET_VAL := MD 24)',
        'CALL "MIN_REAL" (IN1 := 1.5, IN2 := -2.5, RET_VAL := MD 28)',
        'CALL "SEL_REAL" (G := FALSE, IN0 := 3.25, IN1 := 4.0, RET_VAL := MD 32)',
        'CALL "MUX_REAL" (K := 3, IN0 := 1.0, IN1 := 2.0, IN2 := 3.0, IN3 := 0.5, RET_VAL := MD 36)',
        'CALL "MUX_REAL" (K := 9, IN0 := 1.0, IN1 := 2.0, IN2 := 3.0, IN3 := 0.5, RET_VAL := MD 40)',
      ].join('\n'),
      1,
      (c) => c.memory.M.fill(0xff, 40, 44),
    );
    expect([0, 4, 8, 12, 16].map((a) => dword(cpu, a))).toEqual([
      -100000, 70000, -70000, 123456, 99999,
    ]);
    expect([20, 24, 28, 32, 36, 40].map((a) => real(cpu, a))).toEqual([5, 1.5, -2.5, 3.25, 0.5, 0]);
  });

  it('R_TRIG e F_TRIG danno un impulso di un ciclo sul fronte', () => {
    const ob1 = [
      'CALL "R_TRIG", "R_TRIG_DB" (CLK := M 0.0, Q := M 1.0)',
      'CALL "F_TRIG", "F_TRIG_DB" (CLK := M 0.0, Q := M 1.1)',
      // Conta gli impulsi: MB2 i fronti di salita, MB3 quelli di discesa.
      'A M 1.0',
      'JCN a1',
      'L MB 2',
      'INC 1',
      'T MB 2',
      'a1: A M 1.1',
      'JCN a2',
      'L MB 3',
      'INC 1',
      'T MB 3',
      'a2: NOP 0',
    ].join('\n');
    const dev = run(['R_TRIG', 'F_TRIG'], ob1, 0);
    const steps: [number, number, number][] = [];
    for (const clk of [0, 1, 1, 1, 0, 0, 1, 0]) {
      dev.memory.M[0] = clk;
      expect(dev.cycle().ok).toBe(true);
      steps.push([clk, bit(dev, 1, 0), bit(dev, 1, 1)]);
    }
    expect(steps).toEqual([
      [0, 0, 0],
      [1, 1, 0],
      [1, 0, 0],
      [1, 0, 0],
      [0, 0, 1],
      [0, 0, 0],
      [1, 1, 0],
      [0, 0, 1],
    ]);
    expect([dev.memory.M[2], dev.memory.M[3]]).toEqual([2, 2]);
  });

  it('SR a set dominante e RS a reset dominante', () => {
    const ob1 = [
      'CALL "SR", "SR_DB" (S1 := M 0.0, R := M 0.1, Q1 := M 1.0)',
      'CALL "RS", "RS_DB" (S := M 0.0, R1 := M 0.1, Q1 := M 1.1)',
    ].join('\n');
    const cpu = run(['SR', 'RS'], ob1, 0);
    const out: [number, number][] = [];
    // set, niente, reset, niente, set e reset insieme
    for (const m of [0b01, 0b00, 0b10, 0b00, 0b11]) {
      cpu.memory.M[0] = m;
      expect(cpu.cycle().ok).toBe(true);
      out.push([bit(cpu, 1, 0), bit(cpu, 1, 1)]);
    }
    expect(out).toEqual([
      [1, 1],
      [1, 1],
      [0, 0],
      [0, 0],
      [1, 0],
    ]);
  });
});
