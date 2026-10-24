import { compileBlock } from '@baaportal/mc7';
import type { AwlContext } from '@baaportal/awl';
import { describe, expect, it } from 'vitest';
import { SimCpu, type SimCpuOptions, type SimEvent } from '../src';
import { buildProgram, EMPTY, el, m, sec, type BlockSpec } from './programHelpers';

const PROPS: SimCpuOptions['props'] = {
  maxCycleMs: 150,
  minCycleMs: 0,
  clockMemory: { enabled: false, byte: 0 },
  retentivity: { mBytes: 16, timers: 2, counters: 2 },
};

/** CPU con orologio finto: `clock.t` si muove a mano; `step` lo avanza a ogni lettura. */
function makeCpu(
  specs: BlockSpec[],
  over: Partial<SimCpuOptions['props']> = {},
  step = 0,
): { cpu: SimCpu; clock: { t: number } } {
  const clock = { t: 0 };
  const cpu = new SimCpu({
    cpuTypeId: 'cpu-315-2-pn-dp',
    props: { ...PROPS, ...over },
    now: () => {
      const v = clock.t;
      clock.t += step;
      return v;
    },
  });
  for (const b of buildProgram(specs).list()) cpu.program.put(b);
  return { cpu, clock };
}

const ob1 = (...networks: string[]): BlockSpec => ({ kind: 'OB', number: 1, networks });

/** File di un DB con due Int e valori iniziali 5 e 7. */
function dbFile(): Uint8Array {
  const sections = { ...EMPTY, stat: [m('a', el('Int')), m('b', el('Int'))] };
  const iface = {
    input: [],
    output: [],
    inOut: [],
    static: sections.stat,
    temp: [],
    returnType: { kind: 'void' as const },
  };
  const ctx = {
    owner: { kind: 'DB', iface },
    symbol: () => undefined,
    block: () => undefined,
    resolve: () => null,
    allSymbols: () => [],
    allBlocks: () => [],
  } as unknown as AwlContext;
  const r = compileBlock({
    kind: 'DB',
    number: 5,
    now: new Date(2026, 9, 20),
    header: { author: 'T', family: 'Prove', name: 'Dati', version: '0.1' },
    knowHowProtected: false,
    sections,
    initials: { a: '5', b: '7' },
    networks: [],
    ctx,
  });
  if (!r.file) throw new Error(r.diagnostics.map((d) => d.message).join('; '));
  return r.file;
}

describe('SimCpu', () => {
  it('OB1: I0.0 → Q4.0 attraverso le immagini di processo', () => {
    const { cpu } = makeCpu([ob1('\tA I 0.0;\n\t= Q 4.0;')]);
    cpu.run();
    expect(cpu.mode).toBe('RUN');
    cpu.memory.physIn[0] = 1;
    // Durante il ciclo I si copia da physIn; Q arriva a physOut solo a fine ciclo.
    const r = cpu.cycle();
    expect(r.ok).toBe(true);
    expect(cpu.memory.I[0]).toBe(1);
    expect(cpu.memory.Q[4]).toBe(1);
    expect(cpu.memory.physOut[4]).toBe(1);
  });

  it('PIW legge physIn senza aspettare il ciclo', () => {
    const { cpu } = makeCpu([ob1('\tL PIW 0;\n\tT MW 20;')]);
    cpu.run();
    cpu.memory.physIn[0] = 0x12;
    cpu.memory.physIn[1] = 0x34;
    // Il valore arriva dopo l'ultima copia di I, ma PIW lo vede comunque.
    cpu.cycle();
    expect(cpu.memory.M[20]).toBe(0x12);
    expect(cpu.memory.M[21]).toBe(0x34);
    expect(cpu.memory.I[0]).toBe(0x12);
  });

  it("OB100 eseguito una volta all'avvio", () => {
    const { cpu } = makeCpu([
      ob1('\tL MB 30;\n\tL 1;\n\t+I;\n\tT MB 31;'),
      { kind: 'OB', number: 100, networks: ['\tL 1;\n\tT MB 30;'] },
    ]);
    cpu.run();
    expect(cpu.memory.M[30]).toBe(1);
    cpu.cycle();
    cpu.cycle();
    expect(cpu.memory.M[30]).toBe(1);
    expect(cpu.memory.M[31]).toBe(2);
    expect(cpu.diagnostics.map((d) => d.code)).toEqual(['AVVIO']);
  });

  it('un errore in OB100 lascia la CPU in STOP', () => {
    const { cpu } = makeCpu([
      ob1('\tNOP 0;'),
      { kind: 'OB', number: 100, networks: ['\tL MB 4000;'] },
    ]);
    cpu.run();
    expect(cpu.mode).toBe('STOP');
    expect(cpu.diagnostics.at(-1)).toMatchObject({
      code: 'AREA_LUNGHEZZA',
      block: 'OB100',
    });
  });

  it('dati di avvio di OB1: tempo del ciclo precedente in L 6..7', () => {
    // La struttura di OB_DEFINITIONS[1].startInfo: classe, ..., PREV_CYCLE (Int a L6), MIN, MAX.
    const { cpu } = makeCpu(
      [
        {
          kind: 'OB',
          number: 1,
          sections: sec({ temp: [] }),
          networks: [
            '\tL LB 3;\n\tT MB 40;\n\tL LW 6;\n\tT MW 42;\n\tL LW 8;\n\tT MW 44;\n\tL LW 10;\n\tT MW 46;',
          ],
        },
      ],
      {},
      5,
    );
    cpu.run();
    cpu.cycle();
    expect(cpu.memory.M[40]).toBe(1); // OB_NUMBR
    expect((cpu.memory.M[42]! << 8) | cpu.memory.M[43]!).toBe(0);
    cpu.cycle();
    expect((cpu.memory.M[42]! << 8) | cpu.memory.M[43]!).toBe(5);
    expect((cpu.memory.M[44]! << 8) | cpu.memory.M[45]!).toBe(5); // minimo
    expect((cpu.memory.M[46]! << 8) | cpu.memory.M[47]!).toBe(5); // massimo
  });

  it('ritentività: MB0..15 restano, MB16 si azzera allo STOP→RUN', () => {
    const { cpu } = makeCpu([ob1('\tNOP 0;')]);
    cpu.run();
    cpu.memory.M.fill(0xff, 0, 20);
    cpu.timers.fill(9, 0, 4);
    cpu.counters.fill(9, 0, 4);
    cpu.stop();
    cpu.run();
    expect(cpu.memory.M[15]).toBe(0xff);
    expect(cpu.memory.M[16]).toBe(0);
    expect(Array.from(cpu.timers.subarray(0, 4))).toEqual([9, 9, 0, 0]);
    expect(Array.from(cpu.counters.subarray(0, 4))).toEqual([9, 9, 0, 0]);
  });

  it('avvio a caldo azzera le immagini di processo e lascia i DB', () => {
    const { cpu } = makeCpu([ob1('\tNOP 0;')]);
    cpu.loadBlock(dbFile());
    cpu.memory.dbs.get(5)!.data[1] = 99;
    cpu.memory.I[0] = 1;
    cpu.memory.Q[0] = 1;
    cpu.run();
    expect(cpu.memory.I[0]).toBe(0);
    expect(cpu.memory.Q[0]).toBe(0);
    expect(cpu.memory.dbs.get(5)!.data[1]).toBe(99);
  });

  it('cancellazione totale: DB tornano ai valori iniziali, blocchi restano', () => {
    const { cpu } = makeCpu([ob1('\tNOP 0;')]);
    cpu.loadBlock(dbFile());
    const db = cpu.memory.dbs.get(5)!;
    expect(Array.from(db.data.subarray(0, 4))).toEqual([0, 5, 0, 7]);
    db.data.fill(0xaa);
    cpu.memory.M[3] = 1;
    cpu.memory.I[3] = 1;
    cpu.memory.Q[3] = 1;
    cpu.timers[0] = 4;
    cpu.counters[0] = 4;
    cpu.memoryReset();
    expect(Array.from(cpu.memory.dbs.get(5)!.data.subarray(0, 4))).toEqual([0, 5, 0, 7]);
    expect(cpu.memory.M[3] + cpu.memory.I[3] + cpu.memory.Q[3]).toBe(0);
    expect(cpu.timers[0]! + cpu.counters[0]!).toBe(0);
    expect(cpu.program.get('OB', 1)).toBeDefined();
    expect(cpu.diagnostics.at(-1)?.code).toBe('CANCELLAZIONE_TOTALE');
  });

  it('cancellazione totale solo in STOP', () => {
    const { cpu } = makeCpu([ob1('\tNOP 0;')]);
    cpu.run();
    expect(() => cpu.memoryReset()).toThrow(/STOP/);
  });

  it('deleteBlock toglie un OB o un DB', () => {
    const { cpu } = makeCpu([ob1('\tNOP 0;')]);
    cpu.loadBlock(dbFile());
    cpu.deleteBlock('DB', 5);
    cpu.deleteBlock('OB', 1);
    expect(cpu.memory.dbs.has(5)).toBe(false);
    expect(cpu.program.get('OB', 1)).toBeUndefined();
  });

  it('JU su se stesso → TEMPO_CICLO_SUPERATO, STOP, diagnostica con rete', () => {
    const { cpu } = makeCpu([ob1('\tNOP 0;', 'x: JU x;')], {}, 60);
    cpu.run();
    const r = cpu.cycle();
    expect(r.ok).toBe(false);
    expect(cpu.mode).toBe('STOP');
    expect(r.error).toMatchObject({
      code: 'TEMPO_CICLO_SUPERATO',
      block: 'OB1',
      network: 2,
    });
    expect(cpu.diagnostics.at(-1)).toBe(r.error);
  });

  it('accesso fuori area in FC2 → STOP con blocco FC2 e offset', () => {
    const { cpu } = makeCpu([
      ob1('\tCALL FC 2;'),
      { kind: 'FC', number: 2, networks: ['\tNOP 0;\n\tL MB 4000;'] },
    ]);
    cpu.run();
    const r = cpu.cycle();
    expect(r.ok).toBe(false);
    expect(cpu.mode).toBe('STOP');
    expect(r.error).toMatchObject({ code: 'AREA_LUNGHEZZA', block: 'FC2', network: 1 });
    expect(r.error?.offset).toBeGreaterThan(0);
  });

  it('merker di clock bit 5 = 1 Hz', () => {
    const { cpu, clock } = makeCpu([ob1('\tNOP 0;')], {
      clockMemory: { enabled: true, byte: 10 },
    });
    cpu.run();
    const bit5 = () => (cpu.memory.M[10]! >> 5) & 1;
    clock.t = 100;
    cpu.cycle();
    expect(bit5()).toBe(0);
    clock.t = 600;
    cpu.cycle();
    expect(bit5()).toBe(1);
    clock.t = 1100;
    cpu.cycle();
    expect(bit5()).toBe(0);
    clock.t = 1600;
    cpu.cycle();
    expect(bit5()).toBe(1);
    // Bit 0 = 10 Hz: periodo 100 ms.
    clock.t = 1650;
    cpu.cycle();
    expect(cpu.memory.M[10]! & 1).toBe(1);
  });

  it('nessun OB1 → RUN senza fare niente', () => {
    const { cpu } = makeCpu([]);
    cpu.run();
    expect(cpu.mode).toBe('RUN');
    const r = cpu.cycle();
    expect(r.ok).toBe(true);
    expect(cpu.stats().cycles).toBe(0);
  });

  it('in STOP il ciclo non fa niente', () => {
    const { cpu } = makeCpu([ob1('\tSET;\n\t= M 0.0;')]);
    expect(cpu.cycle().ok).toBe(true);
    expect(cpu.memory.M[0]).toBe(0);
  });

  it('stats: min/max/ultimo', () => {
    const { cpu, clock } = makeCpu([ob1('\tNOP 0;')]);
    cpu.run();
    // Ogni ciclo legge l'orologio due volte (inizio e fine): lo avanzo fra le due letture.
    const durations = [10, 4, 25];
    for (const d of durations) {
      let n = 0;
      const base = clock.t;
      (cpu as unknown as { now: () => number }).now = () => (n++ === 0 ? base : base + d);
      cpu.cycle();
    }
    expect(cpu.stats()).toEqual({ last: 25, min: 4, max: 25, cycles: 3 });
  });

  it('eventi: modo, diagnostica, ciclo', () => {
    const { cpu } = makeCpu([ob1('\tNOP 0;')]);
    const ev: SimEvent[] = [];
    const off = cpu.onEvent((e) => ev.push(e));
    cpu.run();
    cpu.cycle();
    cpu.stop('prova');
    off();
    cpu.run();
    const kinds = ev.map((e) => e.type + (e.type === 'mode' ? `:${e.mode}` : ''));
    expect(kinds).toEqual([
      'mode:STARTUP',
      'diagnostic',
      'mode:RUN',
      'cycle',
      'diagnostic',
      'mode:STOP',
    ]);
    expect(cpu.diagnostics.find((d) => d.code === 'STOP_RICHIESTO')?.detail).toBe('prova');
  });
});
