import { describe, expect, it } from 'vitest';
import {
  assignmentList,
  blockSizes,
  callGraph,
  createCodeBlock,
  crossReferences,
  programResources,
} from '../src/index';
import { cpu315pn, makeDevice } from './fixtures';

function fixture() {
  const dev = makeDevice();
  dev.blocks.length = 0;
  dev.tagTables[0]!.tags.push(
    { id: 'm', name: 'Motore', type: 'Bool', address: '%Q4.1', hmi: false, comment: '' },
    { id: 'l', name: 'Livello', type: 'Int', address: '%MW10', hmi: false, comment: '' },
  );
  const ob = createCodeBlock({ kind: 'OB', number: 1, name: 'Main', language: 'AWL' });
  ob.networks[0]!.source = 'A I 0.0\n= Q 4.0\nS M 10.3\nL MW 10\nT MB 11\nSD T 5\nCALL FC 2';
  const fc1 = createCodeBlock({ kind: 'FC', number: 1, name: 'Uno', language: 'AWL' });
  fc1.interface.temp.push({ id: 't1', name: 'a', type: 'Int', comment: '' });
  fc1.interface.temp.push({ id: 't2', name: 'b', type: 'DInt', comment: '' });
  fc1.networks[0]!.source = 'A M 100.0\n= Q 8.0';
  const fc2 = createCodeBlock({ kind: 'FC', number: 2, name: 'Due', language: 'AWL' });
  fc2.networks[0]!.source = 'CALL FC 1';
  const bad = createCodeBlock({ kind: 'FC', number: 3, name: 'Rotto', language: 'AWL' });
  bad.networks[0]!.source = 'QUESTO NON COMPILA';
  dev.blocks.push(ob, fc1, fc2, bad);
  return dev;
}

describe('Elenco di assegnazione', () => {
  const dev = fixture();
  const lists = assignmentList(dev, crossReferences(dev), cpu315pn.limits);
  const area = (a: string) => lists.find((l) => l.area === a)!;

  it('bit usati con accesso, tag e sovrapposizioni', () => {
    const q = area('Q');
    expect(q.rows.map((r) => r.byte)).toEqual([4, 8]);
    expect(q.rows[0]!.cells[0]!.access).toBe('write');
    // %Q4.1 ha un tag ma il programma non lo usa
    expect(q.rows[0]!.cells[1]).toMatchObject({ tags: ['Motore'], keys: [] });
    const m = area('M');
    const b10 = m.rows.find((r) => r.byte === 10)!;
    expect(b10.cells[3]).toMatchObject({ access: 'readWrite', overlap: true });
    expect(b10.sizes.W).toBe('read');
    expect(m.rows.find((r) => r.byte === 11)!.sizes).toMatchObject({ B: 'write', W: 'read' });
    expect(m.used).toBe(3); // MB10, MB11, MB100
    expect(area('T').rows[0]!.cells[5]!.access).toBe('write');
    expect(area('T').used).toBe(1);
  });

  it('segna ciò che supera i limiti della CPU', () => {
    const l = assignmentList(dev, crossReferences(dev), { ...cpu315pn.limits, mBytes: 11 });
    const m = l.find((x) => x.area === 'M')!;
    expect(m.rows.map((r) => [r.byte, r.beyondLimit])).toEqual([
      [10, false],
      [11, true],
      [100, true],
    ]);
  });
});

describe('Risorse', () => {
  it('dimensioni, dati locali lungo i percorsi e blocchi da compilare', () => {
    const dev = fixture();
    const xref = crossReferences(dev);
    const sizes = blockSizes(dev, cpu315pn);
    const id = (n: string) => dev.blocks.find((b) => b.name === n)!.id;
    expect(sizes.has(id('Rotto'))).toBe(false);
    expect(sizes.get(id('Uno'))!.local).toBeGreaterThanOrEqual(6);
    const graph = callGraph(dev, xref);
    const assign = assignmentList(dev, xref, cpu315pn.limits);
    const r = programResources(dev, cpu315pn, sizes, graph, assign);
    expect(r.uncompiled).toBe(1);
    expect(r.blocks.find((b) => b.key === 'FC3')!.size).toBeUndefined();
    expect(r.total.load).toBeGreaterThan(0);
    const ob = r.obPaths[0]!;
    expect(ob.path).toEqual(['OB1', 'FC2', 'FC1']);
    const sum = ['Main', 'Due', 'Uno'].reduce((a, n) => a + sizes.get(id(n))!.local, 0);
    expect(ob.bytes).toBe(sum);
    expect(ob.overLimit).toBe(false);
    const small = { ...cpu315pn, limits: { ...cpu315pn.limits, localDataBytesPerClass: 10 } };
    expect(programResources(dev, small, sizes, graph, assign).obPaths[0]!.overLimit).toBe(true);
  });
});
