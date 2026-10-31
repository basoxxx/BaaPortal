// SCL 2.1 nel simulatore, compilato come i blocchi veri: indici variabili anche prima di un membro
// (`#a[#i].x`, `#a[#i].v[#j]`) nei TEMP, nei dati d'istanza e in un DB globale, come uscita e
// ingresso/uscita di una chiamata, con la variabile del FOR come indice.
import { SimCpu } from '@baaportal/sim';
import { describe, expect, it } from 'vitest';
import {
  blockToMc7File,
  createCodeBlock,
  createGlobalDb,
  createInstanceDb,
  createUdt,
  type PlcDevice,
} from '../src/index';
import { cpu315pn, makeDevice, now, seq } from './fixtures';

const member = (name: string, type: string) => ({ id: `m-${name}`, name, type, comment: '' });
const scl = (kind: 'OB' | 'FB' | 'FC', number: number, name: string, text: string[]) => {
  const b = createCodeBlock({ kind, number, name, language: 'SCL' });
  b.networks[0]!.source = text.join('\n');
  return b;
};

function cycle(dev: PlcDevice, setup: (v: DataView) => void): DataView {
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
  const v = new DataView(cpu.memory.M.buffer);
  cpu.run();
  setup(v);
  expect(cpu.cycle().ok).toBe(true);
  return v;
}

describe('SCL 2.1: indici variabili prima di un membro e nelle chiamate', () => {
  it('TEMP, dati d istanza, DB globale, uscita e IN_OUT di una FC', () => {
    const dev = makeDevice(seq('x'));
    dev.blocks.length = 0;
    const punto = createUdt({ name: 'Punto', number: 1 });
    punto.members.push(member('x', 'Int'), member('v', 'Array[0..2] of Int'), member('f', 'Bool'));
    dev.udts.push(punto);
    const piu1 = scl('FC', 10, 'Piu1', ['R := A + 1;']);
    piu1.interface.input.push(member('A', 'Int'));
    piu1.interface.output.push(member('R', 'Int'));
    const doppio = scl('FC', 11, 'Doppio', ['io := io * 2;']);
    doppio.interface.inOut.push(member('io', 'Int'));
    const fb = scl('FB', 12, 'Vet', [
      'p[n].v[n + 1] := 77;',
      'MW30 := p[1].v[2];',
      'MW32 := p[n].x;',
    ]);
    fb.interface.input.push(member('n', 'Int'));
    fb.interface.static.push(member('p', 'Array[0..1] of "Punto"'));
    const dati = createGlobalDb({ number: 13, name: 'Dati' });
    dati.members.push({ ...member('q', 'Array[1..3] of "Punto"'), initial: '' });
    const ob = scl('OB', 1, 'Main', [
      'FOR i := 1 TO 3 DO',
      '  a[i].x := i * 10;',
      '  FOR j := 0 TO 2 DO a[i].v[j] := i * 100 + j; END_FOR;',
      '  a[i].f := i = 2;',
      'END_FOR;',
      'MW0 := a[MW20].x;',
      'MW2 := a[MW20].v[MW22];',
      'M4.0 := a[MW20].f;',
      'M4.1 := a[MW24].f;',
      '"Piu1"(A := 7, R => a[MW20].v[2]);',
      'MW6 := a[2].v[2];',
      '"Doppio"(io := a[MW20].x);',
      'MW8 := a[2].x;',
      'a[MW26].v[0] := 5;',
      'MW10 := a[3].v[0];',
      '"Vet_DB"(n := 1);',
      '"Dati".q[MW20].v[MW22] := 55;',
      'MW12 := "Dati".q[2].v[1];',
      '"Piu1"(A := 41, R => "Dati".q[MW24].v[MW22]);',
      'MW14 := "Dati".q[3].v[1];',
    ]);
    ob.interface.temp.push(
      member('a', 'Array[1..3] of "Punto"'),
      member('i', 'Int'),
      member('j', 'Int'),
    );
    dev.blocks.push(
      piu1,
      doppio,
      fb,
      dati,
      createInstanceDb({ number: 12, name: 'Vet_DB', instanceOf: 'Vet' }),
      ob,
    );
    const v = cycle(dev, (d) => {
      d.setInt16(20, 2);
      d.setInt16(22, 1);
      d.setInt16(24, 3);
      d.setInt16(26, 4); // fuori dai limiti: la scrittura si salta
    });
    expect([v.getInt16(0), v.getInt16(2), v.getUint8(4) & 3]).toEqual([20, 201, 1]);
    expect([v.getInt16(6), v.getInt16(8), v.getInt16(10)]).toEqual([8, 40, 300]);
    expect([v.getInt16(30), v.getInt16(32)]).toEqual([77, 0]);
    expect([v.getInt16(12), v.getInt16(14)]).toEqual([55, 42]);
  });
});
