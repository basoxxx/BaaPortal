import { describe, expect, it } from 'vitest';
import { SimCpu, SimError, SimMemory, TimerBank, memorySizesFor, decodeS5Time } from '../src';
import { runAwl, type RunResult } from './helpers';

/** Orologio a mano, memoria e banco condivisi fra le scansioni. */
function rig(limit = 256) {
  const clock = { t: 0 };
  const now = () => clock.t;
  const timers = new TimerBank(limit, now);
  const mem = new SimMemory(memorySizesFor('cpu-315-2-pn-dp'));
  /** Una scansione: `M 0.0` = RLO di ingresso, `M 0.1` = RLO di R/FR; esegue `body`. */
  const scan = (body: string[], inputs: { in?: number; aux?: number } = {}): RunResult =>
    runAwl(body, {
      mem,
      timers,
      now,
      setup: (m) => {
        if (inputs.in !== undefined) m.M[0] = (m.M[0]! & ~1) | inputs.in;
        if (inputs.aux !== undefined) m.M[0] = (m.M[0]! & ~2) | (inputs.aux << 1);
      },
    });
  return { clock, timers, mem, scan };
}

const run = (kind: string, time = 'S5T#2S') => [
  `\tA M 0.0;\n\tL ${time};\n\t${kind} T 1;\n\tA T 1;\n\t= Q 0.0;`,
];
const q = (mem: SimMemory) => mem.Q[0]! & 1;

describe('temporizzatori S5: avvio e scadenza', () => {
  it('SD con 2 s: Q=0 a 1999 ms, Q=1 a 2000 ms, Q=0 appena RLO=0', () => {
    const { clock, mem, scan } = rig();
    scan(run('SD'), { in: 1 });
    expect(q(mem)).toBe(0);
    clock.t = 1999;
    scan(run('SD'));
    expect(q(mem)).toBe(0);
    clock.t = 2000;
    scan(run('SD'));
    expect(q(mem)).toBe(1);
    clock.t = 2500;
    scan(run('SD'), { in: 0 });
    expect(q(mem)).toBe(0);
  });

  it('SD: RLO=0 durante il conteggio ferma il temporizzatore', () => {
    const { clock, mem, scan } = rig();
    scan(run('SD'), { in: 1 });
    clock.t = 1000;
    scan(run('SD'), { in: 0 });
    clock.t = 5000;
    scan(run('SD'), { in: 0 });
    expect(q(mem)).toBe(0);
  });

  it('SP: impulso che si interrompe con RLO=0', () => {
    const { clock, mem, scan } = rig();
    scan(run('SP', 'S5T#3S'), { in: 1 });
    expect(q(mem)).toBe(1);
    clock.t = 2999;
    scan(run('SP', 'S5T#3S'));
    expect(q(mem)).toBe(1);
    clock.t = 3000;
    scan(run('SP', 'S5T#3S'));
    expect(q(mem)).toBe(0); // scaduto con RLO ancora 1
    // Nuovo impulso, interrotto a metà.
    scan(run('SP', 'S5T#3S'), { in: 0 });
    clock.t = 4000;
    scan(run('SP', 'S5T#3S'), { in: 1 });
    expect(q(mem)).toBe(1);
    clock.t = 5000;
    scan(run('SP', 'S5T#3S'), { in: 0 });
    expect(q(mem)).toBe(0);
  });

  it('SE: riavvio su nuovo fronte durante l’impulso', () => {
    const { clock, mem, scan } = rig();
    scan(run('SE'), { in: 1 });
    clock.t = 1000;
    scan(run('SE'), { in: 0 });
    expect(q(mem)).toBe(1); // RLO=0 non interrompe l'impulso
    clock.t = 1500;
    scan(run('SE'), { in: 1 }); // nuovo fronte: riparte da 1500
    clock.t = 3000;
    scan(run('SE'), { in: 0 });
    expect(q(mem)).toBe(1); // senza riavvio sarebbe scaduto a 2000
    clock.t = 3499;
    scan(run('SE'));
    expect(q(mem)).toBe(1);
    clock.t = 3500;
    scan(run('SE'));
    expect(q(mem)).toBe(0);
  });

  it('SS: Q resta 1 dopo RLO=0 fino a R', () => {
    const { clock, mem, scan } = rig();
    scan(run('SS'), { in: 1 });
    expect(q(mem)).toBe(0);
    clock.t = 2000;
    scan(run('SS'), { in: 0 });
    expect(q(mem)).toBe(1);
    clock.t = 9000;
    scan(run('SS'));
    expect(q(mem)).toBe(1);
    scan(['\tA M 0.1;\n\tR T 1;\n\tA T 1;\n\t= Q 0.0;'], { aux: 1 });
    expect(q(mem)).toBe(0);
  });

  it('SF: Q=1 con RLO=1, scade 3 s dopo il fronte di discesa', () => {
    const { clock, mem, scan } = rig();
    scan(run('SF', 'S5T#3S'), { in: 1 });
    expect(q(mem)).toBe(1);
    clock.t = 1000;
    scan(run('SF', 'S5T#3S'), { in: 0 });
    expect(q(mem)).toBe(1);
    clock.t = 3999;
    scan(run('SF', 'S5T#3S'));
    expect(q(mem)).toBe(1);
    clock.t = 4000;
    scan(run('SF', 'S5T#3S'));
    expect(q(mem)).toBe(0);
  });

  it('nessun avvio senza fronte; FR riabilita', () => {
    const { clock, mem, scan } = rig();
    scan(run('SD'), { in: 1 });
    clock.t = 2000;
    scan(run('SD'));
    expect(q(mem)).toBe(1);
    // R con RLO ancora 1: nessun nuovo fronte, quindi nessun riavvio.
    scan(['\tSET;\n\tR T 1;'], { in: 1 });
    clock.t = 2100;
    scan(run('SD'));
    clock.t = 9000;
    scan(run('SD'));
    expect(q(mem)).toBe(0);
    // FR sul fronte di salita del suo RLO: il successivo avvio parte con RLO già a 1.
    scan(['\tA M 0.1;\n\tFR T 1;'], { aux: 1 });
    clock.t = 10000;
    scan(run('SD'));
    clock.t = 11999;
    scan(run('SD'));
    expect(q(mem)).toBe(0);
    clock.t = 12000;
    scan(run('SD'));
    expect(q(mem)).toBe(1);
  });

  it('R durante il conteggio azzera valore e Q', () => {
    const { clock, timers, scan } = rig();
    scan(run('SP'), { in: 1 });
    clock.t = 500;
    scan(['\tSET;\n\tR T 1;']);
    expect(timers.value(1).units).toBe(0);
    expect(timers.q(1)).toBe(false);
  });

  it('base 10 s con 999 dura 9990 s', () => {
    const { clock, mem, scan } = rig();
    scan(run('SD', 'W#16#3999'), { in: 1 });
    clock.t = 9_989_999;
    scan(run('SD'.replace('SD', 'SD'), 'W#16#3999'));
    expect(q(mem)).toBe(0);
    clock.t = 9_990_000;
    scan(run('SD', 'W#16#3999'));
    expect(q(mem)).toBe(1);
  });

  it('start/R/FR: /FC=0, OR=0, STA=RLO, RLO invariato', () => {
    const { scan } = rig();
    const r = scan(['\tSET;\n\tL S5T#2S;\n\tSD T 1;'], {});
    expect(r.regs.stw).toMatchObject({ fc: false, or: false, sta: true, rlo: true });
    const f = scan(['\tCLR;\n\tFR T 1;']);
    expect(f.regs.stw).toMatchObject({ fc: false, or: false, sta: false, rlo: false });
  });
});

describe('temporizzatori S5: lettura del valore', () => {
  it('L T e LC T a metà conteggio (base 100 ms, 50 → 23 dopo 2,7 s)', () => {
    const { clock, scan } = rig();
    scan(run('SP', 'W#16#1050'), { in: 1 });
    clock.t = 2700;
    expect(scan(['\tL T 1;']).regs.accu1).toBe(23);
    expect(scan(['\tLC T 1;']).regs.accu1).toBe(0x1023);
  });

  it('L T lascia ACCU1 in ACCU2', () => {
    const { scan } = rig();
    const r = scan(['\tL 77;\n\tL T 1;']);
    expect(r.regs.accu2).toBe(77);
    expect(r.regs.accu1).toBe(0);
  });

  it('S5TIME non BCD → BCD_NON_VALIDO', () => {
    const { scan } = rig();
    expect(() => scan(['\tSET;\n\tL W#16#00A5;\n\tSP T 1;'])).toThrowError(
      expect.objectContaining({ code: 'BCD_NON_VALIDO' }),
    );
    expect(() => decodeS5Time(0x0a00)).toThrow(SimError);
    expect(decodeS5Time(0x2999)).toEqual({ units: 999, base: 1000 });
  });

  it('T oltre il limite della CPU → NUMERO_TEMPORIZZATORE', () => {
    const { scan } = rig(4);
    for (const body of [
      '\tL T 4;',
      '\tA T 4;',
      '\tSET;\n\tR T 4;',
      '\tSET;\n\tL S5T#1S;\n\tSP T 4;',
    ]) {
      expect(() => scan([body])).toThrowError(
        expect.objectContaining({ code: 'NUMERO_TEMPORIZZATORE' }),
      );
    }
  });

  it('T [MW n]: numero indiretto', () => {
    const { clock, timers, scan } = rig();
    scan(['\tL 3;\n\tT MW 10;\n\tSET;\n\tL S5T#2S;\n\tSP T [MW 10];']);
    expect(timers.q(3)).toBe(true);
    clock.t = 1000;
    expect(scan(['\tL T [MW 10];']).regs.accu1).toBe(100);
    expect(scan(['\tA T [MW 10];']).regs.stw.rlo).toBe(true);
  });
});

describe('temporizzatori S5: CPU', () => {
  it('il numero viene dal catalogo', () => {
    const cpu = new SimCpu({
      cpuTypeId: 'cpu-315-2-pn-dp',
      props: {
        maxCycleMs: 150,
        minCycleMs: 0,
        clockMemory: { enabled: false, byte: 0 },
        retentivity: { mBytes: 0, timers: 0, counters: 0 },
      },
    });
    expect(cpu.timers.count).toBe(256);
  });

  it('ritentivi conservati e non ritentivi azzerati a STOP→RUN', () => {
    const clock = { t: 0 };
    const cpu = new SimCpu({
      cpuTypeId: 'cpu-315-2-pn-dp',
      props: {
        maxCycleMs: 150,
        minCycleMs: 0,
        clockMemory: { enabled: false, byte: 0 },
        retentivity: { mBytes: 16, timers: 2, counters: 2 },
      },
      now: () => clock.t,
    });
    cpu.run();
    for (const n of [0, 1, 2, 3]) {
      cpu.timers.startOp(n, 'SS', true, 0x0200);
    }
    clock.t = 2000;
    cpu.stop();
    cpu.run();
    expect([0, 1, 2, 3].map((n) => cpu.timers.q(n))).toEqual([true, true, false, false]);
    cpu.stop();
    cpu.memoryReset();
    expect([0, 1].map((n) => cpu.timers.q(n))).toEqual([false, false]);
  });
});
