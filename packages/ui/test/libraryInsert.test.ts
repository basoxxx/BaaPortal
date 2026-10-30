import { describe, expect, it } from 'vitest';
import { findCpu } from '@baaportal/catalog';
import {
  callGraph,
  compileDevice,
  convertBlockToGraphic,
  createCodeBlock,
  createGlobalDb,
  createInstanceDb,
  createLibraryItem,
  createPlcDevice,
  createUdt,
  createWatchTable,
  type CodeBlock,
  type PlcDevice,
  type TagTable,
} from '@baaportal/project';
import {
  defaultResolution,
  findConflicts,
  insertLibraryItem,
  skipCascade,
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

describe('inserimento: i riferimenti seguono rinomine e numeri nuovi', () => {
  /** FC3 «Calc» con `A "Start"` e la tabella «IO» con `Start` su I 1.0. */
  const tagItem = () => {
    const s = device('SRC');
    const table = { id: newId(), name: 'IO', group: '', constants: [], tags: [] } as TagTable;
    table.tags.push({
      id: newId(),
      name: 'Start',
      type: 'Bool',
      address: 'I 1.0',
      hmi: false,
      comment: '',
    });
    s.tagTables.push(table);
    const fc = createCodeBlock({ kind: 'FC', number: 3, name: 'Calc', language: 'AWL', newId });
    fc.networks[0]!.source = 'A "Start"\n= M 0.0';
    s.blocks.push(fc);
    const refs = [
      { kind: 'block' as const, deviceId: s.id, id: fc.id },
      { kind: 'tagTable' as const, deviceId: s.id, id: table.id },
    ];
    return createLibraryItem(s, refs, { newId })!;
  };
  const withStart = (type: string) => {
    const d = device('PLC');
    d.tagTables[0]!.tags.push({
      id: newId(),
      name: 'Start',
      type,
      address: 'I 0.0',
      hmi: false,
      comment: '',
    });
    return d;
  };

  it('un tag con il nome preso si rinomina e il codice del modello lo segue', () => {
    const d = withStart('Bool');
    const item = tagItem();
    const c = findConflicts(d, item).find((x) => x.name === 'Start')!;
    expect(c).toMatchObject({ kind: 'tag', options: ['rename', 'useExisting'] });
    expect(c.symbol).toEqual({ at: 'I 1.0', existing: 'I 0.0' });
    insertLibraryItem(d, item, new Map(), cpu, newId);
    const io = d.tagTables.find((t) => t.name === 'IO')!;
    expect(io.tags.map((t) => `${t.name} ${t.address}`)).toEqual(['Start_1 I 1.0']);
    expect(block(d, 'Calc').networks[0]!.source).toBe('A "Start_1"\n= M 0.0');
  });

  it('«usa la variabile del PLC»: il tag del modello non entra e il codice usa quello del PLC', () => {
    const d = withStart('Bool');
    const item = tagItem();
    const c = findConflicts(d, item).find((x) => x.name === 'Start')!;
    insertLibraryItem(d, item, new Map([[c.id, 'useExisting']]), cpu, newId);
    expect(d.tagTables.find((t) => t.name === 'IO')!.tags).toEqual([]);
    expect(block(d, 'Calc').networks[0]!.source).toBe('A "Start"\n= M 0.0');
  });

  it('con un tipo diverso «usa la variabile del PLC» non si offre', () => {
    const d = withStart('Int');
    const c = findConflicts(d, tagItem()).find((x) => x.name === 'Start')!;
    expect(c.options).toEqual(['rename']);
    // Anche se chiesta, la scelta non valida diventa una rinomina.
    insertLibraryItem(d, tagItem(), new Map([[c.id, 'useExisting']]), cpu, newId);
    expect(block(d, 'Calc').networks[0]!.source).toBe('A "Start_1"\n= M 0.0');
  });

  /** FB1 «Motore» che chiama FC1 «Calc» per numero; il PLC ha già FC1 «Other». */
  const absolute = (code: string) => {
    const s = device('SRC');
    const fc = createCodeBlock({ kind: 'FC', number: 1, name: 'Calc', language: 'AWL', newId });
    const fb = createCodeBlock({ kind: 'FB', number: 1, name: 'Motore', language: 'AWL', newId });
    fb.networks[0]!.source = code;
    s.blocks.push(fc, fb);
    const item = createLibraryItem(s, [{ kind: 'block', deviceId: s.id, id: fb.id }], { newId })!;
    const d = device('PLC');
    d.blocks.push(
      createCodeBlock({ kind: 'FC', number: 1, name: 'Other', language: 'AWL', newId }),
    );
    return { item, d };
  };

  it('Rinumera: le CALL scritte col numero seguono il blocco; il codice compila e chiama Calc', () => {
    const { item, d } = absolute('CALL FC 1');
    expect(item.blocks.map((b) => b.name).sort()).toEqual(['Calc', 'Motore']);
    insertLibraryItem(d, item, new Map(), cpu, newId);
    expect(block(d, 'Calc').number).toBe(2);
    expect(block(d, 'Motore').networks[0]!.source).toBe('CALL FC 2');
    const motore = block(d, 'Motore');
    const { results } = compileDevice(d, cpu, [motore.id]);
    expect(results[0]!.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    const graph = callGraph(d);
    const callees = graph.calls
      .get(`FB${motore.number}`)!
      .map((e) => graph.blocks.get(e.callee)?.name);
    expect(callees).toEqual(['Calc']);
  });

  it('Rinumera: CALL FB/DB, UC/CC, OPN, DBn.DBX, puntatori, KOP e SCL', () => {
    const s = device('SRC');
    const fc = createCodeBlock({ kind: 'FC', number: 1, name: 'Calc', language: 'AWL', newId });
    const fb = createCodeBlock({ kind: 'FB', number: 2, name: 'Asse', language: 'AWL', newId });
    const awl = createCodeBlock({ kind: 'FB', number: 1, name: 'Motore', language: 'AWL', newId });
    awl.networks[0]!.source = [
      'CALL FB 2, DB 5',
      'UC FC 1',
      'CC FC 1',
      'OPN DB 5',
      'A DB5.DBX 0.0',
      'L P#DB5.DBX0.0 BYTE 2',
      'CALL FC 7',
    ].join('\n');
    const kop = createCodeBlock({ kind: 'FC', number: 3, name: 'Kop', language: 'AWL', newId });
    kop.networks[0]!.source = 'CALL FC 1\nNOP 0';
    const scl = createCodeBlock({ kind: 'FC', number: 4, name: 'Scl', language: 'SCL', newId });
    scl.networks[0]!.source = 'FC1();\n#x := DB5.DW0;';
    const idb = createInstanceDb({ number: 5, name: 'AsseDB', instanceOf: 'Asse', newId });
    s.blocks.push(fc, fb, awl, kop, scl, idb);
    expect(convertBlockToGraphic(kop, s, 'KOP', newId)).toEqual([]);
    const item = createLibraryItem(
      s,
      [awl, kop, scl, fc, fb, idb].map((b) => ({
        kind: 'block' as const,
        deviceId: s.id,
        id: b.id,
      })),
      { newId },
    )!;
    const d = device('PLC');
    d.blocks.push(
      createCodeBlock({ kind: 'FC', number: 1, name: 'PFC', language: 'AWL', newId }),
      createCodeBlock({ kind: 'FB', number: 2, name: 'PFB', language: 'AWL', newId }),
      createGlobalDb({ number: 5, name: 'PDB', newId }),
    );
    insertLibraryItem(d, item, new Map(), cpu, newId);
    const fcN = block(d, 'Calc').number;
    const fbN = block(d, 'Asse').number;
    const dbN = d.blocks.find((b) => b.name === 'AsseDB')!.number;
    expect([fcN, fbN, dbN]).toEqual([2, 3, 1]);
    expect(block(d, 'Motore').networks[0]!.source).toBe(
      [
        `CALL FB ${fbN}, DB ${dbN}`,
        `UC FC ${fcN}`,
        `CC FC ${fcN}`,
        `OPN DB ${dbN}`,
        `A DB${dbN}.DBX 0.0`,
        `L P#DB${dbN}.DBX0.0 BYTE 2`,
        'CALL FC 7',
      ].join('\n'),
    );
    expect(block(d, 'Kop').networks[0]!.source).toContain(`CALL %FC${fcN};`);
    expect(JSON.stringify(block(d, 'Kop').networks[0]!.lad)).toContain(`"instance":"%FC${fcN}"`);
    expect(block(d, 'Scl').networks[0]!.source).toBe(`FC${fcN}();\n#x := DB${dbN}.DW0;`);
  });

  it('un riferimento indiretto: avviso e si propone Salta, ma Rinumera se il modello usa il blocco col numero', () => {
    const named = absolute('CALL "Calc"\nOPN DB [MW 10]');
    const n = findConflicts(named.d, named.item).find((x) => x.name === 'Calc')!;
    expect(n).toMatchObject({ indirect: true, usedBy: [] });
    expect(defaultResolution(n)).toBe('skip');
    const { item, d } = absolute('CALL FC 1\nOPN DB [MW 10]');
    const c = findConflicts(d, item).find((x) => x.name === 'Calc')!;
    expect(c).toMatchObject({ indirect: true, usedBy: ['FB1 Motore'] });
    expect(defaultResolution(c)).toBe('renumber');
    const plain = absolute('CALL FC 1');
    const p = findConflicts(plain.d, plain.item).find((x) => x.name === 'Calc')!;
    expect(p).toMatchObject({ indirect: false });
    expect(defaultResolution(p)).toBe('renumber');
  });

  it('Salta un blocco usato col numero e senza omonimo nel PLC: salta anche chi lo usa, a catena', () => {
    const { item, d } = absolute('CALL FC 1\nOPN DB [MW 10]');
    const s = device('SRC2');
    const top = createCodeBlock({ kind: 'FC', number: 9, name: 'Top', language: 'AWL', newId });
    top.networks[0]!.source = 'CALL FB 1, DB 3';
    const free = createCodeBlock({ kind: 'FC', number: 8, name: 'Free', language: 'AWL', newId });
    s.blocks.push(top, free);
    item.blocks.push(...structuredClone(s.blocks));
    const calc = item.blocks.find((b) => b.name === 'Calc')!;
    const ids = (m: Map<string, string>) =>
      [...m].map(([id, to]) => `${item.blocks.find((b) => b.id === id)!.name} → ${to}`);
    expect(ids(skipCascade(d, item, new Set([calc.id])))).toEqual([
      'Motore → FC1 Calc',
      'Top → FB1 Motore',
    ]);
    insertLibraryItem(d, item, new Map([[calc.id, 'skip']]), cpu, newId);
    expect(blocks(d)).toEqual(['FC1 Other', 'FC8 Free']);
    // Con un omonimo nel PLC il codice usa quello: niente catena.
    d.blocks[d.blocks.length - 1]!.name = 'Calc';
    expect(skipCascade(d, item, new Set([calc.id])).size).toBe(0);
  });

  it('un blocco con il numero libero nel PLC non cambia numero, anche dopo uno rinumerato', () => {
    const s = device('SRC');
    const b = createCodeBlock({ kind: 'FC', number: 2, name: 'B', language: 'AWL', newId });
    const a = createCodeBlock({ kind: 'FC', number: 1, name: 'A', language: 'AWL', newId });
    const m = createCodeBlock({ kind: 'FC', number: 9, name: 'M', language: 'AWL', newId });
    m.networks[0]!.source = 'CALL FC 1\nCALL FC 2';
    s.blocks.push(b, a, m);
    const item = createLibraryItem(
      s,
      [b, a, m].map((x) => ({ kind: 'block' as const, deviceId: s.id, id: x.id })),
      { newId },
    )!;
    expect(item.blocks.map((x) => x.name)).toEqual(['B', 'A', 'M']);
    const d = device('PLC');
    d.blocks.push(createCodeBlock({ kind: 'FC', number: 2, name: 'P2', language: 'AWL', newId }));
    expect(findConflicts(d, item).map((c) => c.name)).toEqual(['B']);
    insertLibraryItem(d, item, new Map(), cpu, newId);
    expect(blocks(d)).toEqual(['FC1 A', 'FC2 P2', 'FC3 B', 'FC9 M']);
    expect(block(d, 'M').networks[0]!.source).toBe('CALL FC 1\nCALL FC 3');
  });

  it('Sostituisci: si dice quali blocchi del PLC chiamano quello sostituito', () => {
    const d = device('PLC');
    d.blocks.push(createCodeBlock({ kind: 'FC', number: 1, name: 'Calc', language: 'AWL', newId }));
    (d.blocks.find((b) => b.name === 'Main') as CodeBlock).networks[0]!.source = 'CALL "Calc"';
    const c = findConflicts(d, source()).find((x) => x.name === 'Calc')!;
    expect(c.callers).toEqual(['OB1 Main']);
  });
});
