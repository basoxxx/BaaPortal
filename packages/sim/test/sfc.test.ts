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
const SFCS = [0, 1, 6, 13, 14, 15, 20, 21, 22, 23, 24, 41, 42, 43, 44, 46, 47, 51, 64].map(sfcInfo);
const compile = (...networks: string[]) => buildProgram([ob1(...networks)], {}, SFCS);

function makeCpu(
  program = compile('\tNOP 0;'),
  props: Partial<SimCpuOptions['props']> = {},
): { cpu: SimCpu; clock: { t: number } } {
  const clock = { t: 0 };
  const cpu = new SimCpu({
    cpuTypeId: 'cpu-315-2-pn-dp',
    props: { ...PROPS, ...props },
    now: () => clock.t,
  });
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

  it('BLK oltre la fine dell’area M → 16#8223, niente scritto', () => {
    const p = compile(
      '\tCALL SFC 21 (BVAL := P#M 0.0 BYTE 1, BLK := P#M 2044.0 BYTE 8, RET_VAL := MW 100);',
    );
    const r = runProgram(p, { setup: (mem) => mem.M.set([7], 0) });
    expect(word(r.mem, 100)).toBe(0x8223);
    expect(r.mem.M.subarray(2044).every((b) => b === 0)).toBe(true);
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

  it('DR corto: si copiano solo record interi, N_DR = record copiati, RET_VAL 16#0081', () => {
    const { cpu } = makeCpu();
    const list = buildSzl(simBackend(cpu), 0x0011, 0)!;
    expect(list.records.length).toBeGreaterThan(2);
    const len = list.recordLength;
    cpu.program.put(ob1Raw(rd()));
    cpu.run();
    const m = cpu.memory.M;
    m[0] = 1;
    m.set(w16(0x0011), 2);
    m.fill(0xff, 100, 100 + 3 * len);
    m.set(any(0x02, 2 * len + 1, 0, M(100)), 20);
    cpu.cycle();
    expect(word(cpu.memory, 6)).toBe(0x0081);
    expect(bytes(m, 12, 2)).toEqual(w16(2));
    expect(bytes(m, 100, 2 * len)).toEqual(list.records.slice(0, 2).flatMap((r) => [...r]));
    expect(bytes(m, 100 + 2 * len, len).every((b) => b === 0xff)).toBe(true);
  });

  it('SZL-ID sconosciuto → 16#8082', () => {
    expect(szlIdList()).not.toContain(0x7777);
    const { cpu } = read(0x7777, 0);
    expect(word(cpu.memory, 6)).toBe(0x8082);
  });
});

describe('SFC o SFB non simulati', () => {
  const replVal = '\tCALL SFC 44 (VAL := DW#16#12345678, RET_VAL := MW 100);';
  const program = () => compile('\tSET;\n\t= M 1.0;', replVal + '\n\tA BR;\n\t= M 1.0;');

  it('SFC 44: avviso una volta, BR = 0, uscite intatte, la CPU resta in RUN', () => {
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
    expect(diag[0]!.detail).toContain('SFC 44');
    expect(events.filter((e) => e.type === 'warning')).toHaveLength(1);
    expect(events.find((e) => e.type === 'warning')).toMatchObject({
      code: 'SFC_NON_SIMULATA',
      block: 'SFC44',
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

  const ret = (m: Uint8Array, at = 6): number => (m[at]! << 8) | m[at + 1]!;
  const br = '\tA BR;\n\t= M 10.0;';

  it('CREAT_DB con DB_NUMBER fuori area: RET_VAL 16#8423, BR = 0, nessun DB creato', () => {
    const { cpu } = run(ob1Raw(rawSfc(22, [M(0), M(2), M(4), M(6), M(65000)]), br), (m) => {
      m.set([0, 10, 0, 20, 0, 8], 0);
      m[10] = 1;
    });
    expect(cpu.mode).toBe('RUN');
    expect(ret(cpu.memory.M)).toBe(0x8423);
    expect(cpu.memory.M[10]! & 1).toBe(0);
    expect(cpu.memory.dbs.size).toBe(0);
  });

  it('DEL_DB del DB aperto → 16#80C1 (⚠️), il DB resta', () => {
    const { cpu } = run(ob1Raw('\tOPN DB 9;', rawSfc(23, [M(0), M(2)])), (m, c) => {
      c.memory.dbs.set(9, {
        data: new Uint8Array(8),
        initial: new Uint8Array(8),
        retentive: false,
      });
      m.set([0, 9], 0);
    });
    expect((cpu.memory.M[2]! << 8) | cpu.memory.M[3]!).toBe(0x80c1);
    expect(cpu.memory.dbs.has(9)).toBe(true);
  });

  it('SET_CLK con PDT in un DB non aperto: RET_VAL 16#813A, BR = 0', () => {
    const { cpu } = run(ob1Raw(rawSfc(0, [ptr(0x84, 0), M(6)]), '\tA BR;\n\t= M 10.0;'), (m, c) => {
      c.memory.dbs.set(9, {
        data: new Uint8Array(8),
        initial: new Uint8Array(8),
        retentive: false,
      });
      m.set([0, 9], 0);
    });
    expect(cpu.mode).toBe('RUN');
    expect(ret(cpu.memory.M)).toBe(0x813a);
    expect(cpu.memory.M[10]! & 1).toBe(0);
  });

  it('RET_VAL non scrivibile resta un errore di programmazione (STOP senza OB121)', () => {
    const { cpu } = run(rawSfc(64, [M(65000)]), () => undefined);
    expect(cpu.mode).toBe('STOP');
  });

  it('RDSYSST: nessuna scrittura se SSL_HEADER non è scrivibile (BUSY compreso, DR intatta)', () => {
    const { m } = run(rawSfc(51, [M(0, 0), M(2), M(4), M(6), M(8, 0), M(65000), M(20)]), (m) => {
      m[0] = 1;
      m.set(w16(0x0011), 2);
      m[8] = 1;
      m.set(any(0x02, 40, 0, M(100)), 20);
      m.fill(0xee, 100, 140);
    });
    expect(ret(m)).toBe(0x8523);
    expect(m[8]! & 1).toBe(1);
    expect(bytes(m, 100, 4)).toEqual([0xee, 0xee, 0xee, 0xee]);
  });

  it('TEST_DB: nessuna scrittura se WRITE_PROT non è scrivibile (DB_LENGTH intatta)', () => {
    const { m } = run(rawSfc(24, [M(0), M(2), M(4), M(65000)]), (m, c) => {
      m.set(w16(3), 0);
      m.fill(0xee, 4, 6);
      c.memory.dbs.set(3, {
        data: new Uint8Array(8),
        initial: new Uint8Array(8),
        retentive: false,
      });
    });
    expect(ret(m, 2)).toBe(0x8323);
    expect(bytes(m, 4, 2)).toEqual([0xee, 0xee]);
  });

  it('RDSYSST con DR non valido: 16#863A, BUSY e SSL_HEADER intatti', () => {
    const { m } = run(rawSfc(51, [M(0, 0), M(2), M(4), M(6), M(8, 0), M(10), M(20)]), (m) => {
      m[0] = 1;
      m.set(w16(0x0011), 2);
      m[8] = 1;
      m.fill(0xee, 10, 14);
      m.set(any(0x02, 10, 9, ptr(0x84, 0)), 20);
    });
    expect(m[8]! & 1).toBe(1);
    expect(bytes(m, 10, 4)).toEqual([0xee, 0xee, 0xee, 0xee]);
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

// Tutte da verificare su CPU reale: codici e comportamento dal manuale, senza una CPU per confermarli.
describe('RD_SINFO (SFC 6)', () => {
  // RET_VAL, TOP_SI, START_UP_SI
  const rd = (): Uint8Array => rawSfc(6, [M(100), M(10), M(30)]);

  it('da OB1: TOP_SI = primi 12 byte dei dati di avvio di OB1, START_UP_SI = quelli di OB100', () => {
    const { cpu } = makeCpu();
    cpu.program.put(ob1Raw(rd()));
    cpu.run();
    cpu.cycle();
    expect(word(cpu.memory, 100)).toBe(0);
    expect(bytes(cpu.memory.M, 10, 4)).toEqual([0x11, 0x01, 1, 1]);
    expect(bytes(cpu.memory.M, 30, 12)).toEqual([0x13, 0x81, 27, 100, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(cpu.memory.M[22]).toBe(0); // si copiano solo 12 byte
    cpu.cycle();
    expect(cpu.memory.M[11]).toBe(0x03); // dal secondo ciclo, OB1 non è più il primo
  });

  it('START_UP_SI fuori area → 16#8223, TOP_SI intatta', () => {
    const { cpu } = makeCpu();
    cpu.program.put(ob1Raw(rawSfc(6, [M(100), M(10), M(4090)])));
    cpu.run();
    cpu.cycle();
    expect(word(cpu.memory, 100)).toBe(0x8223);
    expect(bytes(cpu.memory.M, 10, 4)).toEqual([0, 0, 0, 0]);
  });
});

describe('DPNRM_DG, DPRD_DAT, DPWR_DAT (SFC 13–15) senza DP', () => {
  const br = '\n\tA BR;\n\t= M 1.7;';

  it('DPRD_DAT → 16#8090, BR = 0, RECORD intatto', () => {
    const p = compile(
      '\tCALL SFC 14 (LADDR := W#16#100, RECORD := P#M 10.0 BYTE 4, RET_VAL := MW 100);' + br,
    );
    const r = runProgram(p, { setup: (mem) => mem.M.fill(0xee, 10, 14) });
    expect(word(r.mem, 100)).toBe(0x8090);
    expect(r.mem.M[1]! & 0x80).toBe(0);
    expect(bytes(r.mem.M, 10, 4)).toEqual([0xee, 0xee, 0xee, 0xee]);
  });

  it('DPWR_DAT → 16#8090', () => {
    const p = compile(
      '\tCALL SFC 15 (LADDR := W#16#100, RECORD := P#M 10.0 BYTE 4, RET_VAL := MW 100);',
    );
    expect(word(runProgram(p).mem, 100)).toBe(0x8090);
  });

  const dg = (req: string) =>
    `\tCALL SFC 13 (REQ := ${req}, LADDR := W#16#100, RET_VAL := MW 100, RECORD := P#M 10.0 BYTE 4, BUSY := M 1.1);` +
    br;

  it('DPNRM_DG con REQ = 0 → 16#7000 (BR = 1), BUSY = 0', () => {
    const r = runProgram(compile(dg('FALSE')), { setup: (mem) => (mem.M[1] = 0x02) });
    expect(word(r.mem, 100)).toBe(0x7000);
    expect(r.mem.M[1]).toBe(0x80);
  });

  it('DPNRM_DG con REQ = 1 → 16#8090, BUSY = 0, RECORD intatto', () => {
    const r = runProgram(compile(dg('TRUE')), { setup: (mem) => mem.M.fill(0xee, 10, 14) });
    expect(word(r.mem, 100)).toBe(0x8090);
    expect(r.mem.M[1]).toBe(0);
    expect(bytes(r.mem.M, 10, 4)).toEqual([0xee, 0xee, 0xee, 0xee]);
  });
});

describe('DIS_AIRT, EN_AIRT (SFC 41, 42)', () => {
  it('RET_VAL = ritardi attivi; EN_AIRT senza ritardi → 16#8080', () => {
    const p = compile(
      [100, 102].map((a) => `\tCALL SFC 41 (RET_VAL := MW ${a});`).join('\n') +
        '\n' +
        [104, 106, 108].map((a) => `\tCALL SFC 42 (RET_VAL := MW ${a});`).join('\n'),
    );
    const { cpu } = makeCpu(p);
    cpu.run();
    cpu.cycle();
    expect([100, 102, 104, 106, 108].map((a) => word(cpu.memory, a))).toEqual([1, 2, 1, 0, 0x8080]);
    // I ritardi finiscono con l'OB: il ciclo dopo si riparte da 1.
    cpu.cycle();
    expect(word(cpu.memory, 100)).toBe(1);
  });

  const nops = '\tNOP 0;\n'.repeat(1100);
  // OB35 conta in MW 20; a fine OB1 MW 22 = esecuzioni di OB35 avvenute dentro l'OB1.
  const withOb35 = (body: string) =>
    buildProgram(
      [
        ob1(`${body}\n\tCALL SFC 47 (WT := 20000);\n${nops}\tL MW 20;\n\tT MW 22;`),
        { kind: 'OB', number: 35, networks: ['\tL MW 20;\n\tL 1;\n\t+I;\n\tT MW 20;'] },
      ],
      {},
      SFCS,
    );

  it('dopo DIS_AIRT l’OB35 scaduto aspetta la fine dell’OB1 (non si perde)', () => {
    const { cpu } = makeCpu(withOb35('\tCALL SFC 41 (RET_VAL := MW 100);'), {
      cyclicInterruptMs: 10,
    });
    cpu.run();
    cpu.cycle();
    expect(word(cpu.memory, 22)).toBe(0);
    cpu.cycle();
    expect(word(cpu.memory, 20)).toBe(1);
  });

  it('con DIS_AIRT ed EN_AIRT l’OB35 interrompe l’OB1 al tick', () => {
    const { cpu } = makeCpu(
      withOb35('\tCALL SFC 41 (RET_VAL := MW 100);\n\tCALL SFC 42 (RET_VAL := MW 102);'),
      { cyclicInterruptMs: 10 },
    );
    cpu.run();
    cpu.cycle();
    expect(word(cpu.memory, 22)).toBe(1);
  });

  // System Software for S7-300/400, SFC 41 «DIS_AIRT»: ritarda gli OB di allarme e gli OB di
  // errore asincrono di priorità più alta; gli eventi aspettano la fine del ritardo, non si perdono.
  // OB1: 180 ms di WAIT (oltre i 150 del tempo di ciclo); OB80 conta in MW 30, MW 32 = MW 30 a fine OB1.
  const withOb80 = (body: string) =>
    buildProgram(
      [
        ob1(
          `${body}\n\tL 6;\nx: T MW 50;\n\tCALL SFC 47 (WT := 30000);\n\tL MW 50;\n\tLOOP x;\n${nops}\tL MW 30;\n\tT MW 32;`,
        ),
        { kind: 'OB', number: 80, networks: ['\tL MW 30;\n\tL 1;\n\t+I;\n\tT MW 30;'] },
      ],
      {},
      SFCS,
    );

  it('senza DIS_AIRT l’OB80 del tempo di ciclo interrompe l’OB1', () => {
    const { cpu } = makeCpu(withOb80(''));
    cpu.run();
    expect(cpu.cycle().ok).toBe(true);
    expect(word(cpu.memory, 32)).toBe(1);
  });

  it('dopo DIS_AIRT l’OB80 del tempo di ciclo aspetta la fine dell’OB1 (non si perde)', () => {
    const { cpu } = makeCpu(withOb80('\tCALL SFC 41 (RET_VAL := MW 100);'));
    cpu.run();
    expect(cpu.cycle().ok).toBe(true);
    expect(word(cpu.memory, 32)).toBe(0);
    expect(cpu.mode).toBe('RUN');
    cpu.cycle();
    expect(word(cpu.memory, 32)).toBe(1);
  });
});

describe('RE_TRIGR (SFC 43)', () => {
  // 4 × 30 ms di WAIT = 120 ms, sotto i 150 ms del tempo di ciclo massimo.
  const wait120 = '\tL 4;\nx: T MW 50;\n\tCALL SFC 47 (WT := 30000);\n\tL MW 50;\n\tLOOP x;';
  const wait120b = wait120.replaceAll('x', 'y');

  it('riavvia il controllo del tempo di ciclo: 240 ms senza STOP', () => {
    const { cpu } = makeCpu(compile(wait120, '\tCALL SFC 43;', wait120b));
    cpu.run();
    const r = cpu.cycle();
    expect(r.ok).toBe(true);
    expect(r.elapsedMs).toBe(240);
    expect(cpu.mode).toBe('RUN');
  });

  it('senza RE_TRIGR gli stessi 240 ms portano in STOP', () => {
    const { cpu } = makeCpu(compile(wait120, wait120b));
    cpu.run();
    expect(cpu.cycle().ok).toBe(false);
    expect(cpu.mode).toBe('STOP');
  });
});
