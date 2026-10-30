import { describe, expect, it } from 'vitest';
import { findCpu } from '@baaportal/catalog';
import {
  createCodeBlock,
  createLibraryItem,
  createPlcDevice,
  createUdt,
  createWatchTable,
  type CodeBlock,
  type PlcDevice,
} from '@baaportal/project';
import {
  findConflicts,
  insertLibraryItem,
  type Resolution,
} from '../src/project/library/libraryInsert';

const cpu = findCpu('cpu-315-2-pn-dp')!;
let n = 0;
const newId = () => `x${++n}`;

function device(name: string): PlcDevice {
  return createPlcDevice({
    cpu,
    orderNumber: '6ES7 315-2EH14-0AB0',
    firmware: 'V3.3',
    name,
    texts: { defaultTagTable: 'Standard' },
    newId,
  });
}

/** Sorgente: FB1 «Motore» con uno statico di tipo UDT1 «Dati» che chiama FC1 «Calc». */
function source() {
  const d = device('SRC');
  const udt = createUdt({ name: 'Dati', number: 1, newId });
  udt.members.push({ id: newId(), name: 'V', type: 'Int', comment: '' });
  const fc = createCodeBlock({ kind: 'FC', number: 1, name: 'Calc', language: 'AWL', newId });
  const fb = createCodeBlock({ kind: 'FB', number: 1, name: 'Motore', language: 'AWL', newId });
  fb.interface.static.push({ id: newId(), name: 'D', type: '"Dati"', comment: '' });
  fb.networks[0]!.source = 'CALL "Calc"';
  d.udts.push(udt);
  d.blocks.push(fc, fb);
  const watch = createWatchTable('Controllo', newId);
  d.watchTables.push(watch);
  const item = createLibraryItem(
    d,
    [
      { kind: 'block', deviceId: d.id, id: fb.id },
      { kind: 'watchTable', deviceId: d.id, id: watch.id },
    ],
    { newId },
  )!;
  return item;
}

/** I blocchi del PLC tranne l'OB1 che ogni PLC nuovo ha, in ordine di nome. */
const blocks = (d: PlcDevice) =>
  d.blocks
    .filter((b) => b.name !== 'Main')
    .map((b) => `${b.kind}${b.number} ${b.name}`)
    .sort();
const block = (d: PlcDevice, name: string) => d.blocks.find((b) => b.name === name) as CodeBlock;
const insert = (d: PlcDevice, choices: Record<string, Resolution> = {}) => {
  const item = source();
  const byName = new Map(
    findConflicts(d, item)
      .map((c) => [c.id, choices[c.name]] as const)
      .filter(([, r]) => r),
  ) as Map<string, Resolution>;
  return insertLibraryItem(d, item, byName, cpu, newId);
};

describe('inserimento di un modello nel PLC', () => {
  it('senza scontri: FB, UDT, FC chiamato e tabella di controllo, con nomi e numeri originali', () => {
    const d = device('PLC');
    expect(findConflicts(d, source())).toEqual([]);
    const r = insert(d);
    expect(r).toMatchObject({ skipped: 0 });
    expect(r.created).toHaveLength(4);
    expect(blocks(d)).toEqual(['FB1 Motore', 'FC1 Calc']);
    expect(d.udts.map((u) => u.name)).toEqual(['Dati']);
    expect(d.watchTables.map((w) => w.name)).toEqual(['Controllo']);
  });

  it('solo il numero preso: si propone Rinumera e i riferimenti per nome restano', () => {
    const d = device('PLC');
    d.blocks.push(
      createCodeBlock({ kind: 'FC', number: 1, name: 'Altro', language: 'AWL', newId }),
    );
    const [c] = findConflicts(d, source());
    expect(c).toMatchObject({ name: 'Calc', label: 'FC1', nameTaken: false, numberTaken: true });
    expect(c!.options).toEqual(['rename', 'renumber', 'replace', 'skip']);
    insert(d);
    expect(block(d, 'Calc').number).toBe(2);
    expect(block(d, 'Motore').networks[0]!.source).toBe('CALL "Calc"');
    expect(block(d, 'Altro').number).toBe(1);
  });

  it('nome e numero presi: Salta usa quello del PLC, Rinomina aggiorna CALL e tipi, Sostituisci lo rimpiazza', () => {
    const existing = () => {
      const d = device('PLC');
      d.blocks.push(
        createCodeBlock({ kind: 'FC', number: 1, name: 'Calc', language: 'AWL', newId }),
      );
      const u = createUdt({ name: 'Dati', number: 1, newId });
      d.udts.push(u);
      return d;
    };
    const skipped = existing();
    const before = block(skipped, 'Calc').id;
    expect(findConflicts(skipped, source()).map((c) => c.options)).toEqual([
      ['rename', 'replace', 'skip'],
      ['rename', 'replace', 'skip'],
    ]);
    insert(skipped, { Calc: 'skip', Dati: 'skip' });
    expect(blocks(skipped)).toEqual(['FB1 Motore', 'FC1 Calc']);
    expect(block(skipped, 'Calc').id).toBe(before);

    const renamed = existing();
    insert(renamed, { Calc: 'rename', Dati: 'rename' });
    expect(block(renamed, 'Motore').networks[0]!.source).toBe('CALL "Calc_1"');
    expect(block(renamed, 'Motore').interface.static[0]!.type).toBe('"Dati_1"');
    expect(block(renamed, 'Calc_1').number).toBe(2);
    expect(renamed.udts.map((u) => `${u.number} ${u.name}`)).toEqual(['1 Dati', '2 Dati_1']);

    const replaced = existing();
    const old = block(replaced, 'Calc').id;
    insert(replaced, { Calc: 'replace', Dati: 'replace' });
    expect(blocks(replaced)).toEqual(['FB1 Motore', 'FC1 Calc']);
    expect(block(replaced, 'Calc').id).not.toBe(old);
    expect(replaced.udts).toHaveLength(1);
  });

  it('un nome preso da un tag non si sostituisce; la tabella di controllo si rinomina', () => {
    const d = device('PLC');
    d.tagTables[0]!.tags.push({
      id: newId(),
      name: 'Calc',
      type: 'Bool',
      address: '%M0.0',
      hmi: false,
      comment: '',
    });
    d.watchTables.push(createWatchTable('Controllo', newId));
    const cs = findConflicts(d, source());
    expect(cs.find((c) => c.name === 'Calc')!.options).toEqual(['rename', 'skip']);
    expect(cs.find((c) => c.name === 'Controllo')!.options).toEqual(['rename', 'replace', 'skip']);
    insert(d);
    expect(blocks(d)).toEqual(['FB1 Motore', 'FC1 Calc_1']);
    expect(d.watchTables.map((w) => w.name)).toEqual(['Controllo', 'Controllo_1']);
  });
});
