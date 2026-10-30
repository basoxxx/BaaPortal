// SCL 1.8 nel simulatore: TIME, S5TIME, DATE, TOD e CHAR nei TEMP e nei parametri, STRUCT, ARRAY,
// UDT e STRING interi (TEMP, DB globali e di istanza, dati d'istanza, multi-istanze, parametri di FB),
// chiamate per posizione. La forma dell'AWL e le diagnostiche sono in `scl/test/scl18.test.ts`.
import { SimCpu } from '@baaportal/sim';
import { describe, expect, it } from 'vitest';
import {
  blockToMc7File,
  createCodeBlock,
  createGlobalDb,
  createInstanceDb,
  createUdt,
  kopSources,
  type CodeBlock,
  type PlcDevice,
} from '../src/index';
import { cpu315pn, makeDevice, now, seq } from './fixtures';

const member = (name: string, type: string) => ({ id: `m-${name}`, name, type, comment: '' });
const scl = (kind: 'OB' | 'FB' | 'FC', number: number, name: string, text: string[]) => {
  const b = createCodeBlock({ kind, number, name, language: 'SCL' });
  b.networks[0]!.source = text.join('\n');
  return b;
};

/** Compila tutti i blocchi, esegue un ciclo e rende la memoria M. */
function cycle(dev: PlcDevice): DataView {
  const cpu = new SimCpu({
    cpuTypeId: 'cpu-315-2-pn-dp',
    props: {
      maxCycleMs: 1000,
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
  cpu.run();
  expect(cpu.cycle().ok).toBe(true);
  return new DataView(cpu.memory.M.buffer);
}

describe('SCL 1.8: TIME, DATE, TOD, S5TIME e CHAR nei TEMP e nei parametri, per posizione', () => {
  it('valori nel simulatore', () => {
    const dev = makeDevice(seq('t'));
    dev.blocks.length = 0;
    const doppio = scl('FC', 20, 'Doppio', ['Doppio := p + p;']);
    doppio.interface.input.push(member('p', 'Time'));
    doppio.interface.returnType = 'Time';
    const somma = scl('FC', 21, 'Somma', ['r := a + b;']);
    somma.interface.input.push(member('a', 'Int'), member('b', 'Int'));
    somma.interface.output.push(member('r', 'Int'));
    const piu = scl('FC', 22, 'Piu', ['Piu := a + b;']);
    piu.interface.input.push(member('a', 'Int'), member('b', 'Int'));
    piu.interface.returnType = 'Int';
    const ob = scl('OB', 1, 'Main', [
      't := T#1m30s + T#250ms;',
      'MD0 := TIME_TO_DINT(t);',
      't2 := t - T#2m;',
      'MD4 := TIME_TO_DINT(t2);',
      'M8.0 := t > T#1m;',
      'M8.1 := t2 < T#0ms;',
      's := S5T#2s;',
      'M8.2 := s = S5T#2s AND s <> S5T#3s;',
      'd := D#2100-01-01;',
      'M8.3 := d > D#2024-01-01;',
      'tod := TOD#12:30:00;',
      'M8.4 := tod >= TOD#12:00:00 AND tod < TOD#12:30:00.001;',
      "c := 'A';",
      'MW10 := CHAR_TO_INT(c);',
      "M8.5 := c < 'a';",
      'c2 := INT_TO_CHAR(MW10 + 1);',
      "M8.6 := c2 = 'B';",
      'MD12 := TIME_TO_DINT("Doppio"(p := T#1500ms));',
      'MD16 := TIME_TO_DINT(Doppio(t));',
      '"Somma"(MW10, 2, MW20);',
      'MW22 := Piu(MW20, 10) + Piu(a := 1, b := 1);',
    ]);
    ob.interface.temp.push(
      member('t', 'Time'),
      member('t2', 'Time'),
      member('s', 'S5Time'),
      member('d', 'Date'),
      member('tod', 'Time_Of_Day'),
      member('c', 'Char'),
      member('c2', 'Char'),
    );
    dev.blocks.push(doppio, somma, piu, ob);
    const v = cycle(dev);
    expect([v.getInt32(0), v.getInt32(4)]).toEqual([90250, -29750]);
    expect(v.getUint8(8) & 0x7f).toBe(0x7f);
    expect(v.getInt16(10)).toBe(65);
    expect([v.getInt32(12), v.getInt32(16)]).toEqual([3000, 180500]);
    expect([v.getInt16(20), v.getInt16(22)]).toEqual([67, 79]);
  });
});

describe('SCL 1.8: STRUCT, ARRAY, UDT e STRING interi', () => {
  /** FB con parametri UDT e STRING, statici copiati; un FB che lo usa in multi-istanza; OB1. */
  function program(): PlcDevice {
    const dev = makeDevice(seq('c'));
    dev.blocks.length = 0;
    const punto = createUdt({ name: 'Punto', number: 1 });
    punto.members.push(member('x', 'Int'), member('y', 'DInt'), member('f', 'Bool'));
    dev.udts.push(punto);
    const copia = scl('FB', 30, 'Copia', [
      'p2 := inP;',
      'outP := p1;',
      'arr2 := arr1;',
      'st2 := st1;',
      'buf := nome;',
      'tmp := buf;',
      "uguale := tmp = 'Abc' AND buf = nome AND buf <> 'Abd';",
      'n := LEN(buf);',
      'copiaNome := tmp;',
    ]);
    copia.interface.input.push(member('inP', '"Punto"'), member('nome', 'String[10]'));
    copia.interface.output.push(
      member('outP', '"Punto"'),
      member('uguale', 'Bool'),
      member('n', 'Int'),
      member('copiaNome', 'String[12]'),
    );
    copia.interface.static.push(
      member('p1', '"Punto"'),
      member('p2', '"Punto"'),
      member('arr1', 'Array[0..4] of DInt'),
      member('arr2', 'Array[0..4] of DInt'),
      {
        ...member('st1', 'Struct'),
        members: [member('a', 'Int'), member('b', 'Array[1..3] of Byte')],
      },
      {
        ...member('st2', 'Struct'),
        members: [member('a', 'Int'), member('b', 'Array[1..3] of Byte')],
      },
      member('buf', 'String[10]'),
    );
    copia.interface.temp.push(member('tmp', 'String[6]'));
    const esterno = scl('FB', 31, 'Esterno', [
      'pp.x := 21; pp.y := L#-5; pp.f := TRUE;',
      "#c(inP := pp, nome := 'Abc', outP => pq, copiaNome => nm);",
      'MW60 := c.p2.x;',
      'MD62 := c.p2.y;',
      'M66.0 := c.uguale;',
      'MW68 := LEN(nm);',
    ]);
    esterno.interface.static.push(
      member('pre', 'Int'),
      member('c', '"Copia"'),
      member('pp', '"Punto"'),
      member('pq', '"Punto"'),
      member('nm', 'String[3]'),
    );
    const dati = createGlobalDb({ number: 50, name: 'Dati' });
    dati.members.push(
      { ...member('p', '"Punto"'), initial: '' },
      { ...member('v', 'Array[0..9] of DInt'), initial: '' },
      { ...member('w', 'Array[0..9] of DInt'), initial: '' },
      { ...member('s1', 'String[10]'), initial: '' },
      { ...member('s2', 'String[5]'), initial: '' },
    );
    const ob = scl('OB', 1, 'Main', [
      '"Dati".p.x := 5; "Dati".p.y := L#70000; "Dati".p.f := TRUE;',
      '"Copia_DB".p1.x := 7; "Copia_DB".p1.y := L#-1;',
      '"Copia_DB".arr1[4] := L#123456; "Copia_DB".st1.b[3] := 16#AB;',
      '"Copia_DB"(inP := "Dati".p, nome := "Dati".s1, outP => q, copiaNome => "Dati".s2);',
      'MW0 := q.x; MD2 := q.y;',
      'MW6 := "Copia_DB".p2.x; MD8 := "Copia_DB".p2.y; M12.0 := "Copia_DB".p2.f;',
      'MD14 := "Copia_DB".arr2[4]; MB18 := "Copia_DB".st2.b[3];',
      'q2 := q; MW20 := q2.x;',
      '"Dati".v[3] := 33; "Dati".v[9] := -9;',
      'a := "Dati".v; "Dati".w := a; MD22 := "Dati".w[3]; MD26 := a[9];',
      '"Dati".s1 := \'HelloWorld\';',
      'MW30 := LEN("Dati".s1);',
      '"Dati".s2 := "Dati".s1;',
      'MW32 := LEN("Dati".s2);',
      'st := "Dati".s2;',
      "M34.0 := st = 'Hello';",
      "M34.1 := st <> 'Hellp';",
      'M34.2 := "Dati".s2 = st;',
      "M34.3 := '' = st;",
      'M34.4 := "Dati".s1 = "Dati".s2;',
      "st := '';",
      'MW36 := LEN(st);',
      'M34.5 := "Copia_DB".uguale;',
      'MW38 := "Copia_DB".n;',
      '"Esterno_DB"();',
    ]);
    ob.interface.temp.push(
      member('q', '"Punto"'),
      member('q2', '"Punto"'),
      member('a', 'Array[0..9] of DInt'),
      member('st', 'String[8]'),
    );
    dev.blocks.push(
      copia,
      esterno,
      dati,
      createInstanceDb({ number: 30, name: 'Copia_DB', instanceOf: 'Copia' }),
      createInstanceDb({ number: 31, name: 'Esterno_DB', instanceOf: 'Esterno' }),
      ob,
    );
    return dev;
  }

  it('valori nel simulatore', () => {
    const dev = program();
    const v = cycle(dev);
    // outP <- p1 (7, -1); p2 <- inP <- "Dati".p (5, 70000, TRUE)
    expect([v.getInt16(0), v.getInt32(2)]).toEqual([7, -1]);
    expect([v.getInt16(6), v.getInt32(8), v.getUint8(12) & 1]).toEqual([5, 70000, 1]);
    expect([v.getInt32(14), v.getUint8(18)]).toEqual([123456, 0xab]);
    expect(v.getInt16(20)).toBe(7);
    expect([v.getInt32(22), v.getInt32(26)]).toEqual([33, -9]);
    expect([v.getInt16(30), v.getInt16(32)]).toEqual([10, 5]);
    // M34.5 e MW38: nella chiamata di "Copia_DB" "Dati".s1 era ancora vuota (si scrive dopo)
    expect(v.getUint8(34) & 0x3f).toBe(0b000111);
    expect([v.getInt16(36), v.getInt16(38)]).toEqual([0, 0]);
    // multi-istanza: inP <- pp (21, -5), nome 'Abc' -> buf -> tmp -> copiaNome -> nm (3 caratteri)
    expect([v.getInt16(60), v.getInt32(62), v.getUint8(66) & 1]).toEqual([21, -5, 1]);
    expect(v.getInt16(68)).toBe(3);
  });

  it('le diagnostiche dei parametri complessi di FC e degli IN_OUT', () => {
    const dev = makeDevice(seq('d'));
    dev.blocks.length = 0;
    const f = scl('FC', 40, 'Fs', ['o := 1;']);
    f.interface.input.push(member('s', 'String[4]'));
    f.interface.output.push(member('o', 'Int'));
    const g = scl('FB', 41, 'Gio', ['x := 1;']);
    g.interface.inOut.push(member('io', 'Array[1..2] of Int'));
    g.interface.static.push(member('x', 'Int'));
    const ob = scl('OB', 1, 'Main', ['"Fs"(s := \'ab\', o => MW0);', '"Gio_DB"(io := a);']);
    ob.interface.temp.push(member('a', 'Array[1..2] of Int'));
    dev.blocks.push(f, g, createInstanceDb({ number: 41, name: 'Gio_DB', instanceOf: 'Gio' }), ob);
    const d = kopSources(ob as CodeBlock, dev)[0]!.scl!.diagnostics.map((x) => x.message);
    expect(d[0]).toContain('parametri complessi delle FC');
    expect(d[1]).toContain('IN_OUT');
  });
});
