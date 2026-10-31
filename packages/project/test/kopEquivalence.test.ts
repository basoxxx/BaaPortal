// Equivalenza KOP/AWL nel simulatore per ciò che il valutatore di packages/ladfbd non modella:
// temporizzatori, contatori, MCR, box CALL e box in virgola mobile. Lo stesso FC 1 scritto in
// KOP e in AWL (a mano, dal manuale, in una forma diversa da quella generata) gira in due CPU
// simulate con gli stessi ingressi e lo stesso orologio: uscite e merker devono coincidere a
// ogni ciclo.
import { SimCpu } from '@baaportal/sim';
import type { BoxKind, LadElem, LadNetwork, LadNode, LadOut } from '@baaportal/ladfbd';
import { describe, expect, it } from 'vitest';
import { blockToMc7File, createCodeBlock, type CodeBlock, type PlcDevice } from '../src/index';
import { cpu315pn, makeDevice, now, seq } from './fixtures';

let n = 0;
const id = () => `q${++n}`;
const c = (op: string, neg = false): LadElem => ({ id: id(), k: 'contact', neg, op });
type NoId<T> = T extends unknown ? Omit<T, 'id'> : never;
const out = (o: NoId<LadOut>): LadOut => ({ id: id(), ...o }) as LadOut;
const coil = (op: string) => out({ k: 'coil', op });
const box = (
  kind: BoxKind,
  instance: string,
  pins: Record<string, string>,
  boolPins: Record<string, LadElem[]> = {},
): LadElem => ({ id: id(), k: 'box', box: kind, instance, pins, boolPins });
const net = (series: LadElem[], outs: (LadOut | LadNode)[]): LadNetwork => ({
  root: { id: id(), series, outs },
});

type Extra = (dev: PlcDevice) => void;

/** CPU con FC 1 (KOP o AWL, un segmento per voce) chiamato da OB1; orologio comandato dal test. */
function cpuWith(fc1: (dev: PlcDevice) => CodeBlock, clock: { t: number }, extra?: Extra): SimCpu {
  const dev = makeDevice(seq('e'));
  dev.blocks.length = 0;
  extra?.(dev);
  dev.blocks.push(fc1(dev));
  const ob = createCodeBlock({ kind: 'OB', number: 1, name: 'Main', language: 'AWL' });
  ob.networks[0]!.source = '\tCALL FC 1;';
  dev.blocks.push(ob);
  const cpu = new SimCpu({
    cpuTypeId: 'cpu-315-2-pn-dp',
    props: {
      maxCycleMs: 150,
      minCycleMs: 0,
      clockMemory: { enabled: false, byte: 0 },
      retentivity: { mBytes: 16, timers: 2, counters: 2 },
      cyclicInterruptMs: 100,
    },
    now: () => clock.t,
  });
  for (const b of dev.blocks) {
    const r = blockToMc7File(b, dev, cpu315pn, now);
    expect(
      r.diagnostics.filter((d) => d.severity === 'error'),
      b.name,
    ).toEqual([]);
    cpu.loadBlock(r.file!);
  }
  cpu.run();
  return cpu;
}

const kopFc = (nets: LadNetwork[]) => () => {
  const b = createCodeBlock({ kind: 'FC', number: 1, name: 'K', language: 'KOP' });
  b.networks = nets.map((lad, i) => ({ ...b.networks[0]!, id: `k${i}`, lad }));
  return b;
};
const awlFc = (sources: string[]) => () => {
  const b = createCodeBlock({ kind: 'FC', number: 1, name: 'K', language: 'AWL' });
  b.networks = sources.map((source, i) => ({ ...b.networks[0]!, id: `a${i}`, source }));
  return b;
};

/** Passi: ingressi (byte IB0) e ms trascorsi prima del ciclo. */
type Step = { in: number; dt?: number };

/** Uscite, merker e (se servono) DW dei due programmi dopo ogni passo: devono coincidere. */
function expectSame(kop: LadNetwork[], awl: string[], steps: Step[], extra?: Extra): void {
  const ck = { t: 1_000_000 };
  const ca = { t: 1_000_000 };
  const k = cpuWith(kopFc(kop), ck, extra);
  const a = cpuWith(awlFc(awl), ca, extra);
  const snap = (cpu: SimCpu) => ({
    q: [...cpu.memory.physOut.slice(0, 8)],
    m: [...cpu.memory.M.slice(0, 64)],
  });
  const seen = new Set<string>();
  steps.forEach((s, i) => {
    for (const [cpu, clock] of [
      [k, ck],
      [a, ca],
    ] as const) {
      clock.t += s.dt ?? 10;
      cpu.memory.physIn[0] = s.in;
      expect(cpu.cycle().ok).toBe(true);
    }
    expect({ step: i, ...snap(k) }).toEqual({ step: i, ...snap(a) });
    seen.add(JSON.stringify(snap(k)));
  });
  // le uscite cambiano davvero lungo la prova (temporizzatori scaduti, contatori arrivati…)
  expect(seen.size).toBeGreaterThanOrEqual(3);
}

/** Un ciclo per combinazione di ingressi, più attese lunghe per i temporizzatori. */
const walk = (inputs: number[], dt = 10): Step[] => inputs.map((x) => ({ in: x, dt }));

describe('equivalenza KOP/AWL nel simulatore', () => {
  it('temporizzatore S_ODT a box (R, BI, BCD, Q) e bobina SE', () => {
    const kop = [
      net(
        [
          c('I 0.0'),
          box('S_ODT', 'T 1', { TV: 'S5T#200MS', BI: 'MW 10', BCD: 'MW 12' }, { R: [c('I 0.1')] }),
        ],
        [coil('Q 4.0')],
      ),
      net([c('I 0.2')], [out({ k: 'tcoil', fn: 'SE', timer: 'T 2', value: 'S5T#100MS' })]),
      net([c('T 2')], [coil('Q 4.1')]),
    ];
    const awl = [
      'A I 0.0\nL S5T#200MS\nSD T 1',
      'A I 0.1\nR T 1',
      'L T 1\nT MW 10\nLC T 1\nT MW 12',
      'A T 1\n= Q 4.0',
      'A I 0.2\nL S5T#100MS\nSE T 2\nA T 2\n= Q 4.1',
    ];
    expectSame(kop, awl, [
      ...walk([1, 1, 1], 50),
      ...walk([1, 1, 1, 1], 60),
      ...walk([3, 1, 0, 4, 0], 30),
      ...walk([0, 0, 0, 0], 40),
    ]);
  });

  it('contatore S_CUD a box (CU, CD, S con PV, R, CV, Q) e bobine CU/SC', () => {
    const kop = [
      net(
        [
          c('I 0.0'),
          box(
            'S_CUD',
            'C 1',
            { PV: 'C#5', CV: 'MW 20', CV_BCD: 'MW 22' },
            { CD: [c('I 0.1')], S: [c('I 0.2')], R: [c('I 0.3')] },
          ),
        ],
        [coil('Q 4.2')],
      ),
      net([c('I 0.4')], [out({ k: 'ccoil', fn: 'CU', counter: 'C 2', value: '' })]),
      net([c('I 0.5')], [out({ k: 'ccoil', fn: 'SC', counter: 'C 2', value: 'C#3' })]),
    ];
    const awl = [
      'A I 0.0\nCU C 1',
      'A I 0.1\nCD C 1',
      'A I 0.2\nL C#5\nS C 1',
      'A I 0.3\nR C 1',
      'L C 1\nT MW 20\nLC C 1\nT MW 22\nA C 1\n= Q 4.2',
      'A I 0.4\nCU C 2',
      'A I 0.5\nL C#3\nS C 2',
    ];
    const pulses = (bit: number, times: number) =>
      Array.from({ length: times }, () => [1 << bit, 0]).flat();
    expectSame(
      kop,
      awl,
      walk([
        ...pulses(2, 1),
        ...pulses(0, 3),
        ...pulses(1, 5),
        ...pulses(3, 1),
        ...pulses(0, 2),
        ...pulses(4, 4),
        ...pulses(5, 1),
        ...pulses(4, 2),
      ]),
    );
  });

  it('MCR: zona aperta da un contatto, bobine e S/R dentro, MCRA/MCRD', () => {
    const rail = (o: LadOut) => net([], [o]);
    const kop = [
      rail(out({ k: 'mcra' })),
      net([c('I 0.0')], [out({ k: 'mcrOpen' })]),
      net([c('I 0.1')], [coil('Q 4.3'), out({ k: 'set', op: 'M 1.0' })]),
      net([c('I 0.2')], [out({ k: 'reset', op: 'M 1.0' })]),
      rail(out({ k: 'mcrClose' })),
      net([c('I 0.1')], [coil('Q 4.4')]),
      rail(out({ k: 'mcrd' })),
    ];
    const awl = [
      'MCRA',
      'A I 0.0\nMCR(',
      'A I 0.1\n= Q 4.3\nS M 1.0',
      'A I 0.2\nR M 1.0',
      ')MCR',
      'A I 0.1\n= Q 4.4',
      'MCRD',
    ];
    expectSame(kop, awl, walk([0, 1, 3, 2, 3, 6, 4, 1, 0, 2, 7]));
  });

  it('box CALL di una FC con EN, parametri INT e BOOL con logica, ENO', () => {
    const callee: Extra = (dev) => {
      const fc = createCodeBlock({ kind: 'FC', number: 2, name: 'Piu', language: 'AWL' });
      fc.interface.input.push(
        { id: 'p-a', name: 'a', type: 'Int', comment: '' },
        { id: 'p-x', name: 'x', type: 'Bool', comment: '' },
      );
      fc.interface.output.push({ id: 'p-r', name: 'r', type: 'Int', comment: '' });
      // r := a + 1 (o + 100 con x); ENO = 0 con a = 0
      fc.networks[0]!.source =
        'L #a\nL 1\n+I\nT #r\nA #x\nJCN M1\nL #r\nL 100\n+I\nT #r\nM1: L #a\nL 0\n<>I\nSAVE';
      dev.blocks.push(fc);
    };
    const kop = [
      net(
        [
          c('I 0.0'),
          box('CALL', 'FC 2', { a: 'MW 30', r: 'MW 32' }, { x: [c('I 0.1'), c('I 0.2', true)] }),
        ],
        [coil('Q 4.5')],
      ),
      net([c('I 0.3')], [out({ k: 'set', op: 'M 2.0' })]),
    ];
    const awl = [
      'A I 0.1\nAN I 0.2\n= L 0.0',
      'A I 0.0\nJNB M1\nCALL FC 2\n(a := MW 30,\nx := L 0.0,\nr := MW 32);\nM1: A BR\n= Q 4.5',
      'A I 0.3\nS M 2.0',
    ];
    // MW 30 cambia fra i passi tramite I 0.4 → +1 (stesso codice nei due programmi)
    const inc = 'A I 0.4\nJCN M2\nL MW 30\nL 1\n+I\nT MW 30\nM2: NOP 0';
    const kop2 = [net([], [out({ k: 'callCoil', block: 'FC 3' })]), ...kop];
    const awl2 = ['UC FC 3', ...awl];
    const both: Extra = (dev) => {
      callee(dev);
      const f3 = createCodeBlock({ kind: 'FC', number: 3, name: 'Inc', language: 'AWL' });
      f3.networks[0]!.source = inc;
      dev.blocks.push(f3);
    };
    // il bit di appoggio del pin x è L 0.0 in tutti e due
    const steps = walk([0, 1, 3, 1, 16, 17, 19, 0, 5, 8, 9]);
    expectSame(kop2, [...awl2], steps, both);
  });

  it('box in virgola mobile: ADD_R, MUL_R, SQRT, DI_REAL, ROUND con ENO', () => {
    const init: Extra = (dev) => {
      const ob100 = createCodeBlock({ kind: 'OB', number: 100, name: 'Avvio', language: 'AWL' });
      ob100.networks[0]!.source = 'L 2.5\nT MD 0\nL -4.0\nT MD 4\nL L#7\nT MD 8';
      dev.blocks.push(ob100);
    };
    const kop = [
      net(
        [c('I 0.0'), box('ADD_R', '', { IN1: 'MD 0', IN2: 'MD 4', OUT: 'MD 12' })],
        [coil('Q 5.0')],
      ),
      net(
        [c('I 0.1'), box('MUL_R', '', { IN1: 'MD 0', IN2: 'MD 0', OUT: 'MD 16' })],
        [coil('Q 5.1')],
      ),
      net([c('I 0.2'), box('SQRT', '', { IN: 'MD 4', OUT: 'MD 20' })], [coil('Q 5.2')]),
      net([c('I 0.3'), box('DI_REAL', '', { IN: 'MD 8', OUT: 'MD 24' })], [coil('Q 5.3')]),
      net([c('I 0.4'), box('ROUND', '', { IN: 'MD 0', OUT: 'MD 28' })], [coil('Q 5.4')]),
    ];
    const enBox = (label: string, body: string, q: string, canFail: boolean) =>
      `JNB ${label}\n${body}\n${canFail ? 'AN OV\nSAVE\nCLR\n' : ''}${label}: A BR\n= ${q}`;
    const awl = [
      `A I 0.0\n${enBox('M1', 'L MD 0\nL MD 4\n+R\nT MD 12', 'Q 5.0', true)}`,
      `A I 0.1\n${enBox('M2', 'L MD 0\nL MD 0\n*R\nT MD 16', 'Q 5.1', true)}`,
      `A I 0.2\n${enBox('M3', 'L MD 4\nSQRT\nT MD 20', 'Q 5.2', true)}`,
      `A I 0.3\n${enBox('M4', 'L MD 8\nDTR\nT MD 24', 'Q 5.3', false)}`,
      `A I 0.4\n${enBox('M5', 'L MD 0\nRND\nT MD 28', 'Q 5.4', true)}`,
    ];
    expectSame(kop, awl, walk([0, 1, 2, 4, 8, 16, 31, 0]), init);
  });
});
