import { findSystemBlock } from '@baaportal/catalog';
import type { AwlBlockInfo } from '@baaportal/awl';
import { describe, expect, it } from 'vitest';
import { SimCpu, nextTod, type LoadedBlock, type SimCpuOptions } from '../src';
import { buildProgram, type BlockSpec } from './programHelpers';

// SFC 2–5, 28–34, 36–40, 49, 52, 58, 59: manuale «System Software for S7-300/400 System and
// Standard Functions» (sezioni nel commento di ogni gestore). Tutto da verificare su CPU reale.

const PROPS: SimCpuOptions['props'] = {
  maxCycleMs: 150,
  minCycleMs: 0,
  clockMemory: { enabled: false, byte: 0 },
  retentivity: { mBytes: 16, timers: 2, counters: 2 },
  cyclicInterruptMs: 0,
};

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
      returnType: b.returnType ? { kind: 'elementary', name: b.returnType } : { kind: 'void' },
    },
  } as unknown as AwlBlockInfo;
}

const SFCS = [0, 2, 3, 4, 5, 29, 30, 31, 32, 33, 34, 36, 37, 38, 39, 40, 46, 49, 52, 58, 59].map(
  sfcInfo,
);
const ob = (number: number, ...networks: string[]): BlockSpec => ({ kind: 'OB', number, networks });
/** OB che conta i suoi richiami in MW `at`. */
const counter = (number: number, at: number): BlockSpec =>
  ob(number, `\tL MW ${at};\n\tL 1;\n\t+I;\n\tT MW ${at};`);

function makeCpu(specs: BlockSpec[]): { cpu: SimCpu; clock: { t: number } } {
  const clock = { t: 0 };
  const cpu = new SimCpu({ cpuTypeId: 'cpu-315-2-pn-dp', props: PROPS, now: () => clock.t });
  for (const b of buildProgram(specs, {}, SFCS).list()) cpu.program.put(b);
  return { cpu, clock };
}

const mw = (cpu: SimCpu, at: number): number => (cpu.memory.M[at]! << 8) | cpu.memory.M[at + 1]!;
const md = (cpu: SimCpu, at: number): number => new DataView(cpu.memory.M.buffer).getUint32(at);

describe('contatore di ore (SFC 2, 3, 4)', () => {
  const read = '\tCALL SFC 4 (NR := B#16#0, RET_VAL := MW 104, CQ := M 10.0, CV := MW 12);';

  it('SET_RTM, CTRL_RTM e READ_RTM contano le ore solo in marcia', () => {
    const { cpu, clock } = makeCpu([
      ob(
        100,
        '\tCALL SFC 2 (NR := B#16#0, PV := 5, RET_VAL := MW 100);',
        '\tCALL SFC 3 (NR := B#16#0, S := TRUE, RET_VAL := MW 102);',
      ),
      ob(1, read),
    ]);
    cpu.run();
    clock.t = 2 * 3_600_000 + 10;
    cpu.cycle();
    expect([mw(cpu, 100), mw(cpu, 102), mw(cpu, 104)]).toEqual([0, 0, 0]);
    expect(cpu.memory.M[10]! & 1).toBe(1);
    expect(mw(cpu, 12)).toBe(7);
    // In STOP si ferma; dopo l'avvio resta fermo finché non si riavvia (⚠️).
    cpu.stop();
    clock.t += 5 * 3_600_000;
    cpu.program.delete('OB', 100);
    cpu.run();
    cpu.cycle();
    expect(mw(cpu, 12)).toBe(7);
    expect(cpu.memory.M[10]! & 1).toBe(0);
  });

  it('numero diverso da 0 → 16#8080, PV negativo → 16#8081', () => {
    const { cpu } = makeCpu([
      ob(
        1,
        '\tCALL SFC 2 (NR := B#16#1, PV := 5, RET_VAL := MW 100);',
        '\tCALL SFC 2 (NR := B#16#0, PV := -1, RET_VAL := MW 102);',
      ),
    ]);
    cpu.run();
    cpu.cycle();
    expect([mw(cpu, 100), mw(cpu, 102)]).toEqual([0x8080, 0x8081]);
  });
});

describe('allarme di ritardo (SFC 32–34, OB20)', () => {
  const start =
    '\tCALL SFC 32 (OB_NR := 20, DTIME := T#100MS, SIGN := W#16#1234, RET_VAL := MW 100);';
  const query = '\tCALL SFC 34 (OB_NR := 20, RET_VAL := MW 102, STATUS := MW 104);';

  it('OB20 parte dopo DTIME con SIGN e DTIME nei dati di avvio', () => {
    const { cpu, clock } = makeCpu([
      ob(100, start),
      ob(1, query),
      ob(20, '\tL LW 6;\n\tT MW 20;\n\tL LD 8;\n\tT MD 22;\n\tL MW 30;\n\tL 1;\n\t+I;\n\tT MW 30;'),
    ]);
    cpu.run();
    clock.t = 50;
    cpu.cycle();
    expect(mw(cpu, 100)).toBe(0);
    expect(mw(cpu, 104)).toBe(0x14); // attivo, OB20 caricato
    expect(mw(cpu, 30)).toBe(0);
    clock.t = 100;
    cpu.cycle();
    expect(mw(cpu, 30)).toBe(1);
    expect(mw(cpu, 20)).toBe(0x1234);
    expect(md(cpu, 22)).toBe(100);
    expect(mw(cpu, 104)).toBe(0x10); // scaduto: non più attivo
    cpu.cycle();
    expect(mw(cpu, 30)).toBe(1);
  });

  it('CAN_DINT annulla; senza avvio → 16#80A0; DTIME e OB_NR errati', () => {
    const { cpu, clock } = makeCpu([
      ob(
        1,
        '\tA M 0.0;\n\tJC x;',
        start,
        '\tCALL SFC 33 (OB_NR := 20, RET_VAL := MW 106);',
        '\tCALL SFC 33 (OB_NR := 20, RET_VAL := MW 108);',
        '\tCALL SFC 32 (OB_NR := 20, DTIME := T#0MS, SIGN := W#16#0, RET_VAL := MW 110);',
        '\tCALL SFC 32 (OB_NR := 21, DTIME := T#1S, SIGN := W#16#0, RET_VAL := MW 112);\n\tSET;\n\t= M 0.0;\nx: NOP 0;',
      ),
      counter(20, 30),
    ]);
    cpu.run();
    cpu.cycle();
    clock.t = 500;
    cpu.cycle();
    expect([mw(cpu, 106), mw(cpu, 108), mw(cpu, 110), mw(cpu, 112)]).toEqual([
      0, 0x80a0, 0x8091, 0x8090,
    ]);
    expect(mw(cpu, 30)).toBe(0);
  });

  it('OB20 non caricato alla scadenza → OB85, senza OB85 STOP', () => {
    const { cpu, clock } = makeCpu([ob(100, start), ob(1, '\tNOP 0;'), counter(85, 40)]);
    cpu.run();
    clock.t = 200;
    cpu.cycle();
    expect(mw(cpu, 40)).toBe(1);
    const noOb85 = makeCpu([ob(100, start), ob(1, '\tNOP 0;')]);
    noOb85.cpu.run();
    noOb85.clock.t = 200;
    noOb85.cpu.cycle();
    expect(noOb85.cpu.mode).toBe('STOP');
  });
});

const w16 = (n: number): number[] => [n >> 8, n & 255];
const M = (byte: number): number[] => {
  const a = byte * 8;
  return [0x83, a >> 16, (a >> 8) & 255, a & 255];
};
/** Pezzo di AWL compilato senza il BE finale (per concatenarlo). */
const awl = (src: string): Uint8Array => {
  const code = buildProgram([ob(1, src)], {}, SFCS).get('OB', 1)!.code;
  return code.subarray(0, code.length - 2);
};
function ob1Raw(...parts: Uint8Array[]): LoadedBlock {
  const code = Uint8Array.from(parts.flatMap((c) => [...c]));
  return { kind: 'OB', number: 1, code, localBytes: 64, networkStarts: [0] } as LoadedBlock;
}

describe('allarme dall’orologio (SFC 28–31, OB10)', () => {
  const T0 = new Date(2026, 9, 30, 10, 0, 0).getTime();
  /** SFC 28 con la lista dei puntatori: il compilatore non passa DATE_AND_TIME (sim.md §12). */
  const setTint = (): Uint8Array =>
    Uint8Array.from([
      0xfb,
      0x74,
      ...w16(28),
      0x70,
      0x0b,
      ...w16(10),
      ...M(210),
      ...M(200),
      ...M(212),
      ...M(100),
    ]);
  const sdt = [0x26, 0x10, 0x30, 0x10, 0x01, 0x30, 0x00, 0x05]; // 30/10/2026 10:01:30
  const actQry =
    '\tCALL SFC 30 (OB_NR := 10, RET_VAL := MW 102);\n\tCALL SFC 31 (OB_NR := 10, RET_VAL := MW 104, STATUS := MW 106);';

  function tod(...ob1: Uint8Array[]): { cpu: SimCpu; clock: { t: number } } {
    const r = makeCpu([counter(10, 30)]);
    r.cpu.program.put(ob1Raw(...ob1));
    r.cpu.setClock(T0);
    r.cpu.run();
    r.cpu.memory.M.set(sdt, 200);
    r.cpu.memory.M.set([0, 10, 0x02, 0x01], 210); // OB_NR = 10, PERIOD = ogni minuto
    return r;
  }

  it('nextTod: una volta, ogni minuto, ogni giorno, fine mese, mensile', () => {
    expect(nextTod(T0, 0, T0 - 1)).toBe(T0);
    expect(nextTod(T0, 0, T0)).toBeUndefined();
    expect(nextTod(T0, 0x0201, T0 + 61_000)).toBe(T0 + 120_000);
    expect(new Date(nextTod(T0, 0x1001, T0 + 1)!).getDate()).toBe(31);
    const eom = new Date(nextTod(T0, 0x2001, T0 + 1)!);
    expect([eom.getMonth(), eom.getDate(), eom.getHours()]).toEqual([10, 30, 10]);
    // Mensile dal 31: salta i mesi senza 31 (⚠️).
    const jan31 = new Date(2026, 0, 31, 8, 0).getTime();
    expect(new Date(nextTod(jan31, 0x1401, jan31)!).getMonth()).toBe(2);
    // Annuale dal 29 febbraio: solo negli anni bisestili, come il mensile (⚠️).
    const feb29 = new Date(2024, 1, 29, 8, 0).getTime();
    const y = new Date(nextTod(feb29, 0x1801, feb29)!);
    expect([y.getFullYear(), y.getMonth(), y.getDate()]).toEqual([2028, 1, 29]);
  });

  it('SET_TINT + ACT_TINT: OB10 alle 10:01 (secondi ignorati) e poi ogni minuto', () => {
    const { cpu, clock } = tod(setTint(), awl(actQry));
    cpu.cycle();
    expect([mw(cpu, 100), mw(cpu, 102), mw(cpu, 104)]).toEqual([0, 0, 0]);
    expect(mw(cpu, 106)).toBe(0x14);
    cpu.program.put(ob1Raw(awl('\tNOP 0;')));
    clock.t = 59_999;
    cpu.cycle();
    expect(mw(cpu, 30)).toBe(0);
    clock.t = 60_000;
    cpu.cycle();
    expect(mw(cpu, 30)).toBe(1);
    clock.t = 120_000;
    cpu.cycle();
    expect(mw(cpu, 30)).toBe(2);
  });

  it('CAN_TINT cancella; ACT_TINT senza data → 16#80A0; PERIOD errato → 16#8092', () => {
    const { cpu, clock } = tod(
      awl('\tCALL SFC 29 (OB_NR := 10, RET_VAL := MW 108);'),
      awl('\tCALL SFC 30 (OB_NR := 10, RET_VAL := MW 110);'),
    );
    cpu.cycle();
    expect([mw(cpu, 108), mw(cpu, 110)]).toEqual([0x80a0, 0x80a0]);
    cpu.memory.M.set([0x12, 0x34], 212);
    cpu.program.put(ob1Raw(setTint()));
    cpu.cycle();
    expect(mw(cpu, 100)).toBe(0x8092);
    cpu.memory.M.set([0x02, 0x01], 212);
    cpu.program.put(
      ob1Raw(setTint(), awl(actQry), awl('\tCALL SFC 29 (OB_NR := 10, RET_VAL := MW 108);')),
    );
    cpu.cycle();
    expect(mw(cpu, 108)).toBe(0);
    cpu.program.put(ob1Raw(awl('\tNOP 0;')));
    clock.t = 60_000;
    cpu.cycle();
    expect(mw(cpu, 30)).toBe(0);
  });

  it('ACT_TINT di un allarme «una volta» già passato → 16#80A1', () => {
    const { cpu } = tod(setTint(), awl(actQry));
    cpu.memory.M.set([0x26, 0x10, 0x30, 0x09], 200); // 09:01, già passato
    cpu.memory.M.set([0, 0], 212);
    cpu.cycle();
    expect(mw(cpu, 102)).toBe(0x80a1);
  });
});

describe('maschere degli errori sincroni (SFC 36, 37, 38)', () => {
  // Bit 2 di PRGFLT = SW_FLT 16#22 (area in lettura).
  const mask =
    '\tCALL SFC 36 (PRGFLT_SET_MASK := DW#16#4, ACCFLT_SET_MASK := DW#16#0, RET_VAL := MW 100, PRGFLT_MASKED := MD 110, ACCFLT_MASKED := MD 114);';
  const query =
    '\tCALL SFC 38 (PRGFLT_QUERY := DW#16#4, ACCFLT_QUERY := DW#16#0, RET_VAL := MW 102, PRGFLT_CLR := MD 120, ACCFLT_CLR := MD 124);';

  it('errore mascherato: niente OB121 né STOP, READ_ERR lo riporta e lo cancella', () => {
    const { cpu } = makeCpu([
      ob(1, mask, '\tL MW 4000;\n\tT MW 20;', query, query.replace('MD 120', 'MD 130')),
    ]);
    cpu.run();
    expect(cpu.cycle().ok).toBe(true);
    expect(cpu.mode).toBe('RUN');
    expect(md(cpu, 110)).toBe(4);
    expect(mw(cpu, 100)).toBe(0);
    expect(md(cpu, 120)).toBe(4);
    expect(md(cpu, 130)).toBe(0);
    expect(mw(cpu, 102)).toBe(0);
  });

  it('DMSK_FLT toglie la maschera: lo stesso errore porta in STOP', () => {
    const unmask =
      '\tCALL SFC 37 (PRGFLT_RESET_MASK := DW#16#4, ACCFLT_RESET_MASK := DW#16#0, RET_VAL := MW 104, PRGFLT_MASKED := MD 110, ACCFLT_MASKED := MD 114);';
    const { cpu } = makeCpu([ob(1, mask, unmask, '\tL MW 4000;')]);
    cpu.run();
    cpu.cycle();
    expect(mw(cpu, 104)).toBe(0);
    expect(md(cpu, 110)).toBe(0);
    expect(cpu.mode).toBe('STOP');
  });

  it('maschera già attiva → 16#0001; le maschere finiscono con l’OB (⚠️)', () => {
    const { cpu } = makeCpu([ob(1, mask, mask.replace('MW 100', 'MW 106'), '\tL MW 4000;')]);
    cpu.run();
    cpu.cycle();
    expect([mw(cpu, 100), mw(cpu, 106)]).toEqual([0, 1]);
    cpu.memory.M.fill(0, 100, 108);
    cpu.cycle();
    expect([mw(cpu, 100), mw(cpu, 106)]).toEqual([0, 1]);
    expect(cpu.mode).toBe('RUN');
  });
});

describe('DIS_IRT, EN_IRT (SFC 39, 40)', () => {
  it('OB20 bloccato si scarta (non aspetta); EN_IRT lo riabilita', () => {
    const { cpu, clock } = makeCpu([
      ob(
        100,
        '\tCALL SFC 39 (MODE := B#16#2, OB_NR := 20, RET_VAL := MW 100);',
        '\tCALL SFC 32 (OB_NR := 20, DTIME := T#10MS, SIGN := W#16#0, RET_VAL := MW 102);',
      ),
      ob(1, '\tCALL SFC 34 (OB_NR := 20, RET_VAL := MW 104, STATUS := MW 106);'),
      counter(20, 30),
    ]);
    cpu.run();
    cpu.cycle();
    expect(mw(cpu, 106)).toBe(0x16);
    clock.t = 20;
    cpu.cycle();
    expect(mw(cpu, 30)).toBe(0);
    cpu.program.put(
      buildProgram(
        [ob(1, '\tCALL SFC 40 (MODE := B#16#0, OB_NR := 0, RET_VAL := MW 108);')],
        {},
        SFCS,
      ).get('OB', 1)!,
    );
    cpu.cycle();
    expect(mw(cpu, 108)).toBe(0);
    expect(mw(cpu, 30)).toBe(0);
  });

  it('MODE 1 con la classe 30 blocca OB35; MODE errato → 16#8091, OB_NR errato → 16#8090', () => {
    const clock = { t: 0 };
    const cpu = new SimCpu({
      cpuTypeId: 'cpu-315-2-pn-dp',
      props: { ...PROPS, cyclicInterruptMs: 10 },
      now: () => clock.t,
    });
    const specs = [
      ob(
        1,
        '\tCALL SFC 39 (MODE := B#16#1, OB_NR := 30, RET_VAL := MW 100);',
        '\tCALL SFC 39 (MODE := B#16#7, OB_NR := 0, RET_VAL := MW 102);',
        '\tCALL SFC 39 (MODE := B#16#2, OB_NR := 1, RET_VAL := MW 104);',
      ),
      counter(35, 30),
    ];
    for (const b of buildProgram(specs, {}, SFCS).list()) cpu.program.put(b);
    cpu.run();
    cpu.cycle();
    clock.t = 50;
    cpu.cycle();
    expect(mw(cpu, 30)).toBe(0);
    expect([mw(cpu, 100), mw(cpu, 102), mw(cpu, 104)]).toEqual([0, 0x8091, 0x8090]);
  });
});

describe('WR_USMSG (SFC 52)', () => {
  const call = (send: string, ev: string, ret: number): string =>
    `\tCALL SFC 52 (SEND := ${send}, EVENTN := W#16#${ev}, INFO1 := P#M 20.0 WORD 1, INFO2 := P#M 22.0 DWORD 1, RET_VAL := MW ${ret});`;

  it('voce utente con EVENTN e informazioni; EVENTN fuori campo → 16#8083', () => {
    const { cpu } = makeCpu([
      ob(1, call('FALSE', 'A101', 100), call('TRUE', 'A102', 102), call('FALSE', '1234', 104)),
    ]);
    cpu.run();
    cpu.memory.M.set([0x12, 0x34, 1, 2, 3, 4], 20);
    cpu.cycle();
    expect([mw(cpu, 100), mw(cpu, 102), mw(cpu, 104)]).toEqual([0, 1, 0x8083]);
    const user = cpu.diagnostics.filter((d) => d.code === 'MESSAGGIO_UTENTE');
    expect(user.map((d) => d.eventId)).toEqual([0xa101, 0xa102]);
    expect(user[0]!.detail).toBe('16#A101 INFO1 16#1234 INFO2 16#01020304');
  });
});

describe('indirizzi e set di dati senza moduli (SFC 5, 49, 58, 59)', () => {
  it('GADR_LGC 16#8099, LGC_GADR 16#8090, WR_REC/RD_REC 16#8090 con REQ = 1, 0 con REQ = 0', () => {
    const { cpu } = makeCpu([
      ob(
        1,
        '\tCALL SFC 5 (SUBNETID := B#16#0, RACK := W#16#0, SLOT := W#16#4, SUBSLOT := B#16#0, SUBADDR := W#16#0, RET_VAL := MW 100, IOID := MB 10, LADDR := MW 12);',
        '\tCALL SFC 49 (IOID := B#16#54, LADDR := W#16#0, RET_VAL := MW 102, AREA := MB 14, RACK := MW 16, SLOT := MW 18, SUBADDR := MW 20);',
        '\tCALL SFC 58 (REQ := TRUE, IOID := B#16#54, LADDR := W#16#100, RECNUM := B#16#1, RECORD := P#M 30.0 BYTE 4, RET_VAL := MW 104, BUSY := M 40.0);',
        '\tCALL SFC 59 (REQ := FALSE, IOID := B#16#54, LADDR := W#16#100, RECNUM := B#16#1, RET_VAL := MW 106, BUSY := M 40.1, RECORD := P#M 30.0 BYTE 4);',
      ),
    ]);
    cpu.run();
    cpu.cycle();
    expect([mw(cpu, 100), mw(cpu, 102), mw(cpu, 104), mw(cpu, 106)]).toEqual([
      0x8099, 0x8090, 0x8090, 0,
    ]);
  });
});
