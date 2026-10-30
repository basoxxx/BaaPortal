// Osservazione dei blocchi SCL nel simulatore: lo stato per riga dell'AWL generato diventa lo
// stato di ogni riga SCL (`sclLineStatus`), con i valori presi solo dall'istruzione che li porta.
import type { LineMapEntry } from '@baaportal/mc7';
import { SimCpu, type MonitorStep } from '@baaportal/sim';
import { sclLineStatus, type SclCell } from '@baaportal/scl';
import { describe, expect, it } from 'vitest';
import { blockToMc7File, createCodeBlock, kopSources } from '../src/index';
import { cpu315pn, makeDevice, now, seq } from './fixtures';

/** Compila un FC SCL, lo richiama da OB1, osserva un ciclo e dà lo stato per riga SCL. */
function run(text: string, mw: Record<number, number> = {}) {
  const dev = makeDevice(seq('s'));
  dev.blocks.length = 0;
  const fc = createCodeBlock({ kind: 'FC', number: 1, name: 'S', language: 'SCL' });
  fc.networks[0]!.source = text;
  dev.blocks.push(fc);
  const ob = createCodeBlock({ kind: 'OB', number: 1, name: 'Main', language: 'AWL' });
  ob.networks[0]!.source = '\tCALL FC 1;';
  dev.blocks.push(ob);
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
  let map: LineMapEntry[] = [];
  for (const b of dev.blocks) {
    const r = blockToMc7File(b, dev, cpu315pn, now);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    if (b === fc) map = r.lines!;
    cpu.loadBlock(r.file!);
  }
  cpu.run();
  for (const [a, v] of Object.entries(mw)) {
    cpu.memory.M[Number(a)] = (v >> 8) & 0xff;
    cpu.memory.M[Number(a) + 1] = v & 0xff;
  }
  // come la UI per un blocco SCL: l'ultima esecuzione nel ciclo
  cpu.setMonitor({ kind: 'FC', number: 1, last: true });
  expect(cpu.cycle().ok).toBe(true);
  const steps: MonitorStep[] = cpu.monitorSnapshot()!;
  // come `monitorLinesByNetwork` nella UI: l'ultima voce eseguita della riga, `null` se nessuna
  const by = new Map(steps.map((s) => [s.offset, s]));
  const cells = new Map<number, SclCell>();
  for (const e of map.filter((x) => x.network === 0).sort((a, b) => a.offset - b.offset)) {
    const s = by.get(e.offset);
    if (s) cells.set(e.line, s);
    else if (!cells.has(e.line)) cells.set(e.line, null);
  }
  return sclLineStatus(kopSources(fc, dev)[0]!.scl!.lines, cells);
}

const value = (st: ReturnType<typeof run>, line: number) =>
  st.get(line)!.values.map((v) => (v.ty === 'BOOL' ? v.cell?.rlo : v.cell?.accu1));

describe('sclLineStatus sul simulatore', () => {
  it('assegnazione, IF falso con ramo grigio, FOR, WHILE non eseguito', () => {
    const st = run(
      [
        'MW10 := MW0 + 1;',
        'IF MW0 > 10 THEN',
        '  MW12 := 1;',
        'END_IF;',
        'FOR MW20 := 1 TO 3 DO',
        '  MW14 := MW14 + MW20;',
        'END_FOR;',
        'WHILE MW0 > 100 DO',
        '  MW16 := 0;',
        'END_WHILE;',
        'M30.0 := MW0 = 5;',
      ].join('\n'),
      { 0: 5 },
    );
    expect(value(st, 1)).toEqual([6]);
    expect(st.get(2)!.state).toBe('run');
    // RLO del confronto, non della JCN (che lo rimette a 1)
    expect(value(st, 2)).toEqual([false]);
    expect(st.get(3)!.state).toBe('notRun');
    // la variabile al controllo che esce dal ciclo; il corpo con i valori dell'ultimo giro
    expect(value(st, 5)).toEqual([4]);
    expect(value(st, 6)).toEqual([6]);
    expect(value(st, 8)).toEqual([false]);
    expect(st.get(9)!.state).toBe('notRun');
    expect(value(st, 11)).toEqual([true]);
  });

  it('CASE: selettore e solo il ramo scelto', () => {
    const st = run(
      [
        'CASE MW0 OF',
        '  1: MW10 := 10;',
        '  2..4: MW10 := 20;',
        'ELSE',
        '  MW10 := 30;',
        'END_CASE;',
      ].join('\n'),
      { 0: 3 },
    );
    expect(value(st, 1)).toEqual([3]);
    expect(st.get(2)!.state).toBe('notRun');
    expect(value(st, 3)).toEqual([20]);
    expect(st.get(5)!.state).toBe('notRun');
  });
});
