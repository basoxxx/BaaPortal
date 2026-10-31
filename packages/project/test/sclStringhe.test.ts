// SCL 2.1 nel simulatore, compilato come i blocchi veri: funzioni STRING e confronti `<`/`>` sui
// dati d'istanza di un FB (`[AR2,P#…]`), su un DB globale e sui TEMP dell'OB. I casi limite delle
// funzioni sono in `scl/test/scl21str.test.ts`.
import { SimCpu } from '@baaportal/sim';
import { describe, expect, it } from 'vitest';
import {
  blockToMc7File,
  createCodeBlock,
  createGlobalDb,
  createInstanceDb,
  type PlcDevice,
} from '../src/index';
import { cpu315pn, makeDevice, now, seq } from './fixtures';

const member = (name: string, type: string) => ({ id: `m-${name}`, name, type, comment: '' });
const scl = (kind: 'OB' | 'FB', number: number, name: string, text: string[]) => {
  const b = createCodeBlock({ kind, number, name, language: 'SCL' });
  b.networks[0]!.source = text.join('\n');
  return b;
};

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

describe('SCL 2.1: funzioni STRING e DATE_AND_TIME nei blocchi compilati', () => {
  it('FB, DB globale e TEMP', () => {
    const dev = makeDevice(seq('s'));
    dev.blocks.length = 0;
    const fb = scl('FB', 60, 'Testi', [
      "s := 'Pompa';",
      "t := CONCAT(s, ' 12');",
      "MW0 := FIND(t, '12');",
      'u := RIGHT(t, 2);',
      "M2.0 := u = '12';",
      'M2.1 := s < t;',
      "s := REPLACE(s, 'i', 1, 5);",
      "M2.2 := s = 'Pompi';",
      '"Dati".s1 := INSERT(s, "Dati".s2, 0);',
      'MW4 := LEN("Dati".s1);',
      'M2.3 := "Dati".s1 > s;',
      'u := MID("Dati".s1, 3, 2);',
      "M2.4 := u = 'bPo';",
      'tmp := DELETE("Dati".s1, 2, 1);',
      "M2.5 := tmp = 'Pompi' AND tmp >= 'Pompi' AND NOT (tmp > 'Pompi');",
      "u := CONCAT(s, 'xyz');",
      'MW6 := LEN(u);',
      'dt0 := dIn;',
      'M2.6 := dt0 = DT#2024-03-15-12:00:00 AND dt0 > DT#1999-12-31-23:59:59.999;',
    ]);
    fb.interface.input.push(member('dIn', 'Date_And_Time'));
    fb.interface.static.push(
      member('s', 'String[10]'),
      member('t', 'String[10]'),
      member('u', 'String[4]'),
      member('dt0', 'Date_And_Time'),
    );
    fb.interface.temp.push(member('tmp', 'String[8]'));
    const dati = createGlobalDb({ number: 61, name: 'Dati' });
    dati.members.push(
      { ...member('s1', 'String[10]'), initial: '' },
      { ...member('s2', 'String[5]'), initial: "'ab'" },
    );
    const ob = scl('OB', 1, 'Main', ['"Testi_DB"(dIn := DT#2024-03-15-12:00:00);']);
    dev.blocks.push(
      fb,
      dati,
      createInstanceDb({ number: 60, name: 'Testi_DB', instanceOf: 'Testi' }),
      ob,
    );
    const v = cycle(dev);
    expect(v.getInt16(0)).toBe(7);
    expect(v.getUint8(2) & 0x7f).toBe(0x7f);
    expect([v.getInt16(4), v.getInt16(6)]).toEqual([7, 4]);
  });
});
