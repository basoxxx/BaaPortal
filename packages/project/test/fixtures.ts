import { findCpu } from '@baaportal/catalog';
import {
  createCodeBlock,
  createGlobalDb,
  createInstanceDb,
  createPlcDevice,
  createProject,
  createUdt,
  type CodeBlock,
  type PlcDevice,
  type Project,
} from '../src/index';

export const now = new Date('2026-10-18T10:00:00.000Z');

export function seq(prefix = 'id'): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

export const cpu315pn = findCpu('cpu-315-2-pn-dp')!;

export function makeDevice(newId = seq()): PlcDevice {
  const d = createPlcDevice({
    cpu: cpu315pn,
    orderNumber: '6ES7 315-2EH14-0AB0',
    firmware: 'V3.2',
    name: 'PLC_1',
    texts: { defaultTagTable: 'Tabella delle variabili standard' },
    newId,
  });
  const table = d.tagTables[0]!;
  table.tags.push(
    { id: newId(), name: 'Start', type: 'Bool', address: '%I0.0', hmi: true, comment: 'ok' },
    { id: newId(), name: 'Stop', type: 'Bool', address: '%I0.1', hmi: false, comment: '' },
  );
  table.constants.push({ id: newId(), name: 'Max', type: 'Int', value: '10', comment: '' });
  const asse = createUdt({ name: 'Asse', number: 1, newId });
  asse.members.push({
    id: newId(),
    name: 'Pos',
    type: 'Struct',
    comment: '',
    members: [{ id: newId(), name: 'X', type: 'Real', comment: '' }],
  });
  const asse2 = createUdt({ name: 'Assi', number: 2, newId });
  asse2.members.push({ id: newId(), name: 'Lista', type: 'Array[1..2] of "Asse"', comment: '' });
  d.udts.push(asse, asse2);
  const motore = createCodeBlock({ kind: 'FB', number: 1, name: 'Nastro', language: 'SCL', newId });
  motore.interface.static.push({ id: newId(), name: 'Ax', type: '"Asse"', comment: '' });
  const nastro = createCodeBlock({ kind: 'FB', number: 2, name: 'Linea', language: 'AWL', newId });
  nastro.interface.static.push({ id: newId(), name: 'N', type: '"Nastro"', comment: '' });
  const db = createGlobalDb({ number: 1, name: 'Dati', newId });
  db.members.push({ id: newId(), name: 'A', type: '"Asse"', comment: '', initial: '0' });
  const idb = createInstanceDb({ number: 2, name: 'Nastro_DB', instanceOf: 'Nastro', newId });
  d.blocks.push(motore, nastro, db, idb);
  d.groups = { blocks: ['A', 'A/B'], tags: [], types: [] };
  return d;
}

export function makeProject(): Project {
  const p = createProject({ name: 'Linea 3', author: 'Mario', comment: 'c' }, now);
  p.devices.push(makeDevice());
  return p;
}

export const ob1 = (d: PlcDevice): CodeBlock => d.blocks[0] as CodeBlock;
