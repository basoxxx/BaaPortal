import { describe, expect, it } from 'vitest';
import { createCodeBlock } from '@baaportal/project';
import {
  addSlots,
  defaultExpanded,
  interfaceRows,
  ownerOf,
  type InterfaceOwner,
} from '../src/editors/block/interfaceRows';
import { fb, fc, globalDb, instanceDb, mem, newId, plc, udt } from './blockFixtures';

const rowsOf = (owner: InterfaceOwner, dev = plc(), extra: string[] = []) => {
  const expanded = defaultExpanded(owner.kind);
  for (const k of extra) expanded.add(k);
  return interfaceRows(owner, dev, expanded);
};
const members = (rows: ReturnType<typeof rowsOf>) => rows.filter((r) => r.kind !== 'section');

describe('interfaceRows', () => {
  it('FB: sezioni in ordine, offset di istanza e di Temp', () => {
    const block = fb('Nastro', {
      input: [mem('a', 'Bool')],
      output: [mem('b', 'Int')],
      static: [mem('s', 'Struct', { members: [mem('p', 'Bool')] })],
      temp: [mem('t', 'Int')],
    });
    const rows = rowsOf({ kind: 'FB', block });
    expect(members(rows).map((r) => [r.name, r.offset])).toEqual([
      ['a', '0.0'],
      ['b', '2.0'],
      ['s', '4.0'],
      ['t', '0.0'],
    ]);
    expect(rows.filter((r) => r.kind === 'section').map((r) => r.name)).toEqual([
      'Input',
      'Output',
      'InOut',
      'Static',
      'Temp',
    ]);
  });

  it('sezione compressa: le sue righe non compaiono', () => {
    const block = fb('Nastro', { input: [mem('a', 'Bool')], output: [mem('b', 'Bool')] });
    const expanded = defaultExpanded('FB');
    expanded.delete('section:input');
    const rows = interfaceRows({ kind: 'FB', block }, plc(), expanded);
    expect(members(rows).map((r) => r.name)).toEqual(['b']);
  });

  it('FC: niente Static, Return con Ret_Val, offset solo in Temp', () => {
    const block = fc('Calcola', {
      input: [mem('a', 'Int')],
      temp: [mem('t', 'Int')],
      returnType: 'Real',
    });
    const rows = rowsOf({ kind: 'FC', block });
    expect(rows.filter((r) => r.kind === 'section').map((r) => r.name)).toEqual([
      'Input',
      'Output',
      'InOut',
      'Temp',
      'Return',
    ]);
    expect(members(rows).map((r) => [r.name, r.offset])).toEqual([
      ['a', ''],
      ['t', '0.0'],
      ['Ret_Val', ''],
    ]);
    const ret = rows.find((r) => r.name === 'Ret_Val')!;
    expect(ret.type).toBe('Real');
    expect(ret.editable).toEqual({ name: false, type: true, initial: false, comment: false });
  });

  it('valore predefinito: proposto per i tipi con valore, assente in Temp, InOut, struct e array', () => {
    const block = fb('F', {
      input: [mem('a', 'Int', { initial: '5' }), mem('b', 'Real'), mem('c', 'Array[0..1] of Int')],
      inOut: [mem('io', 'Int')],
      static: [mem('s', 'Struct', { members: [] })],
      temp: [mem('t', 'Int')],
    });
    const by = Object.fromEntries(rowsOf({ kind: 'FB', block }).map((r) => [r.name, r]));
    expect(by.a).toMatchObject({ initial: '5', defaultValue: '0' });
    expect(by.a!.editable.initial).toBe(true);
    expect(by.b).toMatchObject({ initial: '', defaultValue: '0.0' });
    for (const n of ['c', 'io', 's', 't']) {
      expect(by[n]!.editable.initial).toBe(false);
      expect(by[n]!.defaultValue).toBe('');
    }
  });

  it('array espanso: righe [i] con offset e valore iniziale sostituito', () => {
    const arr = mem('arr', 'Array[1..3] of Int', { overrides: { '[2]': '5' } });
    const db = globalDb('Dati', [mem('x', 'Bool'), arr]);
    const collapsed = rowsOf({ kind: 'DB', db });
    expect(collapsed.find((r) => r.name === 'arr')!.expandable).toBe(true);
    expect(collapsed.some((r) => r.kind === 'element')).toBe(false);
    const rows = rowsOf({ kind: 'DB', db }, plc(), [arr.id]);
    const els = rows.filter((r) => r.kind === 'element');
    expect(els.map((r) => [r.key, r.name, r.type, r.offset, r.initial])).toEqual([
      ['m-arr[1]', '[1]', 'Int', '2.0', ''],
      ['m-arr[2]', '[2]', 'Int', '4.0', '5'],
      ['m-arr[3]', '[3]', 'Int', '6.0', ''],
    ]);
    expect(els[1]).toMatchObject({ memberId: 'm-arr', overridePath: '[2]', depth: 2 });
    expect(els[1]!.editable).toEqual({ name: false, type: false, initial: true, comment: false });
  });

  it('array a due dimensioni: indici [i,j] in ordine di riga e al massimo 1000 elementi', () => {
    const two = mem('m', 'Array[0..1, 5..6] of Byte');
    let rows = rowsOf({ kind: 'DB', db: globalDb('D', [two]) }, plc(), [two.id]);
    expect(rows.filter((r) => r.kind === 'element').map((r) => r.name)).toEqual([
      '[0,5]',
      '[0,6]',
      '[1,5]',
      '[1,6]',
    ]);
    const big = mem('big', 'Array[0..2000] of Byte');
    rows = rowsOf({ kind: 'DB', db: globalDb('D', [big]) }, plc(), [big.id]);
    expect(rows.filter((r) => r.kind === 'element')).toHaveLength(1000);
  });

  it('UDT espanso in un DB: righe derived con override .membro', () => {
    const dev = plc();
    dev.udts.push(
      udt('Asse', [
        mem('pos', 'Real'),
        mem('speed', 'Int', { initial: '3', comment: 'giri' }),
        mem('lim', 'Struct', { members: [mem('max', 'Int')] }),
      ]),
    );
    const ax = mem('ax', '"Asse"', { overrides: { '.speed': '7' } });
    const db = globalDb('Dati', [ax]);
    const rows = rowsOf({ kind: 'DB', db }, dev, [ax.id, 'm-ax/lim']);
    const kids = rows.filter((r) => r.kind === 'derived');
    expect(kids.map((r) => [r.key, r.name, r.offset, r.initial, r.depth])).toEqual([
      ['m-ax/pos', 'pos', '0.0', '', 2],
      ['m-ax/speed', 'speed', '4.0', '7', 2],
      ['m-ax/lim', 'lim', '6.0', '', 2],
      ['m-ax/lim.max', 'max', '6.0', '', 3],
    ]);
    expect(kids[1]).toMatchObject({ memberId: 'm-ax', overridePath: '.speed', comment: 'giri' });
    expect(kids[1]!.editable).toEqual({ name: false, type: false, initial: true, comment: false });
    expect(kids[2]!.editable.initial).toBe(false);
    // Senza override si vede il valore iniziale dell'UDT.
    delete ax.overrides;
    const plain = rowsOf({ kind: 'DB', db }, dev, [ax.id]);
    expect(plain.find((r) => r.name === 'speed')!.initial).toBe('3');
  });

  it('FB come multi-istanza: i suoi membri compaiono derived (InOut senza valore)', () => {
    const dev = plc();
    dev.blocks.push(fb('Motore', { input: [mem('on', 'Bool')], inOut: [mem('io', 'Int')] }));
    const inst = mem('m1', '"Motore"');
    const block = fb('Linea', { static: [inst] });
    const rows = rowsOf({ kind: 'FB', block }, dev, [inst.id]);
    const kids = rows.filter((r) => r.kind === 'derived');
    expect(kids.map((r) => [r.name, r.editable.initial])).toEqual([
      ['on', true],
      ['io', false],
    ]);
  });

  it('struct espansa: i membri hanno i loro offset e la struct è un contenitore', () => {
    const s = mem('s', 'Struct', { members: [mem('p', 'Bool'), mem('q', 'Int')] });
    const rows = rowsOf({ kind: 'UDT', udt: udt('U', [s]) }, plc(), [s.id]);
    expect(rows.map((r) => [r.name, r.offset, r.depth, r.parentKey])).toEqual([
      ['s', '0.0', 0, null],
      ['p', '0.0', 1, 'm-s'],
      ['q', '2.0', 1, 'm-s'],
    ]);
    expect(rows[0]!.container).toBe(true);
  });

  it('offset assenti se la disposizione non riesce (tipo sconosciuto)', () => {
    const rows = rowsOf({ kind: 'UDT', udt: udt('U', [mem('a', '"Manca"'), mem('b', 'Int')]) });
    expect(rows.map((r) => r.offset)).toEqual(['', '']);
  });

  it('OB1: dieci righe di sola lettura', () => {
    const block = createCodeBlock({ kind: 'OB', number: 1, name: 'Main', language: 'AWL', newId });
    const rows = members(rowsOf({ kind: 'OB', block }));
    expect(rows).toHaveLength(10);
    for (const r of rows) {
      expect(r.readOnly).toBe(true);
      expect(r.editable).toEqual({ name: false, type: false, initial: false, comment: false });
    }
    expect(rows[0]!.offset).toBe('0.0');
  });

  it('DB di istanza: righe derived dall’FB, solo il valore iniziale modificabile, override per percorso', () => {
    const dev = plc();
    dev.blocks.push(
      fb('Nastro', {
        input: [mem('speed', 'Int', { initial: '1' })],
        static: [
          mem('arr', 'Array[0..1] of Int'),
          mem('st', 'Struct', { members: [mem('x', 'Bool')] }),
        ],
        temp: [mem('t', 'Int')],
      }),
    );
    const db = instanceDb('Nastro_DB', 'Nastro');
    db.overrides = { speed: '9', 'arr[1]': '4', 'st.x': 'true' };
    const rows = rowsOf({ kind: 'IDB', db }, dev, ['m-arr', 'm-st']);
    expect(rows.filter((r) => r.kind === 'section').map((r) => r.name)).toEqual([
      'Input',
      'Output',
      'InOut',
      'Static',
    ]);
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(by.speed).toMatchObject({ initial: '9', overridePath: 'speed', offset: '0.0' });
    expect(by.speed!.editable).toEqual({ name: false, type: false, initial: true, comment: false });
    expect(by['[1]']).toMatchObject({ initial: '4', overridePath: 'arr[1]' });
    expect(by.x).toMatchObject({ initial: 'true', overridePath: 'st.x' });
    expect(by.t).toBeUndefined();
    expect(addSlots(rows, 'IDB', defaultExpanded('IDB'))).toEqual([]);
  });

  it('addSlots: dopo l’ultima riga di ogni sezione e di ogni struct espansa, le interne prima', () => {
    const s = mem('s', 'Struct', { members: [mem('p', 'Bool')] });
    const block = fb('F', { input: [mem('a', 'Bool')], static: [s] });
    const expanded = defaultExpanded('FB');
    expanded.add(s.id);
    const rows = interfaceRows({ kind: 'FB', block }, plc(), expanded);
    expect(addSlots(rows, 'FB', expanded).map((x) => [x.containerKey, x.afterKey])).toEqual([
      ['m-s', 'm-p'],
      ['section:input', 'm-a'],
      ['section:output', 'section:output'],
      ['section:inOut', 'section:inOut'],
      ['section:static', 'm-p'],
      ['section:temp', 'section:temp'],
    ]);
    // Senza sezioni (UDT): una sola posizione dopo l'ultima riga, o in fondo se non ce ne sono.
    const u = udt('U', [mem('a', 'Bool')]);
    const urows = interfaceRows({ kind: 'UDT', udt: u }, plc(), new Set());
    expect(addSlots(urows, 'UDT', new Set())).toEqual([
      { containerKey: null, section: 'members', afterKey: 'm-a' },
    ]);
  });

  it('ownerOf risolve blocco, DB, DB di istanza e UDT', () => {
    const dev = plc();
    const f = fb('F');
    dev.blocks.push(f, globalDb('D', []), instanceDb('I', 'F'));
    dev.udts.push(udt('U', []));
    expect(ownerOf(dev, { kind: 'block', id: f.id })?.kind).toBe('FB');
    expect(ownerOf(dev, { kind: 'block', id: 'db-D' })?.kind).toBe('DB');
    expect(ownerOf(dev, { kind: 'block', id: 'idb-I' })?.kind).toBe('IDB');
    expect(ownerOf(dev, { kind: 'udt', id: 'udt-U' })?.kind).toBe('UDT');
    expect(ownerOf(dev, { kind: 'udt', id: 'no' })).toBeUndefined();
  });
});
