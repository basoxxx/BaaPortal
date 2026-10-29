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
