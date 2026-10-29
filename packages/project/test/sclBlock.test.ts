import { readBlockFile } from '@baaportal/mc7';
import { SimCpu } from '@baaportal/sim';
import { describe, expect, it } from 'vitest';
import {
  blockSources,
  blockToMc7File,
  createCodeBlock,
  createGlobalDb,
  createInstanceDb,
  createProject,
  kopSources,
  readBaap,
  writeBaap,
  type CodeBlock,
  type PlcDevice,
} from '../src/index';
import { cpu315pn, makeDevice, now, seq } from './fixtures';

const member = (name: string, type: string) => ({ id: `m-${name}`, name, type, comment: '' });

function sclFc(dev: PlcDevice, text: string): CodeBlock {
  const b = createCodeBlock({ kind: 'FC', number: 30, name: 'S30', language: 'SCL' });
  b.interface.input.push(member('a', 'Int'), member('b', 'Int'));
  b.interface.output.push(member('x', 'Bool'));
  b.networks[0]!.source = text;
  dev.blocks.push(b);
  return b;
}

describe('blocchi SCL compilati in AWL', () => {
  it('un FC SCL compila senza diagnostiche; blockSources è l AWL generato; byte di linguaggio 0x04', () => {
    const dev = makeDevice(seq('s'));
    const b = sclFc(dev, '#x := #a > #b;');
    expect(kopSources(b, dev)[0]!.scl!.diagnostics).toEqual([]);
    expect(blockSources(b, dev)[0]).toMatch(/\S/);
    expect(blockSources(b, dev)[0]).not.toContain(':=');
    const r = blockToMc7File(b, dev, cpu315pn, now);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(readBlockFile(r.file!).header.language).toBe(0x04);
  });

  it('un operando sconosciuto è un errore di compilazione col messaggio SCL e la riga', () => {
    const dev = makeDevice(seq('s'));
    const b = sclFc(dev, '#x := #a > #b;\n#x := #nonesiste > #b;');
    const sc = kopSources(b, dev)[0]!.scl!;
    expect(sc.source).toBe('');
    const r = blockToMc7File(b, dev, cpu315pn, now);
    expect(r.file).toBeUndefined();
    const d = r.diagnostics.find((x) => x.severity === 'error')!;
    expect(d.code).toBe('SCL_ERRORE');
    expect(d.network).toBe(1);
    expect(d.line).toBe(2);
    expect(d.message).toBe(sc.diagnostics[0]!.message);
  });

  it('un .baap con un blocco SCL si salva, si rilegge e si compila', () => {
    const dev = makeDevice(seq('s'));
    const b = sclFc(dev, '#x := #a > #b;');
    const p = createProject({ name: 'X', author: '', comment: '' }, now);
    p.devices.push(dev);
    const back = readBaap(writeBaap(p, { appVersion: '1.0.0' }));
    const d2 = back.devices[0]!;
    const b2 = d2.blocks.find((x) => x.id === b.id) as CodeBlock;
    expect(b2.language).toBe('SCL');
    expect(b2.networks[0]!.source).toBe('#x := #a > #b;');
    const r = blockToMc7File(b2, d2, cpu315pn, now);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.file).toBeTruthy();
  });
});

describe('SCL: BYTE calcolati e restituiti passano a parametri BYTE', () => {
  it('FC con ingresso e ritorno BYTE nel simulatore', () => {
    const dev = makeDevice(seq('b'));
    dev.blocks.length = 0;
    const f = createCodeBlock({ kind: 'FC', number: 32, name: 'FByte', language: 'SCL' });
    f.interface.input.push(member('B', 'Byte'), member('X', 'Bool'));
    f.interface.returnType = 'Byte';
    f.networks[0]!.source = 'FByte := B OR 1;';
    const ob = createCodeBlock({ kind: 'OB', number: 1, name: 'Main', language: 'SCL' });
    ob.networks[0]!.source = [
      'MB0 := "FByte"(B := MB10 AND 16#0F, X := TRUE);',
      'MB1 := "FByte"(B := NOT MB0, X := TRUE);',
      'M2.0 := "FByte"(B := MB0, X := TRUE) = 16#07;',
    ].join('\n');
    dev.blocks.push(f, ob);
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
    for (const b of dev.blocks) {
      const r = blockToMc7File(b, dev, cpu315pn, now);
      expect(
        r.diagnostics.filter((d) => d.severity === 'error'),
        b.name,
      ).toEqual([]);
      cpu.loadBlock(r.file!);
    }
    cpu.memory.M[10] = 0xa6;
    cpu.run();
    expect(cpu.cycle().ok).toBe(true);
    expect([cpu.memory.M[0], cpu.memory.M[1]]).toEqual([0x07, 0xf9]);
    expect(cpu.memory.M[2]! & 1).toBe(1);
  });
});

describe('SCL 1.1 nel simulatore: chiamate, valore di ritorno, ARRAY e STRUCT', () => {
  const struct = (name: string, members: ReturnType<typeof member>[]) => ({
    ...member(name, 'Struct'),
    members,
  });
  const scl = (kind: 'OB' | 'FB' | 'FC', number: number, name: string, text: string) => {
    const b = createCodeBlock({ kind, number, name, language: 'SCL' });
    b.networks[0]!.source = text;
    return b;
  };

  /** OB1 SCL che chiama una FC SCL col valore di ritorno, un FB col DB e un FB con multi-istanza. */
  function program(): PlcDevice {
    const dev = makeDevice(seq('c'));
    dev.blocks.length = 0;
    const somma = scl('FC', 31, 'Somma', 'Somma := p + q;\nbig := RET_VAL > 100;');
    somma.interface.input.push(member('p', 'Int'), member('q', 'Int'));
    somma.interface.output.push(member('big', 'Bool'));
    somma.interface.returnType = 'Int';
    const conta = scl(
      'FB',
      40,
      'Conta',
      'IF on THEN n := n + inc; END_IF;\ntot := n;\narr[2] := n * 2;\nst.f := TRUE;',
    );
    conta.interface.input.push(member('inc', 'Int'), member('on', 'Bool'));
    conta.interface.output.push(member('tot', 'Int'));
    conta.interface.static.push(
      member('n', 'Int'),
      member('arr', 'Array[1..3] of Int'),
      struct('st', [member('e', 'Int'), member('f', 'Bool')]),
    );
    const esterno = scl(
      'FB',
      41,
      'Esterno',
      '#c(inc := 5, on := pre <> 1);\nMW40 := c.tot;\nMW42 := c.arr[2];',
    );
    esterno.interface.static.push(member('pre', 'Int'), member('c', '"Conta"'));
    const dati = createGlobalDb({ number: 50, name: 'Dati' });
    dati.members.push(
      { ...member('v', 'Array[0..3] of Int'), initial: '' },
      { ...struct('s', [member('a', 'Int'), member('b', 'Real')]), initial: '' },
    );
    const ob = scl(
      'OB',
      1,
      'Main',
      [
        'MW0 := "Somma"(p := MW10, q := 7, big => M2.0);',
        'MW4 := Somma(p := 1, q := "Somma"(p := 2, q := 3, big => M2.1), big => M2.2) * 2;',
        '"Conta_DB"(inc := 3, on := M2.0 AND NOT M2.1, tot => MW20);',
        '"Conta_DB"(inc := 4, on := TRUE);',
        '"Conta_DB"(inc := 100, on := FALSE);',
        'MW22 := "Conta_DB".tot;',
        'MW24 := "Conta_DB".arr[2];',
        'M26.0 := "Conta_DB".st.f;',
        '"Dati".v[3] := 11;',
        '"Dati".s.a := "Dati".v[3] + 1;',
        'MW28 := "Dati".s.a;',
        '"Esterno_DB"();',
      ].join('\n'),
    );
    dev.blocks.push(
      somma,
      conta,
      esterno,
      dati,
      createInstanceDb({ number: 42, name: 'Conta_DB', instanceOf: 'Conta' }),
      createInstanceDb({ number: 43, name: 'Esterno_DB', instanceOf: 'Esterno' }),
      ob,
    );
    return dev;
  }

  it('i valori calcolati sono quelli attesi', () => {
    const dev = program();
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
    for (const b of dev.blocks) {
      const r = blockToMc7File(b, dev, cpu315pn, now);
      expect(
        r.diagnostics.filter((d) => d.severity === 'error'),
        b.name,
      ).toEqual([]);
      cpu.loadBlock(r.file!);
    }
    const mw = (at: number) => new DataView(cpu.memory.M.buffer).getInt16(at);
    cpu.memory.M[10] = 0;
    cpu.memory.M[11] = 100;
    cpu.run();
    expect(cpu.cycle().ok).toBe(true);
    expect(mw(0)).toBe(107);
    expect(cpu.memory.M[2]! & 0b111).toBe(0b001);
    expect(mw(4)).toBe(12);
    expect([mw(20), mw(22), mw(24)]).toEqual([3, 7, 14]);
    expect(cpu.memory.M[26]! & 1).toBe(1);
    expect(mw(28)).toBe(12);
    expect([mw(40), mw(42)]).toEqual([5, 10]);
    cpu.cycle();
    expect([mw(20), mw(22), mw(40), mw(42)]).toEqual([10, 14, 10, 20]);
  });
});

describe('SCL 1.3 nel simulatore: indici variabili negli ARRAY', () => {
  const scl = (kind: 'OB' | 'FB' | 'FC', number: number, name: string, text: string[]) => {
    const b = createCodeBlock({ kind, number, name, language: 'SCL' });
    b.networks[0]!.source = text.join('\n');
    return b;
  };

  /** FB con ARRAY in IN, OUT e STAT; un FB con due multi-istanze; OB1 con TEMP e un DB globale. */
  function program(): PlcDevice {
    const dev = makeDevice(seq('v'));
    dev.blocks.length = 0;
    const vet = scl('FB', 60, 'Vet', [
      'FOR i := 1 TO 10 DO a[i] := i * 2 + n; END_FOR;',
      'sum := 0;',
      'FOR i := 1 TO 10 DO sum := sum + INT_TO_DINT(a[i]); END_FOR;',
      'FOR i := 1 TO 3 DO FOR j := 0 TO 2 DO m[i, j] := INT_TO_DINT(i * 10 + j + n); END_FOR; END_FOR;',
      'FOR i := 0 TO 15 DO b[i] := i >= n; END_FOR;',
      'r[1] := INT_TO_REAL(n); FOR i := 2 TO 4 DO r[i] := r[i - 1] * 2.0; END_FOR;',
      'FOR i := 1 TO 3 DO oa[i] := ia[4 - i] + n; END_FOR;',
    ]);
    vet.interface.input.push(member('n', 'Int'), member('ia', 'Array[1..3] of Int'));
    vet.interface.output.push(member('sum', 'DInt'), member('oa', 'Array[1..3] of Int'));
    vet.interface.static.push(
      member('a', 'Array[1..10] of Int'),
      member('m', 'Array[1..3, 0..2] of DInt'),
      member('b', 'Array[0..15] of Bool'),
      member('r', 'Array[1..4] of Real'),
      member('i', 'Int'),
      member('j', 'Int'),
    );
    const due = scl('FB', 61, 'Due', [
      '#v1(n := 1);',
      '#v2(n := 3);',
      'MD60 := v1.sum;',
      'MD64 := v2.sum;',
      'MD68 := v2.m[MW100, MW102];',
      'M72.0 := v1.b[MW104];',
      'M72.1 := v2.b[MW104];',
    ]);
    due.interface.static.push(member('pre', 'Int'), member('v1', '"Vet"'), member('v2', '"Vet"'));
    const dati = createGlobalDb({ number: 70, name: 'Dati' });
    dati.members.push(
      { ...member('v', 'Array[0..3] of Int'), initial: '' },
      { ...member('w', 'Int'), initial: '' },
    );
    const ob = scl('OB', 1, 'Main', [
      'FOR MW90 := 1 TO 3 DO "Vet_DB".ia[MW90] := MW90 * 100; END_FOR;',
      '"Vet_DB"(n := 5);',
      'MD0 := "Vet_DB".sum;',
      'MW4 := "Vet_DB".a[MW80];',
      'MW6 := "Vet_DB".oa[MW82];',
      'MD8 := "Vet_DB".r[MW84];',
      '"Due_DB"();',
      'FOR k := 0 TO 3 DO "Dati".v[k] := k * 3; END_FOR;',
      'MW12 := "Dati".v[MW86];',
      '"Dati".v[MW88] := 99;',
      'MW14 := "Dati".w;',
      'FOR k := 1 TO 5 DO t[k] := INT_TO_REAL(k) / 2.0; END_FOR;',
      'MD16 := t[MW80];',
    ]);
    ob.interface.temp.push(member('t', 'Array[1..5] of Real'), member('k', 'Int'));
    dev.blocks.push(
      vet,
      due,
      dati,
      createInstanceDb({ number: 60, name: 'Vet_DB', instanceOf: 'Vet' }),
      createInstanceDb({ number: 61, name: 'Due_DB', instanceOf: 'Due' }),
      ob,
    );
    return dev;
  }

  it('FB singolo e due multi-istanze, IN/OUT/STAT, TEMP, DB globale, indice fuori dai limiti', () => {
    const dev = program();
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
    for (const b of dev.blocks) {
      const r = blockToMc7File(b, dev, cpu315pn, now);
      expect(
        r.diagnostics.filter((d) => d.severity === 'error'),
        b.name,
      ).toEqual([]);
      cpu.loadBlock(r.file!);
    }
    const v = new DataView(cpu.memory.M.buffer);
    cpu.run();
    for (const [at, val] of [
      [80, 3],
      [82, 1],
      [84, 4],
      [86, 2],
      [88, 4],
      [100, 2],
      [102, 1],
      [104, 2],
    ] as const)
      v.setInt16(at, val);
    expect(cpu.cycle().ok).toBe(true);
    // FB con DB: somma di 2i + 5, a[3], oa[1] = ia[3] + 5, r[4] = 5 · 8
    expect([v.getInt32(0), v.getInt16(4), v.getInt16(6), v.getFloat32(8)]).toEqual([
      160, 11, 305, 40,
    ]);
    // multi-istanze con n = 1 e n = 3: ognuna scrive nei suoi dati (AR2 + indice)
    expect([v.getInt32(60), v.getInt32(64), v.getInt32(68)]).toEqual([120, 140, 24]);
    expect(cpu.memory.M[72]! & 3).toBe(0b01);
    // DB globale; la scrittura in v[4] (fuori da 0..3) si salta e non tocca w
    expect([v.getInt16(12), v.getInt16(14)]).toEqual([6, 0]);
    expect(v.getFloat32(16)).toBe(1.5);
  });
});
