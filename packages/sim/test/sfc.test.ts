import { findSystemBlock } from '@baaportal/catalog';
import { encodeCode } from '@baaportal/mc7';
import type { AwlBlockInfo } from '@baaportal/awl';
import { buildSzl, szlIdList } from '@baaportal/s7-server';
import { describe, expect, it } from 'vitest';
import { SimCpu, simBackend, type LoadedBlock, type SimCpuOptions, type SimEvent } from '../src';
import { buildProgram, runProgram, setWord, word, type BlockSpec } from './programHelpers';

const PROPS: SimCpuOptions['props'] = {
  maxCycleMs: 150,
  minCycleMs: 0,
  clockMemory: { enabled: false, byte: 0 },
  retentivity: { mBytes: 16, timers: 2, counters: 2 },
  cyclicInterruptMs: 0,
};

/** Interfaccia di una SFC del catalogo, nella forma che il compilatore si aspetta. */
function sfcInfo(number: number): AwlBlockInfo {
  const b = findSystemBlock({ kind: 'SFC', number });
  if (!b) throw new Error(`SFC${number} assente dal catalogo`);
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

const ob1 = (...networks: string[]): BlockSpec => ({ kind: 'OB', number: 1, networks });
const SFCS = [0, 1, 14, 20, 21, 22, 23, 24, 46, 47, 51, 64].map(sfcInfo);
const compile = (...networks: string[]) => buildProgram([ob1(...networks)], {}, SFCS);

function makeCpu(program = compile('\tNOP 0;')): { cpu: SimCpu; clock: { t: number } } {
  const clock = { t: 0 };
  const cpu = new SimCpu({ cpuTypeId: 'cpu-315-2-pn-dp', props: PROPS, now: () => clock.t });
  for (const b of program.list()) cpu.program.put(b);
  return { cpu, clock };
}

const w16 = (n: number): number[] => [n >> 8, n & 255];
/** Puntatore a un'area di memoria assoluta (byte.bit) nella lista dei parametri. */
const ptr = (area: number, byte: number, bit = 0): number[] => {
  const a = byte * 8 + bit;
  return [area, a >> 16, (a >> 8) & 255, a & 255];
};
const M = (byte: number, bit = 0): number[] => ptr(0x83, byte, bit);
/** ANY di `len` byte di `type` a partire da un'area. */
const any = (type: number, count: number, db: number, p: number[]): number[] => [
  0x10,
  type,
  ...w16(count),
  ...w16(db),
  ...p,
];

/** Chiamata di SFC con la lista dei puntatori scritta a mano (per i tipi che il compilatore non copre). */
function rawSfc(number: number, pointers: number[][]): Uint8Array {
  const body = pointers.flat();
  return Uint8Array.from([
    0xfb,
    0x74,
    ...w16(number),
    0x70,
    0x0b,
    ...w16(2 + body.length / 2),
    ...body,
  ]);
}

/** encodeCode chiude ogni programma con BE (2 byte): qui i pezzi si concatenano. */
const withoutBe = (code: Uint8Array): Uint8Array => code.subarray(0, code.length - 2);

function ob1Raw(...parts: (string | Uint8Array)[]): LoadedBlock {
  const chunks = parts.map((p) => (typeof p === 'string' ? withoutBe(encodeCode([p]).mc7) : p));
  const code = Uint8Array.from(chunks.flatMap((c) => [...c]));
  return { kind: 'OB', number: 1, code, localBytes: 20, networkStarts: [0] } as LoadedBlock;
}

const bytes = (mem: Uint8Array, at: number, n: number): number[] => [...mem.subarray(at, at + n)];

describe('BLKMOV (SFC 20)', () => {
  const blkmov = (src: string, dst: string) =>
    `\tCALL SFC 20 (SRCBLK := ${src}, DSTBLK := ${dst}, RET_VAL := MW 100);\n\tA BR;\n\t= M 120.0;`;

  it('DB1 → M e M → DB con ANY costanti (P#DB1.DBX0.0 BYTE 10)', () => {
    const p = compile(
      blkmov('P#DB1.DBX 0.0 BYTE 10', 'P#M 10.0 BYTE 10'),
      blkmov('P#M 10.0 BYTE 10', 'P#DB2.DBX 2.0 BYTE 10'),
    );
    const r = runProgram(p, {
      dbs: { 1: 16, 2: 16 },
      setup: (mem) => mem.dbs.get(1)!.data.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    });
    expect(bytes(r.mem.M, 10, 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(bytes(r.mem.dbs.get(2)!.data, 0, 14)).toEqual([
      0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0, 0,
    ]);
    expect(word(r.mem, 100)).toBe(0);
    expect(r.mem.M[120]! & 1).toBe(1);
  });

  it('DB inesistente → RET_VAL 16#813A (parametro 1), BR = 0, nessuna scrittura', () => {
    const p = compile(blkmov('P#DB9.DBX 0.0 BYTE 4', 'P#M 10.0 BYTE 4'));
    const r = runProgram(p, { setup: (mem) => mem.M.fill(0xee, 10, 14) });
    expect(word(r.mem, 100)).toBe(0x813a);
    expect(bytes(r.mem.M, 10, 4)).toEqual([0xee, 0xee, 0xee, 0xee]);
    expect(r.mem.M[120]! & 1).toBe(0);
  });

  it('destinazione più lunga del DB → 16#8223, nessuna scrittura parziale', () => {
    const p = compile(blkmov('P#M 10.0 BYTE 8', 'P#DB1.DBX 0.0 BYTE 8'));
    const r = runProgram(p, {
      dbs: { 1: 6 },
      setup: (mem) => mem.M.fill(0x55, 10, 18),
    });
    expect(word(r.mem, 100)).toBe(0x8223);
    expect(bytes(r.mem.dbs.get(1)!.data, 0, 6)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('sorgente fuori dall’area (M oltre la fine) → 16#8122, destinazione intatta', () => {
    const p = compile(blkmov('P#M 4090.0 BYTE 20', 'P#DB1.DBX 0.0 BYTE 20'));
    const r = runProgram(p, { dbs: { 1: 20 } });
    expect(word(r.mem, 100)).toBe(0x8122);
    expect(bytes(r.mem.dbs.get(1)!.data, 0, 20).every((b) => b === 0)).toBe(true);
  });

  it('sorgente e destinazione che si sovrappongono → errore, nessuna copia', () => {
    const p = compile(blkmov('P#M 10.0 BYTE 8', 'P#M 14.0 BYTE 8'));
    const r = runProgram(p, { setup: (mem) => mem.M.set([1, 2, 3, 4, 5, 6, 7, 8], 10) });
    expect(word(r.mem, 100)).toBe(0x8091);
    expect(bytes(r.mem.M, 14, 4)).toEqual([5, 6, 7, 8]);
  });

  it('sorgente più lunga della destinazione: si copia quanto sta', () => {
    const p = compile(blkmov('P#M 10.0 BYTE 6', 'P#M 30.0 BYTE 4'));
    const r = runProgram(p, { setup: (mem) => mem.M.set([1, 2, 3, 4, 5, 6], 10) });
    expect(word(r.mem, 100)).toBe(0);
    expect(bytes(r.mem.M, 30, 6)).toEqual([1, 2, 3, 4, 0, 0]);
  });

  it('lunghezza dal tipo: WORD × 3 = 6 byte', () => {
    const p = compile(blkmov('P#M 10.0 WORD 3', 'P#M 30.0 BYTE 8'));
    const r = runProgram(p, { setup: (mem) => mem.M.set([1, 2, 3, 4, 5, 6, 7], 10) });
    expect(bytes(r.mem.M, 30, 8)).toEqual([1, 2, 3, 4, 5, 6, 0, 0]);
  });
});

describe('FILL (SFC 21)', () => {
  it('riempie BLK ripetendo BVAL, l’ultima copia troncata', () => {
    const p = compile(
      '\tCALL SFC 21 (BVAL := P#M 0.0 BYTE 2, BLK := P#M 10.0 BYTE 5, RET_VAL := MW 100);',
    );
    const r = runProgram(p, { setup: (mem) => mem.M.set([0xab, 0xcd], 0) });
    expect(word(r.mem, 100)).toBe(0);
    expect(bytes(r.mem.M, 10, 6)).toEqual([0xab, 0xcd, 0xab, 0xcd, 0xab, 0]);
  });

  it('BLK in un DB inesistente → 16#823A, BVAL intatto', () => {
    const p = compile(
      '\tCALL SFC 21 (BVAL := P#M 0.0 BYTE 2, BLK := P#DB5.DBX 0.0 BYTE 4, RET_VAL := MW 100);',
    );
    const r = runProgram(p, { setup: (mem) => mem.M.set([1, 2], 0) });
    expect(word(r.mem, 100)).toBe(0x823a);
    expect(bytes(r.mem.M, 0, 2)).toEqual([1, 2]);
  });
});

describe('CREAT_DB, TEST_DB, DEL_DB (SFC 22–24)', () => {
  const create = (lo: string, up: string, count: string) =>
    `\tCALL SFC 22 (LOW_LIMIT := ${lo}, UP_LIMIT := ${up}, COUNT := ${count}, DB_NUMBER := MW 10, RET_VAL := MW 100);`;

  it('crea il DB col numero libero più basso, lo prova e lo cancella', () => {
    const p = compile(
      create('W#16#A', 'W#16#14', 'W#16#8'),
      create('W#16#A', 'W#16#14', 'W#16#8'),
      '\tCALL SFC 24 (DB_NUMBER := W#16#A, DB_LENGTH := MW 20, WRITE_PROT := M 30.0, RET_VAL := MW 102);',
      '\tCALL SFC 23 (DB_NUMBER := W#16#A, RET_VAL := MW 104);',
      '\tCALL SFC 24 (DB_NUMBER := W#16#A, DB_LENGTH := MW 22, WRITE_PROT := M 30.1, RET_VAL := MW 106);',
    );
    const r = runProgram(p, { setup: (mem) => setWord(mem, 22, 0x7777) });
    expect(r.mem.dbs.has(11)).toBe(true);
    expect(r.mem.dbs.get(11)!.data).toHaveLength(8);
    expect(word(r.mem, 10)).toBe(11);
    expect(r.mem.dbs.has(10)).toBe(false);
    expect(word(r.mem, 20)).toBe(8);
    expect(word(r.mem, 102)).toBe(0);
    expect(word(r.mem, 104)).toBe(0);
    // DB 10 non esiste più: errore e DB_LENGTH non scritto.
    expect(word(r.mem, 106)).toBe(0x80b1);
    expect(word(r.mem, 22)).toBe(0x7777);
  });

  it('limiti sbagliati → 16#80A1, COUNT dispari → 16#80B1, nessun DB creato', () => {
    const p = compile(
      create('W#16#14', 'W#16#A', 'W#16#8'),
      '\tL MW 100;\n\tT MW 110;',
      create('W#16#A', 'W#16#14', 'W#16#7'),
    );
    const r = runProgram(p);
    expect(word(r.mem, 110)).toBe(0x80a1);
    expect(word(r.mem, 100)).toBe(0x80b1);
    expect(r.mem.dbs.size).toBe(0);
  });

  it('range già tutto occupato → errore, nessun DB creato', () => {
    const p = compile(create('W#16#A', 'W#16#A', 'W#16#8'));
    const r = runProgram(p, { dbs: { 10: 4 } });
    expect(word(r.mem, 100)).toBe(0x80b2);
    expect(r.mem.dbs.get(10)!.data).toHaveLength(4);
  });
});

describe('orologio (SFC 0 e 1)', () => {
  const DT = [0x26, 0x10, 0x24, 0x12, 0x34, 0x56, 0x78, 0x97];
  const setClk = rawSfc(0, [M(0), M(100)]);
  const readClk = rawSfc(1, [M(100), M(10)]);

  it('READ_CLK dopo SET_CLK dà la data impostata, che avanza con l’orologio', () => {
    const { cpu, clock } = makeCpu();
    cpu.program.put(ob1Raw(setClk, readClk));
    cpu.run();
    cpu.memory.M.set(DT, 0);
    cpu.cycle();
    expect(cpu.mode).toBe('RUN');
    expect(bytes(cpu.memory.M, 10, 8)).toEqual(DT);
    expect(word(cpu.memory, 100)).toBe(0);
    // Solo lettura, 5 secondi dopo.
    cpu.program.put(ob1Raw(readClk));
    clock.t += 5000;
    cpu.cycle();
    expect(bytes(cpu.memory.M, 10, 8)).toEqual([0x26, 0x10, 0x24, 0x12, 0x35, 0x01, 0x78, 0x97]);
  });

  it('data non valida → 16#8080', () => {
    const { cpu } = makeCpu();
    cpu.program.put(ob1Raw(setClk));
    cpu.run();
    cpu.memory.M.set([0x26, 0x13, 0x24, 0x12, 0x34, 0x56, 0x78, 0x97], 0);
    cpu.cycle();
    expect(word(cpu.memory, 100)).toBe(0x8080);
  });

  it('i dati di avvio degli OB usano l’orologio della CPU', () => {
    const { cpu } = makeCpu();
    cpu.program.put(ob1Raw(setClk));
    cpu.run();
    cpu.memory.M.set(DT, 0);
    cpu.cycle();
    cpu.program.put(ob1Raw('\tL LB 12;\n\tT MB 60;\n\tL LB 13;\n\tT MB 61;'));
    cpu.cycle();
    expect(cpu.memory.M[60]).toBe(0x26);
    expect(cpu.memory.M[61]).toBe(0x10);
  });
});

describe('STP, WAIT, TIME_TCK (SFC 46, 47, 64)', () => {
  it('STP → STOP con la voce STOP_RICHIESTO, il resto dell’OB non gira', () => {
    const { cpu } = makeCpu(compile('\tSET;\n\t= M 0.0;', '\tCALL SFC 46;', '\tSET;\n\t= M 0.1;'));
    cpu.run();
    const r = cpu.cycle();
    expect(cpu.mode).toBe('STOP');
    expect(r.ran).toBe(true);
    expect(cpu.memory.M[0]).toBe(1);
    const stop = cpu.diagnostics.filter((d) => d.code === 'STOP_RICHIESTO');
    expect(stop).toHaveLength(1);
    expect(stop[0]!.detail).toContain('SFC 46');
  });

  it('TIME_TCK avanza con l’orologio e fa il giro a 2^31', () => {
    const { cpu, clock } = makeCpu(compile('\tCALL SFC 64 (RET_VAL := MD 40);'));
    clock.t = 1000;
    cpu.run();
    clock.t = 3500;
    cpu.cycle();
    const md = (): number => new DataView(cpu.memory.M.buffer).getUint32(40);
    expect(md()).toBe(2500);
    clock.t = 1000 + 2 ** 31 + 7;
    cpu.cycle();
    expect(md()).toBe(7);
  });

  it('WAIT fa avanzare il tempo del ciclo senza attendere davvero', () => {
    const { cpu } = makeCpu(compile('\tCALL SFC 47 (WT := 20000);'));
    cpu.run();
    const r = cpu.cycle();
    expect(r.ok).toBe(true);
    expect(r.elapsedMs).toBe(20);
  });
});

describe('RDSYSST (SFC 51)', () => {
  // REQ, SSL_ID, INDEX, RET_VAL, BUSY, SSL_HEADER, DR
  const rd = (): Uint8Array => rawSfc(51, [M(0, 0), M(2), M(4), M(6), M(8, 0), M(10), M(20)]);

  function read(id: number, index: number): { cpu: SimCpu; mem: Uint8Array } {
    const { cpu } = makeCpu();
    cpu.program.put(ob1Raw(rd()));
    cpu.run();
    const m = cpu.memory.M;
    m[0] = 1;
    m.set(w16(id), 2);
    m.set(w16(index), 4);
    m.fill(0xff, 100, 300);
    m.set(any(0x02, 150, 0, M(100)), 20);
    cpu.cycle();
    return { cpu, mem: m };
  }

  it('0x0424: modo operativo RUN, stessi byte del server S7', () => {
    const { cpu, mem } = read(0x0424, 0);
    expect(word(cpu.memory, 6)).toBe(0);
    expect(cpu.memory.M[8]! & 1).toBe(0);
    const list = buildSzl(simBackend(cpu), 0x0424, 0)!;
    expect(bytes(mem, 10, 4)).toEqual([...w16(list.recordLength), ...w16(list.records.length)]);
    // Gli ultimi 8 byte sono l'ora del cambio di modo, che dipende dal momento in cui si crea il backend.
    expect(bytes(mem, 100, 12)).toEqual([...list.records[0]!.subarray(0, 12)]);
    expect(mem[103]! & 0x0f).toBe(8);
  });

  it('0x0011 indice 0 e 0x0111 indice 1', () => {
    for (const [id, index] of [
      [0x0011, 0],
      [0x0111, 1],
    ] as const) {
      const { cpu, mem } = read(id, index);
      const list = buildSzl(simBackend(cpu), id, index)!;
      const flat = list.records.flatMap((r) => [...r]);
      expect(word(cpu.memory, 6)).toBe(0);
      expect(bytes(mem, 10, 4)).toEqual([...w16(list.recordLength), ...w16(list.records.length)]);
      expect(bytes(mem, 100, flat.length)).toEqual(flat);
    }
  });

  it('0x00A0: il buffer di diagnostica, voci più recenti per prime', () => {
    const { cpu, mem } = read(0x00a0, 0);
    const list = buildSzl(simBackend(cpu), 0x00a0, 0)!;
    expect(list.records.length).toBeGreaterThan(0);
    expect(bytes(mem, 12, 2)).toEqual(w16(list.records.length));
    // Con l'orologio di prova la data della voce ripiega sull'ora di sistema: si confrontano i primi 12 byte.
    expect(bytes(mem, 100, 12)).toEqual([...list.records[0]!.subarray(0, 12)]);
  });

  it('DR troppo corto: dati troncati, RET_VAL 16#0081, nessuna scrittura oltre', () => {
    const { cpu } = makeCpu();
    cpu.program.put(ob1Raw(rd()));
    cpu.run();
    const m = cpu.memory.M;
    m[0] = 1;
    m.set(w16(0x0011), 2);
    m.fill(0xff, 100, 140);
    m.set(any(0x02, 10, 0, M(100)), 20);
    cpu.cycle();
    expect(word(cpu.memory, 6)).toBe(0x0081);
    expect(bytes(m, 110, 4)).toEqual([0xff, 0xff, 0xff, 0xff]);
  });

  it('SZL-ID sconosciuto → 16#8082', () => {
    expect(szlIdList()).not.toContain(0x7777);
    const { cpu } = read(0x7777, 0);
    expect(word(cpu.memory, 6)).toBe(0x8082);
  });
});

describe('SFC o SFB non simulati', () => {
  const dpRd = '\tCALL SFC 14 (LADDR := W#16#10, RECORD := P#M 0.0 BYTE 4, RET_VAL := MW 100);';
  const program = () => compile('\tSET;\n\t= M 1.0;', dpRd + '\n\tA BR;\n\t= M 1.0;');

  it('SFC 14: avviso una volta, BR = 0, uscite intatte, la CPU resta in RUN', () => {
    const { cpu } = makeCpu(program());
    const events: SimEvent[] = [];
    cpu.onEvent((e) => events.push(e));
    cpu.run();
    cpu.memory.M.set(w16(0x1234), 100);
    for (let i = 0; i < 3; i++) cpu.cycle();
    expect(cpu.mode).toBe('RUN');
    expect(cpu.memory.M[1]! & 1).toBe(0);
    expect(word(cpu.memory, 100)).toBe(0x1234);
    expect(bytes(cpu.memory.M, 0, 4)).toEqual([0, 0, 0, 0]);
    const diag = cpu.diagnostics.filter((d) => d.code === 'SFC_NON_SIMULATA');
    expect(diag).toHaveLength(1);
    expect(diag[0]!.detail).toContain('SFC 14');
    expect(events.filter((e) => e.type === 'warning')).toHaveLength(1);
    expect(events.find((e) => e.type === 'warning')).toMatchObject({
      code: 'SFC_NON_SIMULATA',
      block: 'SFC14',
    });
  });

  it('un nuovo periodo di RUN avvisa di nuovo', () => {
    const { cpu } = makeCpu(program());
    cpu.run();
    cpu.cycle();
    cpu.stop();
    cpu.run();
    cpu.cycle();
    expect(cpu.diagnostics.filter((d) => d.code === 'SFC_NON_SIMULATA')).toHaveLength(2);
  });

  it('UC SFB senza gestore → SFB_NON_SIMULATA, BR = 0, CPU in RUN', () => {
    const { cpu } = makeCpu();
    cpu.program.put(ob1Raw('\tSET;\n\t= M 1.0;', '\tUC SFB 32;', '\tA BR;\n\t= M 1.0;'));
    cpu.run();
    cpu.cycle();
    cpu.cycle();
    expect(cpu.mode).toBe('RUN');
    expect(cpu.memory.M[1]! & 1).toBe(0);
    expect(cpu.diagnostics.filter((d) => d.code === 'SFB_NON_SIMULATA')).toHaveLength(1);
  });

  it('UC SFC con numero fuori dal catalogo → SW_FLT 16#3D (id 16#253D), STOP senza OB121', () => {
    const { cpu } = makeCpu();
    cpu.program.put(ob1Raw('\tUC SFC 199;'));
    cpu.run();
    cpu.cycle();
    expect(cpu.mode).toBe('STOP');
    expect(cpu.diagnostics.at(-1)).toMatchObject({ code: 'BLOCCO_NON_CARICATO', eventId: 0x253d });
  });
});

describe('giro 1: effetti parziali e aree ANY', () => {
  const blkmovRaw = (): Uint8Array => rawSfc(20, [M(200), M(100), M(210)]);

  function run(code: Uint8Array | LoadedBlock, setup: (m: Uint8Array, cpu: SimCpu) => void) {
    const { cpu, clock } = makeCpu();
    cpu.program.put('kind' in code ? code : ob1Raw(code));
    cpu.run();
    setup(cpu.memory.M, cpu);
    cpu.cycle();
    return { cpu, clock, m: cpu.memory.M };
  }

  it('CREAT_DB con DB_NUMBER fuori area: STOP e nessun DB orfano', () => {
    const { cpu } = run(rawSfc(22, [M(0), M(2), M(4), M(6), M(65000)]), (m) => {
      m.set([0, 10, 0, 20, 0, 8], 0);
    });
    expect(cpu.mode).toBe('STOP');
    expect(cpu.memory.dbs.size).toBe(0);
  });

  it('RDSYSST: BUSY = 0 anche se DR non è valido', () => {
    const { m } = run(rawSfc(51, [M(0, 0), M(2), M(4), M(6), M(8, 0), M(10), M(20)]), (m) => {
      m[0] = 1;
      m.set(w16(0x0011), 2);
      m[8] = 1;
      m.set(any(0x02, 10, 9, ptr(0x84, 0)), 20);
    });
    expect(m[8]! & 1).toBe(0);
    expect((m[6]! << 8) | m[7]!).toBe(0x863a);
  });

  it('RDSYSST con REQ = 0: BUSY = 0, RET_VAL 0, niente scritto', () => {
    const { m } = run(rawSfc(51, [M(0, 0), M(2), M(4), M(6), M(8, 0), M(10), M(20)]), (m) => {
      m[0] = 0;
      m[8] = 1;
      m.set(w16(0x0011), 2);
      m.set(any(0x02, 40, 0, M(100)), 20);
      m.fill(0xee, 10, 14);
    });
    expect(m[8]! & 1).toBe(0);
    expect((m[6]! << 8) | m[7]!).toBe(0);
    expect(bytes(m, 10, 4)).toEqual([0xee, 0xee, 0xee, 0xee]);
    expect(bytes(m, 100, 4)).toEqual([0, 0, 0, 0]);
  });

  it('BLKMOV verso l’area L del chiamante (ANY con area 16#86)', () => {
    const ob = ob1Raw(blkmovRaw(), '\tL LD 4;\n\tT MD 40;');
    const { m } = run(ob, (m) => {
      m.set([1, 2, 3, 4], 10);
      m.set(any(0x02, 4, 0, M(10)), 200);
      m.set(any(0x02, 4, 0, ptr(0x86, 4)), 210);
    });
    expect(bytes(m, 40, 4)).toEqual([1, 2, 3, 4]);
    expect((m[100]! << 8) | m[101]!).toBe(0);
  });

  it('BLKMOV verso V in un OB (nessun chiamante): finestra vuota → 16#8223', () => {
    const { m } = run(blkmovRaw(), (m) => {
      m.set([1, 2, 3, 4], 10);
      m.set(any(0x02, 4, 0, M(10)), 200);
      m.set(any(0x02, 4, 0, ptr(0x87, 0)), 210);
    });
    expect((m[100]! << 8) | m[101]!).toBe(0x8223);
  });

  it('BLKMOV da M a un DB di istanza (ANY con area 16#85)', () => {
    const { cpu } = run(blkmovRaw(), (m, c) => {
      c.memory.dbs.set(3, {
        data: new Uint8Array(8),
        initial: new Uint8Array(8),
        retentive: false,
      });
      m.set([9, 8, 7, 6], 10);
      m.set(any(0x02, 4, 0, M(10)), 200);
      m.set(any(0x02, 4, 3, ptr(0x85, 2)), 210);
    });
    expect(bytes(cpu.memory.dbs.get(3)!.data, 0, 8)).toEqual([0, 0, 9, 8, 7, 6, 0, 0]);
  });

  it('ANY di BOOL con ripetizioni non multiple di 8 → 16#8128, nessuna scrittura', () => {
    const { m } = run(blkmovRaw(), (m) => {
      m.set(any(0x01, 4, 0, M(10)), 200);
      m.set(any(0x02, 4, 0, M(30)), 210);
    });
    expect((m[100]! << 8) | m[101]!).toBe(0x8128);
    expect(bytes(m, 30, 4)).toEqual([0, 0, 0, 0]);
  });

  it('STP da OB100: la CPU resta in STOP, OB1 non gira', () => {
    const program = buildProgram(
      [{ kind: 'OB', number: 100, networks: ['\tCALL SFC 46;'] }, ob1('\tSET;\n\t= M 0.0;')],
      {},
      SFCS,
    );
    const { cpu } = makeCpu(program);
    cpu.run();
    expect(cpu.mode).toBe('STOP');
    expect(cpu.diagnostics.filter((d) => d.code === 'STOP_RICHIESTO')).toHaveLength(1);
    expect(cpu.cycle().ran).toBe(false);
    expect(cpu.memory.M[0]).toBe(0);
  });

  it('TIME_TCK conta dal primo RUN, non dal riavvio', () => {
    const { cpu, clock } = makeCpu(compile('\tCALL SFC 64 (RET_VAL := MD 40);'));
    clock.t = 1000;
    cpu.run();
    cpu.stop();
    clock.t = 5000;
    cpu.run();
    clock.t = 6000;
    cpu.cycle();
    expect(new DataView(cpu.memory.M.buffer).getUint32(40)).toBe(5000);
  });
});
