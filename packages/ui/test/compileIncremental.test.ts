import { findCpu } from '@baaportal/catalog';
import {
  blockToMc7File,
  createCodeBlock,
  createGlobalDb,
  createInstanceDb,
  createPlcDevice,
  createUdt,
  type CodeBlock,
  type Mc7Diagnostic,
  type PlcDevice,
} from '@baaportal/project';
import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { contextHashOf, hashOf } from '../src/project/compile/compileActions';

const cpu = findCpu('cpu-315-2-pn-dp')!;
const NOW = new Date('2026-10-18T10:00:00.000Z');
const m = (id: string, name: string, type: string) => ({ id, name, type, comment: '' });

/** Un PLC con dipendenze di ogni genere: variabili, costanti, UDT annidati, FC, FB, multi-istanza, DB. */
function fixture(): PlcDevice {
  let n = 0;
  const newId = () => `x${++n}`;
  const d = createPlcDevice({
    cpu,
    orderNumber: '6ES7 315-2EH14-0AB0',
    firmware: 'V3.2',
    name: 'PLC_1',
    texts: { defaultTagTable: 'Variabili' },
    newId,
  });
  d.tagTables[0]!.tags.push(
    { id: 't1', name: 'Start', type: 'Bool', address: '%I0.0', hmi: true, comment: '' },
    { id: 't2', name: 'Stop', type: 'Bool', address: '%I0.1', hmi: true, comment: '' },
    { id: 't3', name: 'Livello', type: 'Int', address: '%MW10', hmi: true, comment: '' },
    { id: 't4', name: 'Altro', type: 'Int', address: '%MW40', hmi: true, comment: '' },
  );
  d.tagTables[0]!.constants.push({ id: 'k1', name: 'Max', type: 'Int', value: '10', comment: '' });
  const pos = createUdt({ name: 'Pos', number: 1, newId });
  pos.members.push(m('u1', 'X', 'Real'), m('u2', 'Y', 'Real'));
  const asse = createUdt({ name: 'Asse', number: 2, newId });
  asse.members.push(m('u3', 'P', '"Pos"'), m('u4', 'On', 'Bool'));
  d.udts.push(pos, asse);
  const ob1 = d.blocks[0] as CodeBlock;
  ob1.networks[0]!.source = [
    'A "Start"',
    'AN "Stop"',
    '= M 0.0',
    'CALL "Calc"',
    ' IN :=MW 12',
    ' RET_VAL:=MW 14',
    'CALL "Linea" , "Linea_DB"',
    'L "Dati".A.P.X',
    'T MD 30',
  ].join('\n');
  const calc = createCodeBlock({ kind: 'FC', number: 1, name: 'Calc', language: 'AWL', newId });
  calc.interface.input.push(m('c1', 'IN', 'Int'));
  calc.interface.returnType = 'Int';
  calc.networks[0]!.source = 'L #IN\nL "Max"\n+I\nT #RET_VAL';
  const other = createCodeBlock({ kind: 'FC', number: 2, name: 'Altra', language: 'AWL', newId });
  // MW 300 è fuori dai merker della CPU 312 (256 byte): il risultato dipende dalla CPU
  other.networks[0]!.source = 'L "Altro"\nT MW 300';
  const scl = createCodeBlock({ kind: 'FC', number: 3, name: 'Scl', language: 'SCL', newId });
  scl.interface.output.push(m('s1', 'x', 'Bool'));
  scl.networks[0]!.source = '#x := "Start" AND NOT "Stop";';
  const nastro = createCodeBlock({ kind: 'FB', number: 1, name: 'Nastro', language: 'AWL', newId });
  nastro.interface.input.push(m('n1', 'Go', 'Bool'));
  nastro.interface.static.push(m('n2', 'Ax', '"Asse"'));
  nastro.networks[0]!.source = 'A #Go\n= #Ax.On';
  const linea = createCodeBlock({ kind: 'FB', number: 2, name: 'Linea', language: 'AWL', newId });
  linea.interface.static.push(m('l1', 'N', '"Nastro"'));
  linea.networks[0]!.source = 'CALL #N\n Go:="Start"';
  const dati = createGlobalDb({ number: 1, name: 'Dati', newId });
  dati.members.push(m('d1', 'A', '"Asse"'), { ...m('d2', 'V', 'Int'), initial: '3' });
  const idb = createInstanceDb({ number: 2, name: 'Linea_DB', instanceOf: 'Linea', newId });
  d.blocks.push(calc, other, scl, nastro, linea, dati, idb);
  return d;
}

/** Generatore deterministico (mulberry32). */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const code = (d: PlcDevice, name: string) => d.blocks.find((b) => b.name === name) as CodeBlock;
type Edit = (d: PlcDevice, r: () => number) => void;
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

/** Modifiche a caso: contenuto, interfacce, variabili, costanti, UDT, DB, nomi e numeri. */
const EDITS: Edit[] = [
  (d, r) => (pick(r, d.tagTables[0]!.tags).type = pick(r, ['Bool', 'Int', 'Word', 'Real'])),
  (d, r) => (pick(r, d.tagTables[0]!.tags).address = pick(r, ['%I0.0', '%MW10', '%MW40', '%MD50'])),
  (d, r) => (pick(r, d.tagTables[0]!.tags).name = pick(r, ['Start', 'Stop', 'Livello', 'Nuovo'])),
  (d, r) => d.tagTables[0]!.tags.push({ ...d.tagTables[0]!.tags[0]!, id: `t${r()}` }),
  (d) => void d.tagTables[0]!.tags.pop(),
  (d, r) => (d.tagTables[0]!.constants[0]!.value = pick(r, ['10', '20', '30'])),
  (d, r) => (d.tagTables[0]!.constants[0]!.type = pick(r, ['Int', 'DInt'])),
  (d, r) => (d.udts[0]!.members[0]!.type = pick(r, ['Real', 'Int', 'DInt'])),
  (d) => d.udts[0]!.members.push(m(`u${d.udts[0]!.members.length + 10}`, 'Z', 'Bool')),
  (d, r) => (d.udts[1]!.members[1]!.type = pick(r, ['Bool', 'Byte'])),
  (d, r) => (d.udts[0]!.name = pick(r, ['Pos', 'Posizione'])),
  (d, r) => (code(d, 'Calc').interface.input[0]!.type = pick(r, ['Int', 'Word', 'DInt'])),
  (d, r) =>
    (code(d, 'Calc').networks[0]!.source = pick(r, [
      'L #IN\nT #RET_VAL',
      'L #IN\nL "Max"\n+I\nT #RET_VAL',
    ])),
  (d, r) =>
    (code(d, 'Altra').networks[0]!.source = pick(r, [
      'L "Altro"\nT MW 42',
      'L "Livello"\nT MW 300',
    ])),
  (d, r) => (code(d, 'Nastro').interface.input[0]!.type = pick(r, ['Bool', 'Int'])),
  (d, r) => code(d, 'Nastro').interface.static.push(m(`n${r()}`, 'K', 'Int')),
  (d, r) =>
    (code(d, 'Nastro').networks[0]!.source = pick(r, ['A #Go\n= #Ax.On', 'A #Go\n= M 1.0'])),
  (d, r) => (code(d, 'Linea').interface.static[0]!.type = pick(r, ['"Nastro"', 'Int'])),
  (d, r) =>
    (code(d, 'Scl').networks[0]!.source = pick(r, [
      '#x := "Start" AND NOT "Stop";',
      '#x := "Start";',
    ])),
  (d, r) => {
    const db = d.blocks.find((b) => b.name === 'Dati');
    if (db?.kind === 'DB') db.members[1]!.initial = pick(r, ['3', '4']);
  },
  (d, r) => {
    const db = d.blocks.find((b) => b.kind === 'DB');
    if (db) db.name = pick(r, ['Dati', 'Dati2']);
  },
  (d, r) =>
    (pick(
      r,
      d.blocks.filter((b) => b.kind === 'FC'),
    ).number = pick(r, [1, 2, 3, 7])),
  (d, r) => {
    const idb = d.blocks.find((b) => b.kind === 'IDB');
    if (idb?.kind === 'IDB') idb.instanceOf = pick(r, ['Linea', 'Nastro']);
  },
  (d, r) => (d.cpu.typeId = pick(r, ['cpu-315-2-pn-dp', 'cpu-312'])),
];

type Out = { file?: Uint8Array; diagnostics: Mc7Diagnostic[] };
const compile = (d: PlcDevice, id: string): Out => {
  const b = d.blocks.find((x) => x.id === id)!;
  const { file, diagnostics } = blockToMc7File(b, d, findCpu(d.cpu.typeId), NOW);
  return { file, diagnostics };
};

describe('compilazione incrementale', () => {
  it('per sequenze di modifiche a caso il risultato è identico a una ricompilazione completa', () => {
    let reused = 0;
    let total = 0;
    let okFiles = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const r = rng(seed);
      let dev = fixture();
      const cache = new Map<string, { key: string; out: Out }>();
      for (let step = 0; step < 40; step++) {
        const ctx = contextHashOf(dev);
        for (const b of dev.blocks) {
          const key = hashOf(b, ctx);
          const kept = cache.get(b.id);
          total++;
          const full = compile(dev, b.id);
          if (full.file) okFiles++;
          if (kept?.key === key) {
            reused++;
            expect(kept.out, `seme ${seed}, passo ${step}, ${b.name}`).toEqual(full);
          } else cache.set(b.id, { key, out: full });
        }
        const edit = pick(r, EDITS);
        dev = produce(dev, (draft) => {
          edit(draft, r);
        });
      }
    }
    // la cache serve davvero, e la maggior parte dei blocchi si compila (i confronti contano)
    expect(reused / total).toBeGreaterThan(0.5);
    expect(okFiles / total).toBeGreaterThan(0.5);
    // ~3000 compilazioni complete: qualche secondo
  }, 60_000);

  it('una variabile usata da un solo blocco ricompila solo quel blocco', () => {
    const dev = fixture();
    const after = produce(dev, (d) => {
      d.tagTables[0]!.tags.find((t) => t.name === 'Altro')!.address = '%MW60';
    });
    const before = contextHashOf(dev);
    const now = contextHashOf(after);
    const changed = after.blocks
      .filter((b, i) => hashOf(b, now) !== hashOf(dev.blocks[i]!, before))
      .map((b) => b.name);
    expect(changed).toEqual(['Altra']);
  });

  it('un UDT annidato cambia le chiavi di chi lo usa a catena (FB, multi-istanza, DB di istanza, OB)', () => {
    const dev = fixture();
    const after = produce(dev, (d) => {
      d.udts[0]!.members[0]!.type = 'Int';
    });
    const before = contextHashOf(dev);
    const now = contextHashOf(after);
    const changed = after.blocks
      .filter((b, i) => hashOf(b, now) !== hashOf(dev.blocks[i]!, before))
      .map((b) => b.name)
      .sort();
    expect(changed).toEqual(['Dati', 'Linea', 'Linea_DB', 'Main', 'Nastro'].sort());
  });
});
