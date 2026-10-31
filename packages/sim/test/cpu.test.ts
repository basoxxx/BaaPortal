import { compileBlock } from '@baaportal/mc7';
import type { AwlContext } from '@baaportal/awl';
import { describe, expect, it } from 'vitest';
import {
  OPS,
  SimCpu,
  dateTimeBcd,
  simBackend,
  ob100StartInfo,
  ob1StartInfo,
  type SimCpuOptions,
  type SimEvent,
} from '../src';
import { buildProgram, EMPTY, el, m, sec, type BlockSpec } from './programHelpers';

const PROPS: SimCpuOptions['props'] = {
  maxCycleMs: 150,
  minCycleMs: 0,
  clockMemory: { enabled: false, byte: 0 },
  retentivity: { mBytes: 16, timers: 2, counters: 2 },
  cyclicInterruptMs: 100,
};

/** CPU con orologio finto: `clock.t` si muove a mano; `step` lo avanza a ogni lettura. */
function makeCpu(
  specs: BlockSpec[],
  over: Partial<SimCpuOptions['props']> = {},
  step = 0,
  nowFn?: () => number,
): { cpu: SimCpu; clock: { t: number } } {
  const clock = { t: 0 };
  const cpu = new SimCpu({
    cpuTypeId: 'cpu-315-2-pn-dp',
    props: { ...PROPS, ...over },
    now:
      nowFn ??
      (() => {
        const v = clock.t;
        clock.t += step;
        return v;
      }),
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
    for (const n of [0, 1, 2, 3]) cpu.timers.startOp(n, 'SS', true, 1);
    for (let n = 0; n < 4; n++) cpu.counters.setValue(n, 9);
    cpu.stop();
    cpu.run();
    expect(cpu.memory.M[15]).toBe(0xff);
    expect(cpu.memory.M[16]).toBe(0);
    expect([0, 1, 2, 3].map((n) => cpu.timers.value(n).units)).toEqual([1, 1, 0, 0]);
    expect([0, 1, 2, 3].map((n) => cpu.counters.value(n))).toEqual([9, 9, 0, 0]);
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
    cpu.timers.startOp(0, 'SS', true, 1);
    cpu.counters.setValue(0, 4);
    cpu.memoryReset();
    expect(Array.from(cpu.memory.dbs.get(5)!.data.subarray(0, 4))).toEqual([0, 5, 0, 7]);
    expect(cpu.memory.M[3] + cpu.memory.I[3] + cpu.memory.Q[3]).toBe(0);
    expect(cpu.timers.value(0).units).toBe(0);
    expect(cpu.counters.value(0)).toBe(0);
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

  it('T PQW 0 scrive anche la PIQ (Q) oltre alla periferia', () => {
    const { cpu } = makeCpu([ob1('\tL 1234;\n\tT PQW 0;')]);
    cpu.run();
    expect(cpu.cycle().ok).toBe(true);
    expect(cpu.memory.physOut.subarray(0, 2)).toEqual(new Uint8Array([0x04, 0xd2]));
    expect(cpu.memory.Q.subarray(0, 2)).toEqual(new Uint8Array([0x04, 0xd2]));
  });

  it('un errore ha un id diagnostico distinto da AVVIO nelle SZL', () => {
    const { cpu } = makeCpu([ob1('\tL MB 4000;')]);
    cpu.run();
    cpu.cycle();
    const ids = simBackend(cpu).diagnosticRecords.map((r) => (r[0]! << 8) | r[1]!);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('JU su se stesso con orologio fermo → TEMPO_CICLO_SUPERATO per limite di istruzioni', () => {
    const { cpu } = makeCpu([ob1('x: JU x;')], {}, 0, () => 0);
    cpu.run();
    const r = cpu.cycle();
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('TEMPO_CICLO_SUPERATO');
    expect(cpu.mode).toBe('STOP');
  });

  it('OB100 che non termina con orologio fermo → STOP per limite di istruzioni', () => {
    const { cpu } = makeCpu(
      [ob1('\tNOP 0;'), { kind: 'OB', number: 100, networks: ['x: JU x;'] }],
      {},
      0,
      () => 0,
    );
    cpu.run();
    expect(cpu.mode).toBe('STOP');
    expect(cpu.diagnostics.at(-1)?.code).toBe('TEMPO_CICLO_SUPERATO');
  });

  it('dopo STOP → RUN le informazioni di avvio di OB1 non portano i tempi del RUN precedente', () => {
    const { cpu } = makeCpu([ob1('\tL LW 6;\n\tT MW 20;')], {}, 5);
    cpu.run();
    cpu.cycle();
    cpu.cycle();
    expect(cpu.stats().last).toBeGreaterThan(0);
    expect(cpu.memory.M[21]).toBeGreaterThan(0);
    cpu.stop();
    cpu.run();
    expect(cpu.stats()).toEqual({ last: 0, min: 0, max: 0, cycles: 0 });
    cpu.cycle();
    expect(cpu.memory.M.subarray(20, 22)).toEqual(new Uint8Array([0, 0]));
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
    // Letture dell'orologio: AVVIO, poi inizio e fine di ogni ciclo.
    const seq = [0, 0, 10, 100, 104, 200, 225];
    const { cpu } = makeCpu([ob1('\tNOP 0;')], {}, 0, () => seq.shift() ?? 0);
    cpu.run();
    for (let i = 0; i < 3; i++) cpu.cycle();
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

  it('un errore non SimError in un OB porta comunque in STOP e viene rilanciato', () => {
    const orig = OPS['NOP'];
    OPS['NOP'] = () => {
      throw new Error('boom');
    };
    try {
      const { cpu } = makeCpu([ob1('\tNOP 0;')]);
      cpu.run();
      cpu.memory.physOut[0] = 1;
      expect(() => cpu.cycle()).toThrow('boom');
      expect(cpu.mode).toBe('STOP');
      expect(cpu.memory.physOut[0]).toBe(0);
      expect(cpu.diagnostics.at(-1)?.detail).toContain('boom');
      const b = makeCpu([ob1('\tNOP 0;'), { kind: 'OB', number: 100, networks: ['\tNOP 0;'] }]);
      expect(() => b.cpu.run()).toThrow('boom');
      expect(b.cpu.mode).toBe('STOP');
    } finally {
      OPS['NOP'] = orig!;
    }
  });

  it('senza OB1 in RUN le immagini di processo si aggiornano lo stesso', () => {
    const { cpu } = makeCpu([], { clockMemory: { enabled: true, byte: 10 } });
    cpu.run();
    cpu.memory.physIn[0] = 7;
    cpu.memory.Q[2] = 9;
    const r = cpu.cycle();
    expect(r).toMatchObject({ ran: true, ok: true });
    expect(cpu.memory.I[0]).toBe(7);
    expect(cpu.memory.physOut[2]).toBe(9);
    expect(cpu.cycle().ran).toBe(true);
    cpu.stop();
    expect(cpu.cycle().ran).toBe(false);
  });

  it('ciclo breve ma orologio che salta oltre il massimo → TEMPO_CICLO_SUPERATO', () => {
    const { cpu } = makeCpu([ob1('\tSET;\n\t= Q 0.0;')], {}, 200);
    cpu.run();
    const r = cpu.cycle();
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('TEMPO_CICLO_SUPERATO');
    expect(cpu.mode).toBe('STOP');
    expect(cpu.memory.physOut[0]).toBe(0);
  });

  it('Date_And_Time in BCD e intestazione di OB100', () => {
    const t = new Date(2026, 9, 24, 13, 5, 9, 123).getTime();
    const b = ob1StartInfo(true, { prev: 0, min: 0, max: 0 }, t);
    // Giorno della settimana: 1 = domenica, 7 = sabato (24/10/2026 è sabato).
    expect(Array.from(b.subarray(12, 20))).toEqual([
      0x26, 0x10, 0x24, 0x13, 0x05, 0x09, 0x12, 0x37,
    ]);
    expect(dateTimeBcd(t)).toEqual(Array.from(b.subarray(12, 20)));
    expect(Array.from(ob100StartInfo(t).subarray(0, 4))).toEqual([0x13, 0x81, 27, 100]);
  });

  it('merker di clock: tutti gli 8 bit a tempi fissi', () => {
    const { cpu, clock } = makeCpu([ob1('\tNOP 0;')], {
      clockMemory: { enabled: true, byte: 10 },
    });
    cpu.run();
    const table: [number, number][] = [
      [0, 0x00],
      [50, 0x01],
      [100, 0x02],
      [1234, 0xd0],
      [250, 0x0d],
    ];
    for (const [t, expected] of table) {
      clock.t = t;
      cpu.cycle();
      expect(cpu.memory.M[10], `t=${t}`).toBe(expected);
    }
  });

  it('il merker di clock si aggiorna anche dentro il ciclo (onTick)', () => {
    // Letture: AVVIO, inizio ciclo, tick (dopo 1024 istruzioni), fine ciclo.
    const seq = [0, 0, 500, 500];
    const { cpu } = makeCpu(
      [ob1('\tNOP 0;\n'.repeat(1100) + '\tL MB 10;\n\tT MB 50;')],
      { clockMemory: { enabled: true, byte: 10 }, maxCycleMs: 10000 },
      0,
      () => seq.shift() ?? 500,
    );
    cpu.run();
    expect(cpu.cycle().ok).toBe(true);
    expect(cpu.memory.M[50]).toBe(0x32);
  });

  it('un ascoltatore che lancia non interrompe le transizioni', () => {
    const { cpu } = makeCpu([ob1('\tNOP 0;')]);
    cpu.onEvent(() => {
      throw new Error('ascoltatore');
    });
    cpu.run();
    expect(cpu.mode).toBe('RUN');
  });

  it('diagnostica limitata a 100 voci, le più vecchie si perdono', () => {
    const { cpu } = makeCpu([ob1('\tNOP 0;')]);
    for (let i = 0; i < 120; i++) {
      cpu.run();
      cpu.stop(`n${i}`);
    }
    expect(cpu.diagnostics).toHaveLength(100);
    expect(cpu.diagnostics.at(-1)?.detail).toBe('n119');
    expect(cpu.diagnostics[0]?.detail).not.toBe('n0');
  });
});

describe('tempo di ciclo e pause del processo (pauseMs)', () => {
  /** Orologio che avanza di `step` ms a lettura e, armato, salta una volta di `jump` ms. */
  const pausing = (step: number) => {
    const c = { t: 0, jumpAt: -1, jump: 0, reads: 0 };
    const now = () => {
      if (c.reads++ === c.jumpAt) c.t += c.jump;
      return (c.t += step);
    };
    return { c, now };
  };
  const make = (networks: string[], now: () => number, pauseMs?: number) => {
    const cpu = new SimCpu({
      cpuTypeId: 'cpu-315-2-pn-dp',
      props: PROPS,
      now,
      ...(pauseMs !== undefined ? { pauseMs } : {}),
    });
    for (const b of buildProgram([ob1(...networks)]).list()) cpu.program.put(b);
    cpu.run();
    return cpu;
  };

  it('una pausa di 500 ms a metà ciclo non conta: niente STOP', () => {
    const { c, now } = pausing(0);
    const cpu = make([`${'\tNOP 0;\n'.repeat(1100)}\tSET;\n\t= Q 0.0;`], now, 50);
    c.jumpAt = c.reads + 1; // dopo l'inizio del ciclo, prima del controllo delle 1024 istruzioni
    c.jump = 500;
    const r = cpu.cycle();
    expect(r.ok).toBe(true);
    expect(cpu.mode).toBe('RUN');
    expect(cpu.memory.physOut[0]).toBe(1);
  });

  it('una pausa fra l’ultimo controllo e la fine del ciclo non conta', () => {
    const { c, now } = pausing(0);
    const cpu = make(['\tSET;\n\t= Q 0.0;'], now, 50);
    c.jumpAt = c.reads + 1;
    c.jump = 500;
    expect(cpu.cycle().ok).toBe(true);
  });

  it('un loop infinito va comunque in STOP per tempo di ciclo', () => {
    const { now } = pausing(1);
    const cpu = make(['x: JU x;'], now, 50);
    const r = cpu.cycle();
    expect(r.error?.code).toBe('TEMPO_CICLO_SUPERATO');
    expect(r.error?.detail ?? '').toContain('150 ms'); // non il limite di istruzioni
    expect(cpu.mode).toBe('STOP');
  });

  it('col PC lento (ogni controllo oltre pauseMs) un loop infinito va in STOP', () => {
    const { c, now } = pausing(60);
    const cpu = make(['x: JU x;'], now, 50);
    const r = cpu.cycle();
    expect(r.error?.code).toBe('TEMPO_CICLO_SUPERATO');
    expect(r.error?.detail ?? '').toContain('150 ms');
    expect(c.reads).toBeLessThan(40); // ogni intervallo conta almeno pauseMs
  });

  /** CPU con OB35 (`ob35` = corpo AWL) e orologio fermo a 100 ms, la prima scadenza. */
  const withOb35 = (ob35: string) => {
    const { c, now } = pausing(0);
    const cpu = new SimCpu({ cpuTypeId: 'cpu-315-2-pn-dp', props: PROPS, now, pauseMs: 50 });
    const specs: BlockSpec[] = [ob1('\tNOP 0;'), { kind: 'OB', number: 35, networks: [ob35] }];
    for (const b of buildProgram(specs).list()) cpu.program.put(b);
    cpu.run();
    c.t = 100;
    c.jumpAt = c.reads + 1; // la lettura dopo quella d'ingresso: dentro OB35
    c.jump = 500;
    return { c, cpu };
  };

  it('una pausa del processo durante OB35 sposta la scadenza: niente STOP', () => {
    const { cpu } = withOb35(`${'\tNOP 0;\n'.repeat(1100)}\tSET;\n\t= M 0.0;`);
    expect(cpu.idle()).toBeDefined();
    expect(cpu.mode).toBe('RUN');
    expect(cpu.memory.M[0]).toBe(1);
  });

  it('una pausa fra l’ultimo controllo e la fine di OB35 non lo dichiara perso', () => {
    const { cpu } = withOb35('\tSET;\n\t= M 0.0;');
    cpu.idle();
    expect(cpu.mode).toBe('RUN');
    expect(cpu.memory.M[0]).toBe(1);
  });

  it('senza pauseMs un salto dell’orologio resta tempo di ciclo (come prima)', () => {
    const { c, now } = pausing(0);
    const cpu = make(['\tNOP 0;'], now);
    c.jumpAt = c.reads + 1;
    c.jump = 500;
    expect(cpu.cycle().ok).toBe(false);
  });
});
