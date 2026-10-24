import { findSystemBlock } from '@baaportal/catalog';
import type { AwlBlockInfo } from '@baaportal/awl';
import { describe, expect, it } from 'vitest';
import { SimCpu, type SimCpuOptions } from '../src';
import { buildProgram, el, m, named, sec, type BlockSpec } from './programHelpers';

const PROPS: SimCpuOptions['props'] = {
  maxCycleMs: 150,
  minCycleMs: 0,
  clockMemory: { enabled: false, byte: 0 },
  retentivity: { mBytes: 16, timers: 2, counters: 2 },
  cyclicInterruptMs: 0,
};

/** Interfaccia di un SFB del catalogo nella forma che il compilatore si aspetta. */
function sfbInfo(number: number): AwlBlockInfo {
  const b = findSystemBlock({ kind: 'SFB', number });
  if (!b) throw new Error(`SFB${number} assente dal catalogo`);
  return {
    name: b.name,
    kind: 'SFB',
    number,
    iface: {
      input: b.input,
      output: b.output,
      inOut: [],
      static: [],
      temp: [],
      returnType: { kind: 'void' },
    },
  } as unknown as AwlBlockInfo;
}

const SFBS = [0, 1, 2, 3, 4, 5].map(sfbInfo);
const idb = (db: number, name: string): AwlBlockInfo =>
  ({ name: `IDB${db}`, kind: 'IDB', number: db, instanceOf: name }) as unknown as AwlBlockInfo;

const ob1 = (...networks: string[]): BlockSpec => ({ kind: 'OB', number: 1, networks });

function makeCpu(specs: BlockSpec[], idbs: AwlBlockInfo[], dbs: Record<number, number>) {
  const clock = { t: 0 };
  const cpu = new SimCpu({ cpuTypeId: 'cpu-315-2-pn-dp', props: PROPS, now: () => clock.t });
  for (const b of buildProgram(specs, {}, [...SFBS, ...idbs]).list()) cpu.program.put(b);
  for (const [n, len] of Object.entries(dbs))
    cpu.memory.dbs.set(Number(n), {
      data: new Uint8Array(len),
      initial: new Uint8Array(len),
      retentive: false,
    });
  return { cpu, clock };
}

const dword = (b: Uint8Array, at: number): number =>
  (b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]! | 0;
const int = (b: Uint8Array, at: number): number => (((b[at]! << 8) | b[at + 1]!) << 16) >> 16;

/** Un ciclo con M0.0 = `inp` all'istante `t`. */
function step(c: ReturnType<typeof makeCpu>, t: number, ...bits: [number, number][]) {
  c.clock.t = t;
  for (const [byte, v] of bits) c.cpu.memory.M[byte] = v;
  c.cpu.cycle();
}

const TIMER = (sfb: number, name: string) => {
  const c = makeCpu(
    [ob1(`\tCALL SFB ${sfb}, DB 5 (IN := M 0.0, PT := T#5S, Q := M 1.0, ET := MD 4);`)],
    [idb(5, name)],
    { 5: 12 },
  );
  c.cpu.run();
  return c;
};
const q = (c: ReturnType<typeof makeCpu>) => c.cpu.memory.M[1]! & 1;
const et = (c: ReturnType<typeof makeCpu>) => dword(c.cpu.memory.M, 4);

describe('TON (SFB 4) in un DB di istanza', () => {
  it('Q dopo PT con IN = 1, ET si ferma a PT, torna a 0 con IN = 0', () => {
    const c = TIMER(4, 'TON');
    step(c, 0, [0, 1]);
    expect([q(c), et(c)]).toEqual([0, 0]);
    step(c, 2000, [0, 1]);
    expect([q(c), et(c)]).toEqual([0, 2000]);
    step(c, 5000, [0, 1]);
    expect([q(c), et(c)]).toEqual([1, 5000]);
    step(c, 9000, [0, 1]);
    expect([q(c), et(c)]).toEqual([1, 5000]);
    step(c, 9500, [0, 0]);
    expect([q(c), et(c)]).toEqual([0, 0]);
    expect(c.cpu.memory.dbs.get(5)!.data[6]! & 1).toBe(0);
    expect(c.cpu.mode).toBe('RUN');
  });
  it('PT negativo è trattato come 0 (⚠️)', () => {
    const c = makeCpu(
      [ob1('\tCALL SFB 4, DB 5 (IN := M 0.0, PT := T#-5S, Q := M 1.0, ET := MD 4);')],
      [idb(5, 'TON')],
      { 5: 12 },
    );
    c.cpu.run();
    step(c, 0, [0, 1]);
    expect([q(c), et(c)]).toEqual([1, 0]);
  });
});

describe('TP (SFB 3)', () => {
  it('non riavviabile durante l’impulso; ET a 0 con IN = 0 a impulso finito', () => {
    const c = TIMER(3, 'TP');
    step(c, 0, [0, 0]);
    step(c, 1000, [0, 1]);
    expect([q(c), et(c)]).toEqual([1, 0]);
    step(c, 3000, [0, 0]);
    expect([q(c), et(c)]).toEqual([1, 2000]);
    step(c, 4000, [0, 1]); // nuovo fronte durante l'impulso: ignorato
    expect([q(c), et(c)]).toEqual([1, 3000]);
    step(c, 6000, [0, 1]); // 5 s dal primo fronte
    expect([q(c), et(c)]).toEqual([0, 5000]);
    step(c, 7000, [0, 1]);
    expect([q(c), et(c)]).toEqual([0, 5000]);
    step(c, 8000, [0, 0]);
    expect([q(c), et(c)]).toEqual([0, 0]);
    step(c, 9000, [0, 1]); // di nuovo avviabile
    expect(q(c)).toBe(1);
  });
});

describe('TOF (SFB 5)', () => {
  it('Q = 1 con IN = 1; Q = 0 dopo PT dal fronte di discesa', () => {
    const c = TIMER(5, 'TOF');
    step(c, 0, [0, 0]);
    expect([q(c), et(c)]).toEqual([0, 0]);
    step(c, 1000, [0, 1]);
    expect([q(c), et(c)]).toEqual([1, 0]);
    step(c, 2000, [0, 0]);
    expect([q(c), et(c)]).toEqual([1, 0]);
    step(c, 4000, [0, 0]);
    expect([q(c), et(c)]).toEqual([1, 2000]);
    step(c, 7000, [0, 0]);
    expect([q(c), et(c)]).toEqual([0, 5000]);
    step(c, 9000, [0, 0]);
    expect([q(c), et(c)]).toEqual([0, 5000]);
    step(c, 9500, [0, 1]);
    expect([q(c), et(c)]).toEqual([1, 0]);
  });
});

describe('contatori IEC', () => {
  const counter = (sfb: number, name: string, call: string) => {
    const c = makeCpu([ob1(call)], [idb(5, name)], { 5: 12 });
    c.cpu.run();
    return c;
  };
  const pulse = (c: ReturnType<typeof makeCpu>, byte: number, bit: number, extra = 0) => {
    step(c, 0, [byte, extra | (1 << bit)]);
    step(c, 0, [byte, extra]);
  };
  const cv = (c: ReturnType<typeof makeCpu>) => int(c.cpu.memory.M, 4);

  it('CTU: conta sul fronte di CU, Q = CV ≥ PV, R azzera, saturazione', () => {
    const c = counter(
      0,
      'CTU',
      '\tCALL SFB 0, DB 5 (CU := M 0.0, R := M 0.1, PV := 2, Q := M 1.0, CV := MW 4);',
    );
    pulse(c, 0, 0);
    expect([cv(c), q(c)]).toEqual([1, 0]);
    step(c, 0, [0, 1]);
    step(c, 0, [0, 1]); // livello alto: nessun nuovo fronte
    expect([cv(c), q(c)]).toEqual([2, 1]);
    step(c, 0, [0, 2]); // R
    expect([cv(c), q(c)]).toEqual([0, 0]);
    c.cpu.memory.dbs.get(5)!.data.set([0x7f, 0xff], 6); // CV (INT) a 32767
    step(c, 0, [0, 0]);
    step(c, 0, [0, 1]);
    expect(int(c.cpu.memory.dbs.get(5)!.data, 6)).toBe(32767);
  });

  it('CTD: LOAD carica PV, conta in giù, Q = CV ≤ 0', () => {
    const c = counter(
      1,
      'CTD',
      '\tCALL SFB 1, DB 5 (CD := M 0.0, LOAD := M 0.1, PV := 2, Q := M 1.0, CV := MW 4);',
    );
    step(c, 0, [0, 2]);
    expect([cv(c), q(c)]).toEqual([2, 0]);
    pulse(c, 0, 0);
    expect([cv(c), q(c)]).toEqual([1, 0]);
    pulse(c, 0, 0);
    expect([cv(c), q(c)]).toEqual([0, 1]);
    pulse(c, 0, 0);
    expect([cv(c), q(c)]).toEqual([-1, 1]);
  });

  it('CTUD: CU, CD, R e LOAD', () => {
    const c = counter(
      2,
      'CTUD',
      '\tCALL SFB 2, DB 5 (CU := M 0.0, CD := M 0.1, R := M 0.2, LOAD := M 0.3, PV := 2, QU := M 1.0, QD := M 1.1, CV := MW 4);',
    );
    step(c, 0, [0, 0]);
    expect([cv(c), c.cpu.memory.M[1]]).toEqual([0, 2]); // CV = 0: QD
    pulse(c, 0, 0);
    pulse(c, 0, 0);
    expect([cv(c), c.cpu.memory.M[1]]).toEqual([2, 1]); // QU
    pulse(c, 0, 1);
    expect([cv(c), c.cpu.memory.M[1]]).toEqual([1, 0]);
    step(c, 0, [0, 8]); // LOAD
    expect(cv(c)).toBe(2);
    step(c, 0, [0, 4]); // R
    expect([cv(c), c.cpu.memory.M[1]]).toEqual([0, 2]);
  });
});

describe('multi-istanza e stato', () => {
  const FB1: BlockSpec = {
    kind: 'FB',
    number: 1,
    sections: sec({
      in: [m('A', el('Bool')), m('B', el('Bool'))],
      out: [m('QA', el('Bool')), m('QB', el('Bool'))],
      stat: [m('T1', named('TON')), m('T2', named('TON'))],
    }),
    networks: [
      '\tCALL #T1 (IN := #A, PT := T#2S, Q := #QA);\n\tCALL #T2 (IN := #B, PT := T#4S, Q := #QB);',
    ],
  };
  const make = () => {
    const c = makeCpu(
      [ob1('\tCALL FB 1, DB 7 (A := M 0.0, B := M 0.1, QA := M 1.0, QB := M 1.1);'), FB1],
      [idb(7, 'FB1')],
      { 7: 40 },
    );
    c.cpu.run();
    return c;
  };

  it('due TON nello stesso FB: stati indipendenti', () => {
    const c = make();
    step(c, 0, [0, 1]); // solo A
    step(c, 2500, [0, 1]);
    expect(c.cpu.memory.M[1]).toBe(1); // QA
    step(c, 3000, [0, 3]); // parte B
    step(c, 6000, [0, 3]); // B: 3 s su 4
    expect(c.cpu.memory.M[1]).toBe(1);
    step(c, 7500, [0, 3]); // B: 4,5 s
    expect(c.cpu.memory.M[1]).toBe(3);
  });

  it('stato azzerato a STOP→RUN', () => {
    const c = TIMER(4, 'TON');
    step(c, 0, [0, 1]);
    step(c, 5000, [0, 1]);
    expect(q(c)).toBe(1);
    c.cpu.stop();
    c.clock.t = 6000;
    c.cpu.run();
    step(c, 6000, [0, 1]); // riparte da zero, non da 0 s
    expect([q(c), et(c)]).toEqual([0, 0]);
  });
});
