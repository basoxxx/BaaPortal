import { describe, expect, it } from 'vitest';
import { CounterBank, SimCpu, SimError, SimMemory, memorySizesFor } from '../src';
import { runAwl, type RunResult } from './helpers';
import { buildProgram, m, runProgram, sec, word, type BlockSpec } from './programHelpers';

/** Memoria e banco condivisi fra le scansioni. `M 0.0` = RLO di CU/CD/S, `M 0.1` = RLO di R/FR. */
function rig(limit = 256) {
  const counters = new CounterBank(limit);
  const mem = new SimMemory(memorySizesFor('cpu-315-2-pn-dp'));
  const scan = (body: string[], inputs: { in?: number; aux?: number } = {}): RunResult =>
    runAwl(body, {
      mem,
      counters,
      setup: (mm) => {
        if (inputs.in !== undefined) mm.M[0] = (mm.M[0]! & ~1) | inputs.in;
        if (inputs.aux !== undefined) mm.M[0] = (mm.M[0]! & ~2) | (inputs.aux << 1);
      },
    });
  return { counters, mem, scan };
}

const cu = ['\tA M 0.0;\n\tCU C 1;'];
const cd = ['\tA M 0.0;\n\tCD C 1;'];
const code = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    return (e as SimError).code;
  }
  return undefined;
};

describe('contatori S5: conteggio', () => {
  it('CU 3 volte sui fronti → 3, Q=1', () => {
    const { counters, mem, scan } = rig();
    for (let i = 0; i < 3; i++) {
      scan(cu, { in: 1 });
      scan(cu, { in: 0 });
    }
    expect(counters.value(1)).toBe(3);
    scan(['\tA C 1;\n\t= M 2.0;']);
    expect(mem.M[2]! & 1).toBe(1);
  });

  it('nessun conteggio senza fronte (RLO resta 1)', () => {
    const { counters, scan } = rig();
    scan(cu, { in: 1 });
    scan(cu);
    scan(cu);
    expect(counters.value(1)).toBe(1);
  });

  it('CU a 999 resta 999', () => {
    const { counters, scan } = rig();
    scan(['\tSET;\n\tL C#999;\n\tS C 1;'], { in: 1 });
    scan(cu, { in: 1 });
    expect(counters.value(1)).toBe(999);
    scan(cu, { in: 0 });
    scan(cu, { in: 1 });
    expect(counters.value(1)).toBe(999);
  });

  it('CD a 0 resta 0, Q=0', () => {
    const { counters, mem, scan } = rig();
    scan(cd, { in: 1 });
    scan(cd, { in: 0 });
    scan(cd, { in: 1 });
    expect(counters.value(1)).toBe(0);
    scan(['\tA C 1;\n\t= M 2.0;']);
    expect(mem.M[2]! & 1).toBe(0);
  });

  it('S con C#5 poi CD → 4', () => {
    const { counters, scan } = rig();
    scan(['\tA M 0.0;\n\tL C#5;\n\tS C 1;'], { in: 1 });
    expect(counters.value(1)).toBe(5);
    scan(['\tA M 0.0;\n\tCD C 1;'], { in: 0 });
    scan(['\tA M 0.0;\n\tCD C 1;'], { in: 1 });
    expect(counters.value(1)).toBe(4);
  });

  it('S carica solo sul fronte di salita', () => {
    const { counters, scan } = rig();
    const s = ['\tA M 0.0;\n\tL C#7;\n\tS C 1;'];
    scan(s, { in: 1 });
    scan(cd, { in: 1 }); // fronte di CD (RLO era 1 per S, ma CD ha la sua memoria)
    expect(counters.value(1)).toBe(6);
    scan(s); // RLO ancora 1: nessun fronte di S
    expect(counters.value(1)).toBe(6);
  });

  it('S con BCD non valido → BCD_NON_VALIDO', () => {
    const { scan } = rig();
    expect(code(() => scan(['\tSET;\n\tL W#16#00A5;\n\tS C 1;'], { in: 1 }))).toBe(
      'BCD_NON_VALIDO',
    );
  });

  it('R azzera con RLO 1; con RLO 0 no', () => {
    const { counters, scan } = rig();
    scan(['\tSET;\n\tL C#12;\n\tS C 1;']);
    scan(['\tA M 0.1;\n\tR C 1;'], { aux: 0 });
    expect(counters.value(1)).toBe(12);
    scan(['\tA M 0.1;\n\tR C 1;'], { aux: 1 });
    expect(counters.value(1)).toBe(0);
  });

  it('FR sul fronte riabilita: un RLO già a 1 conta di nuovo', () => {
    const { counters, scan } = rig();
    scan(cu, { in: 1 });
    scan(cu);
    expect(counters.value(1)).toBe(1);
    scan(['\tA M 0.1;\n\tFR C 1;'], { aux: 1 });
    scan(cu);
    expect(counters.value(1)).toBe(2);
    scan(['\tA M 0.1;\n\tFR C 1;'], { aux: 1 }); // nessun nuovo fronte di FR
    scan(cu);
    expect(counters.value(1)).toBe(2);
  });

  it('parola di stato: /FC=0, OR=0, STA=RLO, RLO invariato', () => {
    const { scan } = rig();
    for (const op of ['CU C 1', 'CD C 1', 'R C 1', 'FR C 1', 'S C 1']) {
      const r = scan([`\tSET;\n\tA M 0.0;\n\tL C#1;\n\t${op};`], { in: 1 });
      const s = r.regs.stw;
      expect([op, s.rlo, s.fc, s.or, s.sta]).toEqual([op, true, false, false, true]);
    }
  });
});

describe('contatori S5: lettura', () => {
  it('L C binario, LC C in BCD (ACCU1 → ACCU2)', () => {
    const { scan } = rig();
    scan(['\tSET;\n\tL C#123;\n\tS C 1;']);
    const r = scan(['\tL 77;\n\tL C 1;\n\tT MW 2;\n\tLC C 1;\n\tT MW 4;']);
    expect(word(r.mem, 2)).toBe(123);
    expect(word(r.mem, 4)).toBe(0x0123);
    expect(r.regs.accu2).toBe(123);
  });

  it('O/X su C leggono Q', () => {
    const { scan } = rig();
    scan(['\tSET;\n\tL C#1;\n\tS C 2;']);
    const r = scan(['\tCLR;\n\tO C 2;\n\tX C 1;\n\t= M 2.0;']);
    expect(r.mem.M[2]! & 1).toBe(1);
  });

  it('numero oltre il limite → NUMERO_CONTATORE', () => {
    const { scan } = rig(8);
    expect(code(() => scan(['\tA C 8;']))).toBe('NUMERO_CONTATORE');
    expect(code(() => scan(['\tSET;\n\tCU C 9;']))).toBe('NUMERO_CONTATORE');
    expect(code(() => scan(['\tL C 8;']))).toBe('NUMERO_CONTATORE');
  });

  it('accesso indiretto C [MW 10]', () => {
    const { counters, scan } = rig();
    scan(['\tSET;\n\tL C#9;\n\tS C 4;']);
    const r = scan(['\tL C [MW 10];\n\tT MW 2;'], {});
    expect(word(r.mem, 2)).toBe(0); // MW 10 = 0 → C 0
    expect(counters.value(4)).toBe(9);
    const r2 = runAwl(['\tL C [MW 10];\n\tT MW 2;'], {
      counters,
      setup: (mm) => (mm.M[11] = 4),
    });
    expect(word(r2.mem, 2)).toBe(9);
  });

  it('parametro formale COUNTER di una FC: CU, A e L come su C 5', () => {
    const FC1: BlockSpec = {
      kind: 'FC',
      number: 1,
      sections: sec({ in: [m('C_IN', { kind: 'parameter', name: 'Counter' } as never)] }),
      networks: ['\tA M 0.0;\n\tCU #C_IN;\n\tA #C_IN;\n\t= M 1.0;\n\tL #C_IN;\n\tT MW 4;'],
    };
    const p = buildProgram([
      { kind: 'OB', number: 1, networks: ['\tCALL FC 1 (C_IN := C 5);'] },
      FC1,
    ]);
    const counters = new CounterBank(256);
    const mem = new SimMemory(memorySizesFor('cpu-315-2-pn-dp'));
    runProgram(p, { mem, counters, setup: (mm) => (mm.M[0] = 1) });
    expect(counters.value(5)).toBe(1);
    expect(word(mem, 4)).toBe(1);
    expect(mem.M[1]! & 1).toBe(1);
  });
});

describe('contatori S5: ritentività e dimensione', () => {
  it('ritentività: oltre la soglia si azzera allo STOP→RUN, sotto resta', () => {
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
    cpu.run();
    for (let n = 0; n < 4; n++) cpu.counters.setValue(n, 9);
    cpu.stop();
    cpu.run();
    expect([0, 1, 2, 3].map((n) => cpu.counters.value(n))).toEqual([9, 9, 0, 0]);
    cpu.stop();
    cpu.memoryReset();
    expect(cpu.counters.value(0)).toBe(0);
  });

  it('la dimensione viene dal catalogo', () => {
    const cpu = new SimCpu({
      cpuTypeId: 'cpu-315-2-pn-dp',
      props: {
        maxCycleMs: 150,
        minCycleMs: 0,
        clockMemory: { enabled: false, byte: 0 },
        retentivity: { mBytes: 0, timers: 0, counters: 0 },
        cyclicInterruptMs: 100,
      },
    });
    expect(cpu.counters.count).toBe(256);
  });
});
