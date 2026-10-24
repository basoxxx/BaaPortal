import { decodeInstruction } from '@baaportal/mc7';
import { describe, expect, it } from 'vitest';
import { SimCpu, simBackend, type DiagEntry, type SimCpuOptions } from '../src';
import { buildProgram, type BlockSpec } from './programHelpers';

const PROPS: SimCpuOptions['props'] = {
  maxCycleMs: 150,
  minCycleMs: 0,
  clockMemory: { enabled: false, byte: 0 },
  retentivity: { mBytes: 16, timers: 2, counters: 2 },
  cyclicInterruptMs: 100,
};

/** CPU con orologio a mano: `clock.t` si muove a mano, `clock.step` lo avanza a ogni lettura. */
function makeCpu(
  specs: BlockSpec[],
  over: Partial<SimCpuOptions['props']> = {},
  extra: Partial<SimCpuOptions> = {},
): { cpu: SimCpu; clock: { t: number; step: number } } {
  const clock = { t: 0, step: 0 };
  const cpu = new SimCpu({
    cpuTypeId: 'cpu-315-2-pn-dp',
    props: { ...PROPS, ...over },
    now: () => {
      const v = clock.t;
      clock.t += clock.step;
      return v;
    },
    ...extra,
  });
  for (const b of buildProgram(specs).list()) cpu.program.put(b);
  return { cpu, clock };
}

const ob = (number: number, ...networks: string[]): BlockSpec => ({
  kind: 'OB',
  number,
  networks,
});

/** Copia i 20 byte dei dati di avvio (L 0..19) in MB `at`..`at+19` e conta i richiami in MW `count`. */
const copyStartInfo = (at: number, count: number): string =>
  [0, 4, 8, 12, 16].map((o) => `\tL LD ${o};\n\tT MD ${at + o};`).join('\n') +
  `\n\tL MW ${count};\n\tL 1;\n\t+I;\n\tT MW ${count};`;

const mb = (cpu: SimCpu, from: number, n: number): number[] =>
  Array.from(cpu.memory.M.subarray(from, from + n));
const mw = (cpu: SimCpu, at: number): number => (cpu.memory.M[at]! << 8) | cpu.memory.M[at + 1]!;

/** Offset MC7 dell'istruzione numero `index` (da 0) del blocco. */
function offsetOf(cpu: SimCpu, kind: string, number: number, index: number): number {
  const code = cpu.program.get(kind, number)!.code;
  let at = 0;
  for (let i = 0; i < index; i++) at += decodeInstruction(code, at).length;
  return at;
}

const ids = (cpu: SimCpu): number[] =>
  simBackend(cpu).diagnosticRecords.map((r) => (r[0]! << 8) | r[1]!);

const called = (cpu: SimCpu): DiagEntry[] =>
  cpu.diagnostics.filter((d) => d.code === 'OB_RICHIAMATO');

describe('OB121 e OB122', () => {
  it('OB121 caricato: area fuori campo → OB121 con SW_FLT 16#22 e PRG_ADDR, poi l’OB1 continua e scrive M dopo', () => {
    const { cpu } = makeCpu([
      ob(1, '\tL 3;\n\tL 7;\n\tL MW 4000;\n\t+I;\n\tT MW 10;'),
      // L'OB121 sporca accumulatori e DB: al ritorno l'OB1 deve ritrovare i suoi registri.
      ob(121, copyStartInfo(100, 120) + '\n\tL 99;\n\tL 98;'),
    ]);
    cpu.run();
    const r = cpu.cycle();
    expect(r.ok).toBe(true);
    expect(cpu.mode).toBe('RUN');
    expect(mw(cpu, 10)).toBe(10); // ACCU1 = 7 e ACCU2 = 3 come prima della lettura fallita
    expect(mw(cpu, 120)).toBe(1);
    const prgAddr = offsetOf(cpu, 'OB', 1, 2);
    expect(mb(cpu, 100, 12)).toEqual([
      0x25, // EV_CLASS
      0x22, // SW_FLT: area in lettura
      1, // priorità dell'interrotto (OB1)
      121,
      0x88, // BLK_TYPE: OB
      0,
      0,
      0, // FLT_REG
      0,
      1, // BLK_NUM
      prgAddr >> 8,
      prgAddr & 255,
    ]);
    expect(called(cpu)).toMatchObject([{ eventId: 0x2522, block: 'OB1', offset: prgAddr }]);
  });

  it('scrittura fuori campo con OB121: SW_FLT 16#23, nessun byte scritto, si prosegue', () => {
    const { cpu } = makeCpu([
      ob(1, '\tL DW#16#11223344;\n\tT MD 2046;\n\tT MD 20;'),
      ob(121, copyStartInfo(100, 120)),
    ]);
    cpu.run();
    expect(cpu.cycle().ok).toBe(true);
    expect(mb(cpu, 2046, 2)).toEqual([0, 0]);
    expect(mb(cpu, 20, 4)).toEqual([0x11, 0x22, 0x33, 0x44]);
    expect(cpu.memory.M[101]).toBe(0x23);
    expect(called(cpu)[0]?.eventId).toBe(0x2523);
  });

  it('OB121 assente → STOP con id 16#2522', () => {
    const { cpu } = makeCpu([ob(1, '\tL MW 4000;\n\tT MW 10;')]);
    cpu.run();
    const r = cpu.cycle();
    expect(r.ok).toBe(false);
    expect(cpu.mode).toBe('STOP');
    expect(r.error).toMatchObject({ code: 'AREA_LUNGHEZZA', eventId: 0x2522, block: 'OB1' });
  });

  it.each([
    ['\tL DW#16#11223344;\n\tT MD 2046;', 0x2523],
    ['\tOPN DB 99;', 0x253a],
    ['\tUC FC 9;', 0x253c],
    ['\tUC FB 9;', 0x253e],
    ['\tL T 300;', 0x2526],
    ['\tL C 300;', 0x2527],
    ['\tL W#16#000A;\n\tBTI;', 0x2521],
  ])('senza OB121: %j → STOP con id del manuale %s', (code, id) => {
    // FC9 e FB9 servono solo alla compilazione: alla CPU mancano.
    const { cpu } = makeCpu([
      ob(1, code),
      { kind: 'FC', number: 9, networks: ['\tNOP 0;'] },
      { kind: 'FB', number: 9, networks: ['\tNOP 0;'] },
    ]);
    cpu.program.delete('FC', 9);
    cpu.program.delete('FB', 9);
    cpu.run();
    const r = cpu.cycle();
    expect(cpu.mode).toBe('STOP');
    expect(r.error?.eventId).toBe(id);
  });

  it('FLT_REG porta il numero del DB non caricato', () => {
    const { cpu } = makeCpu([
      ob(1, '\tOPN DB 99;\n\tL 1;\n\tT MW 10;'),
      ob(121, copyStartInfo(100, 120)),
    ]);
    cpu.run();
    expect(cpu.cycle().ok).toBe(true);
    expect(mb(cpu, 100, 8)).toEqual([0x25, 0x3a, 1, 121, 0x88, 0, 0, 99]);
    expect(mw(cpu, 10)).toBe(1);
  });

  it('errore in un FC: OB121 con blocco FC e numero, poi l’FC prosegue', () => {
    const { cpu } = makeCpu([
      ob(1, '\tCALL FC 2;\n\tL 5;\n\tT MW 12;'),
      { kind: 'FC', number: 2, networks: ['\tL MW 4000;\n\tL 4;\n\tT MW 10;'] },
      ob(121, copyStartInfo(100, 120)),
    ]);
    cpu.run();
    expect(cpu.cycle().ok).toBe(true);
    expect(mw(cpu, 10)).toBe(4);
    expect(mw(cpu, 12)).toBe(5);
    expect(mb(cpu, 104, 6)).toEqual([0x8c, 0, 0, 0, 0, 2]);
  });

  it('errore dentro OB121 → STOP con le due voci', () => {
    const { cpu } = makeCpu([ob(1, '\tL MW 4000;\n\tL 1;\n\tT MW 10;'), ob(121, '\tL MW 5000;')]);
    cpu.run();
    const r = cpu.cycle();
    expect(r.ok).toBe(false);
    expect(cpu.mode).toBe('STOP');
    expect(mw(cpu, 10)).toBe(0);
    expect(cpu.diagnostics.slice(-2)).toMatchObject([
      { code: 'OB_RICHIAMATO', eventId: 0x2522, block: 'OB1' },
      { code: 'AREA_LUNGHEZZA', eventId: 0x2522, block: 'OB121' },
    ]);
  });

  it('OB122 per PIW oltre il campo', () => {
    const { cpu } = makeCpu([
      ob(1, '\tL 7;\n\tL PIW 3000;\n\tT MW 10;'),
      ob(122, copyStartInfo(100, 120)),
    ]);
    cpu.run();
    expect(cpu.cycle().ok).toBe(true);
    expect(mw(cpu, 10)).toBe(7);
    const prgAddr = offsetOf(cpu, 'OB', 1, 1);
    expect(mb(cpu, 100, 12)).toEqual([
      0x29,
      0x42, // lettura dalla periferia
      1,
      122,
      0x88,
      0x20, // MEM_AREA: parola, area di periferia
      3000 >> 8,
      3000 & 255,
      0,
      1,
      prgAddr >> 8,
      prgAddr & 255,
    ]);
    expect(called(cpu)[0]?.eventId).toBe(0x2942);
  });

  it('PQW oltre il campo senza OB122 → STOP 16#2943 anche con OB121 caricato', () => {
    const { cpu } = makeCpu([ob(1, '\tL 1;\n\tT PQW 3000;'), ob(121, copyStartInfo(100, 120))]);
    cpu.run();
    const r = cpu.cycle();
    expect(cpu.mode).toBe('STOP');
    expect(r.error?.eventId).toBe(0x2943);
    expect(mw(cpu, 120)).toBe(0);
  });

  it('gli errori senza OB (stack dei blocchi pieno) vanno comunque in STOP', () => {
    const { cpu } = makeCpu([
      ob(1, '\tCALL FC 2;'),
      { kind: 'FC', number: 2, networks: ['\tCALL FC 2;'] },
      ob(121, copyStartInfo(100, 120)),
    ]);
    cpu.run();
    const r = cpu.cycle();
    expect(cpu.mode).toBe('STOP');
    expect(r.error?.code).toBe('STACK_BLOCCHI_PIENO');
    expect(mw(cpu, 120)).toBe(0);
  });
});

/** Ciclo lungo: `n` giri di LOOP (3 istruzioni ciascuno), poi scrive MW 10 = 1. */
const longOb1 = (n: number): BlockSpec =>
  ob(1, `\tL ${n};\nx: T MW 50;\n\tL MW 50;\n\tLOOP x;\n\tL 1;\n\tT MW 10;`);

describe('OB80', () => {
  it('OB80 al primo sforamento (limite di istruzioni), il ciclo continua', () => {
    const { cpu } = makeCpu(
      [longOb1(1300), ob(80, copyStartInfo(100, 120))],
      { maxCycleMs: 1e6 },
      {
        maxInstructions: 3000,
      },
    );
    cpu.run();
    const r = cpu.cycle();
    expect(r.ok).toBe(true);
    expect(mw(cpu, 10)).toBe(1);
    expect(mw(cpu, 120)).toBe(1);
    expect(mb(cpu, 100, 4)).toEqual([0x35, 0x01, 26, 80]);
    expect(called(cpu)[0]?.eventId).toBe(0x3501);
  });

  it('OB80 al primo sforamento, STOP al secondo nello stesso ciclo', () => {
    const { cpu } = makeCpu(
      [longOb1(2500), ob(80, copyStartInfo(100, 120))],
      { maxCycleMs: 1e6 },
      {
        maxInstructions: 3000,
      },
    );
    cpu.run();
    const r = cpu.cycle();
    expect(r.ok).toBe(false);
    expect(cpu.mode).toBe('STOP');
    expect(mw(cpu, 120)).toBe(1);
    expect(r.error).toMatchObject({ code: 'TEMPO_CICLO_SUPERATO', eventId: 0x3501 });
  });

  it('il limite si azzera a ogni ciclo: un solo sforamento per ciclo non porta in STOP', () => {
    const { cpu } = makeCpu(
      [longOb1(1300), ob(80, copyStartInfo(100, 120))],
      { maxCycleMs: 1e6 },
      {
        maxInstructions: 3000,
      },
    );
    cpu.run();
    for (let i = 0; i < 3; i++) expect(cpu.cycle().ok).toBe(true);
    expect(mw(cpu, 120)).toBe(3);
  });

  it('tempo di ciclo superato a orologio (fine ciclo): OB80 con il tempo, poi RUN', () => {
    const { cpu, clock } = makeCpu([ob(1, '\tL 1;\n\tT MW 10;'), ob(80, copyStartInfo(100, 120))], {
      cyclicInterruptMs: 0,
    });
    cpu.run();
    clock.step = 200;
    const r = cpu.cycle();
    expect(r.ok).toBe(true);
    expect(cpu.mode).toBe('RUN');
    expect(mw(cpu, 120)).toBe(1);
    expect(mw(cpu, 106)).toBe(200); // OB80_ERROR_INFO: tempo del ciclo
  });

  it('senza OB80 lo sforamento porta in STOP come prima', () => {
    const { cpu } = makeCpu([longOb1(1300)], { maxCycleMs: 1e6 }, { maxInstructions: 3000 });
    cpu.run();
    expect(cpu.cycle().ok).toBe(false);
    expect(cpu.mode).toBe('STOP');
  });

  it('OB80 che sfora a sua volta → STOP, senza ricorsione', () => {
    const { cpu } = makeCpu(
      [longOb1(1300), ob(80, '\tL 5000;\nx: NOP 0;\n\tLOOP x;')],
      { maxCycleMs: 1e6 },
      {
        maxInstructions: 3000,
      },
    );
    cpu.run();
    expect(cpu.cycle().ok).toBe(false);
    expect(cpu.mode).toBe('STOP');
    expect(called(cpu)).toHaveLength(1);
  });
});

const nops = (n: number): string => '\tNOP 0;\n'.repeat(n);

describe('OB35', () => {
  it('OB35 ogni 100 ms con orologio a mano (3 esecuzioni in 300 ms)', () => {
    const { cpu, clock } = makeCpu([
      ob(1, '\tNOP 0;'),
      ob(35, '\tL MW 20;\n\tL 1;\n\t+I;\n\tT MW 20;\n\tL LW 10;\n\tT MW 22;'),
    ]);
    cpu.run();
    for (clock.t = 10; clock.t <= 300; clock.t += 10) cpu.cycle();
    expect(mw(cpu, 20)).toBe(3);
    expect(mw(cpu, 22)).toBe(100); // OB35_EXC_FREQ
  });

  it('OB35 interrompe l’OB1 al tick: registri dell’OB1 intatti dopo l’interruzione', () => {
    const { cpu, clock } = makeCpu([
      ob(
        1,
        `\tL 0;\n\tT MW 30;\n\tSET;\n\tL 3;\n\tL 7;\n${nops(1100)}\t+I;\n\tT MW 10;\n\t= M 40.0;\n\tL MW 30;\n\tT MW 32;`,
      ),
      ob(35, '\tL 1;\n\tT MW 30;\n\tL 99;\n\tL 98;\n\tCLR;\n\tL MW 20;\n\tL 1;\n\t+I;\n\tT MW 20;'),
    ]);
    cpu.run();
    clock.t = 95;
    clock.step = 10;
    expect(cpu.cycle().ok).toBe(true);
    expect(mw(cpu, 20)).toBe(1);
    expect(mw(cpu, 32)).toBe(1); // l'OB35 ha girato dentro l'OB1, dopo `T MW 30`
    expect(mw(cpu, 10)).toBe(10);
    expect(cpu.memory.M[40]! & 1).toBe(1);
  });

  it('OB35 lento → OB80 16#3502', () => {
    const { cpu, clock } = makeCpu(
      [ob(1, '\tNOP 0;'), ob(35, '\tNOP 0;'), ob(80, copyStartInfo(100, 120))],
      { maxCycleMs: 1e6 },
    );
    cpu.run();
    clock.t = 100;
    clock.step = 150;
    expect(cpu.cycle().ok).toBe(true);
    expect(mw(cpu, 120)).toBe(1);
    expect(mb(cpu, 100, 4)).toEqual([0x35, 0x02, 26, 80]);
    expect(mb(cpu, 108, 4)).toEqual([0x11, 0x36, 12, 35]);
    expect(called(cpu)[0]?.eventId).toBe(0x3502);
  });

  it('OB35 lento senza OB80 → STOP', () => {
    const { cpu, clock } = makeCpu([ob(1, '\tNOP 0;'), ob(35, '\tNOP 0;')]);
    cpu.run();
    clock.t = 100;
    clock.step = 150;
    cpu.cycle();
    expect(cpu.mode).toBe('STOP');
    expect(cpu.diagnostics.at(-1)?.eventId).toBe(0x3502);
  });

  it('OB35 non gira in AVVIO', () => {
    const { cpu, clock } = makeCpu([
      ob(1, '\tNOP 0;'),
      ob(100, nops(1100)),
      ob(35, '\tL MW 20;\n\tL 1;\n\t+I;\n\tT MW 20;'),
    ]);
    clock.step = 100;
    cpu.run();
    expect(cpu.mode).toBe('RUN');
    expect(mw(cpu, 20)).toBe(0);
  });

  it('OB35 senza OB1: le interruzioni girano lo stesso', () => {
    const { cpu, clock } = makeCpu([ob(35, '\tL MW 20;\n\tL 1;\n\t+I;\n\tT MW 20;')]);
    cpu.run();
    clock.t = 100;
    cpu.cycle();
    expect(mw(cpu, 20)).toBe(1);
  });
});

describe('raiseInterrupt', () => {
  it('raiseInterrupt(82) con OB82: gira all’inizio del ciclo con i dati di avvio', () => {
    const { cpu } = makeCpu([ob(1, '\tNOP 0;'), ob(82, copyStartInfo(100, 120))]);
    cpu.run();
    cpu.raiseInterrupt(82, { address: 256, coming: true });
    expect(mw(cpu, 120)).toBe(0);
    expect(cpu.cycle().ok).toBe(true);
    expect(mw(cpu, 120)).toBe(1);
    expect(mb(cpu, 100, 9)).toEqual([0x39, 0x42, 26, 82, 0, 0x54, 1, 0, 0x01]);
    expect(called(cpu)[0]?.eventId).toBe(0x3942);
    cpu.cycle();
    expect(mw(cpu, 120)).toBe(1); // una volta sola
  });

  it('raiseInterrupt(82) senza OB82 ma con OB85 → OB85 16#35A1', () => {
    const { cpu } = makeCpu([ob(1, '\tNOP 0;'), ob(85, copyStartInfo(100, 120))]);
    cpu.run();
    cpu.raiseInterrupt(82);
    expect(cpu.cycle().ok).toBe(true);
    expect(mb(cpu, 100, 4)).toEqual([0x35, 0xa1, 26, 85]);
    expect(mb(cpu, 108, 4)).toEqual([0x39, 0x42, 26, 82]);
    expect(called(cpu)[0]?.eventId).toBe(0x35a1);
  });

  it('raiseInterrupt(86) senza OB86 né OB85 → STOP', () => {
    const { cpu } = makeCpu([ob(1, '\tNOP 0;')]);
    cpu.run();
    cpu.raiseInterrupt(86);
    expect(cpu.cycle().ok).toBe(false);
    expect(cpu.mode).toBe('STOP');
    expect(cpu.diagnostics.at(-1)?.eventId).toBe(0x35a1);
  });

  it('raiseInterrupt(86) con OB86, evento uscente', () => {
    const { cpu } = makeCpu([ob(1, '\tNOP 0;'), ob(86, copyStartInfo(100, 120))]);
    cpu.run();
    cpu.raiseInterrupt(86, { coming: false });
    cpu.cycle();
    expect(mb(cpu, 100, 4)).toEqual([0x38, 0xc4, 26, 86]);
    expect(called(cpu)[0]?.eventId).toBe(0x38c4);
  });

  it('in STOP raiseInterrupt non lascia niente in coda', () => {
    const { cpu } = makeCpu([ob(1, '\tNOP 0;'), ob(82, copyStartInfo(100, 120))]);
    cpu.raiseInterrupt(82);
    cpu.run();
    cpu.cycle();
    expect(mw(cpu, 120)).toBe(0);
  });
});

describe('diagnostica', () => {
  it('id diagnostici del manuale nell’SZL 0x00A0', () => {
    const { cpu } = makeCpu([ob(1, '\tL MW 4000;')]);
    cpu.run();
    cpu.cycle();
    // Il più recente per primo: errore di area (16#2522), poi AVVIO (sintetico, ⚠️).
    expect(ids(cpu)).toEqual([0x2522, 0x9000]);
  });

  it('OB richiamato nell’SZL con l’id dell’evento', () => {
    const { cpu } = makeCpu([ob(1, '\tL PIW 3000;'), ob(122, '\tNOP 0;')]);
    cpu.run();
    cpu.cycle();
    expect(ids(cpu)).toEqual([0x2942, 0x9000]);
  });
});
