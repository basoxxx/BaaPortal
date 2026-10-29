import { describe, expect, it } from 'vitest';
import { parseType, type DataType } from '@baaportal/s7-types';
import {
  type TagTable,
  checkDevice,
  createCodeBlock,
  createGlobalDb,
  createInstanceDb,
  createPlcDevice,
  createUdt,
  memberAllowed,
  type Diagnostic,
  type DiagnosticCode,
  type Member,
  type PlcDevice,
  type Tag,
} from '../src/index';
import { cpu315pn, seq } from './fixtures';

const cpu = cpu315pn;
const newId = seq('c');

function fresh(): PlcDevice {
  return createPlcDevice({
    cpu,
    orderNumber: '6ES7 315-2EH14-0AB0',
    firmware: 'V3.2',
    name: 'PLC_1',
    texts: { defaultTagTable: 'Standard' },
    newId,
  });
}

const codes = (ds: Diagnostic[]): DiagnosticCode[] => ds.map((d) => d.code);
const tag = (name: string, type: string, address: string): Tag => ({
  id: newId(),
  name,
  type,
  address,
  hmi: false,
  comment: '',
});
const member = (name: string, type: string, extra: Partial<Member> = {}): Member => ({
  id: newId(),
  name,
  type,
  comment: '',
  ...extra,
});
const type = (text: string): DataType => {
  const r = parseType(text);
  if (!r.ok) throw new Error(text);
  return r.type;
};
const no = (): boolean => false;

describe('checkDevice: casi base', () => {
  it('un dispositivo nuovo è senza errori', () => {
    expect(checkDevice(fresh(), cpu)).toEqual([]);
  });

  it('nomi doppi fra tag, costante, blocco e UDT senza distinguere maiuscole', () => {
    const d = fresh();
    d.tagTables[0]!.tags.push(tag('Motore', 'Bool', '%M0.0'));
    d.tagTables[0]!.constants.push({
      id: newId(),
      name: 'MOTORE',
      type: 'Int',
      value: '1',
      comment: '',
    });
    d.blocks.push(
      createCodeBlock({ kind: 'FB', number: 1, name: 'motore', language: 'AWL', newId }),
    );
    const ds = checkDevice(d, cpu);
    expect(codes(ds)).toEqual(['NAME_DUPLICATE', 'NAME_DUPLICATE', 'NAME_DUPLICATE']);
    expect(ds.map((x) => x.ref.kind)).toEqual(['tag', 'constant', 'block']);
  });

  it('lo stesso nome in due tabelle di variabili: errore su entrambi', () => {
    const d = fresh();
    const t2: TagTable = {
      ...d.tagTables[0]!,
      id: newId(),
      name: 'Altra',
      tags: [],
      constants: [],
    };
    d.tagTables.push(t2);
    d.tagTables[0]!.tags.push(tag('Pompa', 'Bool', '%M0.0'));
    t2.tags.push(tag('POMPA', 'Bool', '%M0.1'));
    const ds = checkDevice(d, cpu);
    expect(ds.map((x) => [x.code, x.ref.kind, 'tableId' in x.ref ? x.ref.tableId : ''])).toEqual([
      ['NAME_DUPLICATE', 'tag', d.tagTables[0]!.id],
      ['NAME_DUPLICATE', 'tag', t2.id],
    ]);
  });

  it('nome non valido e nome doppio fra tabelle', () => {
    const d = fresh();
    d.tagTables[0]!.tags.push(tag('', 'Bool', '%M0.0'));
    const t2 = { ...d.tagTables[0]!, id: newId(), name: 'STANDARD', tags: [], constants: [] };
    d.tagTables.push(t2);
    const ds = checkDevice(d, cpu);
    expect(ds.find((x) => x.ref.kind === 'tag')).toMatchObject({
      code: 'NAME_INVALID',
      params: { reason: 'EMPTY' },
    });
    expect(ds.filter((x) => x.ref.kind === 'tagTable').map((x) => x.code)).toEqual([
      'NAME_DUPLICATE',
      'NAME_DUPLICATE',
    ]);
  });

  it('cpu sconosciuta: un solo CPU_UNKNOWN e nessun controllo sui limiti', () => {
    const d = fresh();
    d.tagTables[0]!.tags.push(tag('Fuori', 'Bool', '%M60000.0'));
    d.blocks.push(createCodeBlock({ kind: 'FB', number: 9999, name: 'F', language: 'AWL', newId }));
    d.blocks.push(createCodeBlock({ kind: 'OB', number: 123, name: 'O', language: 'AWL', newId }));
    expect(codes(checkDevice(d, undefined))).toEqual(['CPU_UNKNOWN']);
  });
});

describe('checkDevice: indirizzi', () => {
  it('sintassi, tipo e tipo non ammesso', () => {
    const d = fresh();
    d.tagTables[0]!.tags.push(
      tag('A', 'Bool', 'xx'),
      tag('B', 'Int', '%MB0'),
      tag('C', 'String', '%MB4'),
      tag('D', 'Pippo', '%MB8'),
    );
    const ds = checkDevice(d, cpu);
    expect(ds.map((x) => [x.code, x.field])).toEqual([
      ['ADDRESS_INVALID', 'address'],
      ['ADDRESS_TYPE_MISMATCH', 'address'],
      ['TYPE_NOT_ALLOWED', 'type'],
      ['TYPE_INVALID', 'type'],
    ]);
  });

  it('limiti della CPU: %M2048.0 fuori dalla 315-2 PN/DP', () => {
    const d = fresh();
    d.tagTables[0]!.tags.push(
      tag('Ok', 'Bool', '%M2046.0'),
      tag('Fuori', 'Bool', '%M2049.0'),
      tag('Parola', 'Int', '%MW2047'),
      tag('Q', 'Bool', '%Q2048.0'),
      tag('Tm', 'Timer', '%T256'),
      tag('Cn', 'Counter', '%C256'),
    );
    const ds = checkDevice(d, cpu);
    expect(ds.map((x) => [x.code, x.ref.kind === 'tag' ? x.ref.id : ''])).toEqual([
      ['ADDRESS_OUT_OF_RANGE', d.tagTables[0]!.tags[1]!.id],
      ['ADDRESS_OUT_OF_RANGE', d.tagTables[0]!.tags[2]!.id],
      ['ADDRESS_OUT_OF_RANGE', d.tagTables[0]!.tags[3]!.id],
      ['ADDRESS_OUT_OF_RANGE', d.tagTables[0]!.tags[4]!.id],
      ['ADDRESS_OUT_OF_RANGE', d.tagTables[0]!.tags[5]!.id],
    ]);
  });

  it("sovrapposizione: avviso su entrambi con il nome dell'altro", () => {
    const d = fresh();
    d.tagTables[0]!.tags.push(tag('A', 'Int', '%MW0'), tag('B', 'Bool', '%M1.3'));
    expect(checkDevice(d, cpu).map((x) => [x.code, x.severity, x.params?.other])).toEqual([
      ['ADDRESS_OVERLAP', 'warning', 'B'],
      ['ADDRESS_OVERLAP', 'warning', 'A'],
    ]);
  });

  it('sovrapposizione fra tabelle diverse e aree diverse senza avviso', () => {
    const d = fresh();
    d.tagTables.push({ id: newId(), name: 'Altra', group: '', tags: [], constants: [] });
    d.tagTables[0]!.tags.push(tag('A', 'Bool', '%M0.0'), tag('X', 'Bool', '%I0.0'));
    d.tagTables[1]!.tags.push(tag('B', 'Byte', '%MB0'), tag('Y', 'Bool', '%Q0.0'));
    const ds = checkDevice(d, cpu);
    expect(ds.map((x) => [x.code, x.params?.other])).toEqual([
      ['ADDRESS_OVERLAP', 'B'],
      ['ADDRESS_OVERLAP', 'A'],
    ]);
  });

  it('sovrapposizione con più tag: un solo avviso per tag, con il primo nome e il conteggio', () => {
    const d = fresh();
    d.tagTables[0]!.tags.push(
      tag('A', 'Byte', '%MB0'),
      tag('B', 'Bool', '%M0.1'),
      tag('C', 'Bool', '%M0.2'),
      tag('D', 'Bool', '%M1.0'),
    );
    expect(checkDevice(d, cpu).map((x) => [x.code, x.params?.other, x.params?.count])).toEqual([
      ['ADDRESS_OVERLAP', 'B', '2'],
      ['ADDRESS_OVERLAP', 'A', '1'],
      ['ADDRESS_OVERLAP', 'A', '1'],
    ]);
  });

  it('sovrapposizione: conteggio e primo nome uguali a quelli del confronto coppia per coppia', () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const shapes: [string, (b: number) => string, number][] = [
      ['Bool', (b) => `%M${b}.${rnd(8)}`, 1],
      ['Byte', (b) => `%MB${b}`, 8],
      ['Int', (b) => `%MW${b}`, 16],
      ['DInt', (b) => `%MD${b}`, 32],
      ['Bool', (b) => `%I${b}.${rnd(8)}`, 1],
    ];
    const d = fresh();
    for (let i = 0; i < 300; i++) {
      const [type, address] = shapes[rnd(shapes.length)]!;
      d.tagTables[0]!.tags.push(tag(`T${i}`, type, address(rnd(40))));
    }
    const range = (t: Tag) => {
      const m = /^%([MI])(?:([BWD])?)(\d+)(?:\.(\d))?$/.exec(t.address)!;
      const width = m[2] === 'B' ? 8 : m[2] === 'W' ? 16 : m[2] === 'D' ? 32 : 1;
      const from = Number(m[3]) * 8 + Number(m[4] ?? 0);
      return { area: m[1]!, from, to: from + width - 1 };
    };
    const tags = d.tagTables[0]!.tags;
    const order = tags
      .map((t, i) => ({ t, i, ...range(t) }))
      .sort((x, y) =>
        x.area === y.area ? x.from - y.from || x.i - y.i : x.area < y.area ? -1 : 1,
      );
    const expected = tags.flatMap((t) => {
      const r = range(t);
      const others = order.filter(
        (o) => o.t !== t && o.area === r.area && o.from <= r.to && o.to >= r.from,
      );
      return others.length > 0 ? [[t.id, others[0]!.t.name, String(others.length)]] : [];
    });
    const got = checkDevice(d, cpu)
      .filter((x) => x.code === 'ADDRESS_OVERLAP')
      .map((x) => [x.ref.kind === 'tag' ? x.ref.id : '', x.params?.other, x.params?.count]);
    expect(expected.length).toBeGreaterThan(50);
    expect(got).toEqual(expected);
  });

  it('1000 tag tutti a %M0.0: al massimo un avviso per tag, in meno di 200 ms', () => {
    const d = fresh();
    for (let i = 0; i < 1000; i++) d.tagTables[0]!.tags.push(tag(`T${i}`, 'Bool', '%M0.0'));
    const t0 = performance.now();
    const ds = checkDevice(d, cpu);
    const ms = performance.now() - t0;
    const overlaps = ds.filter((x) => x.code === 'ADDRESS_OVERLAP');
    expect(overlaps).toHaveLength(1000);
    expect(overlaps[0]!.params).toEqual({ other: 'T1', count: '999' });
    expect(overlaps[1]!.params).toEqual({ other: 'T0', count: '999' });
    expect(ms).toBeLessThan(200);
  }, 30_000);

  it('5000 tag controllati in meno di un secondo', () => {
    const d = fresh();
    for (let i = 0; i < 5000; i++)
      d.tagTables[0]!.tags.push(tag(`T${i}`, 'Bool', `%M${i >> 3}.${i & 7}`));
    const t0 = performance.now();
    const ds = checkDevice(d, cpu);
    const ms = performance.now() - t0;
    expect(ds.filter((x) => x.severity === 'error')).toEqual([]);
    expect(ms).toBeLessThan(1000);
  }, 30_000);
});

describe('checkDevice: valori e costanti', () => {
  it('costante con tipo non elementare o valore errato', () => {
    const d = fresh();
    d.tagTables[0]!.constants.push(
      { id: newId(), name: 'K1', type: 'String', value: 'a', comment: '' },
      { id: newId(), name: 'K2', type: 'Int', value: '99999', comment: '' },
    );
    expect(checkDevice(d, cpu).map((x) => [x.code, x.field])).toEqual([
      ['TYPE_NOT_ALLOWED', 'type'],
      ['VALUE_INVALID', 'value'],
    ]);
  });

  it('valore iniziale dei membri: vuoto ammesso, errato e senza valore no', () => {
    const d = fresh();
    const db = createGlobalDb({ number: 1, name: 'Dati', newId });
    db.members.push(
      member('A', 'Int', { initial: '' }),
      member('B', 'Int', { initial: '5' }),
      member('C', 'Int', { initial: 'x' }),
      member('D', 'Struct', { initial: '1', members: [member('E', 'Bool')] }),
    );
    d.blocks.push(db);
    const ds = checkDevice(d, cpu);
    expect(ds.map((x) => [x.code, x.ref.kind === 'member' ? x.ref.memberId : ''])).toEqual([
      ['VALUE_INVALID', db.members[2]!.id],
      ['VALUE_INVALID', db.members[3]!.id],
    ]);
  });

  it('valori di STEP 7 V5.5: DT a due cifre, array con elenco e ripetizione, binario con _', () => {
    const d = fresh();
    const db = createGlobalDb({ number: 1, name: 'Dati', newId });
    db.members.push(
      member('Ora', 'Date_And_Time', { initial: 'DT#90-1-1-0:0:0.000' }),
      member('Lista', 'Array[1..3] of Int', { initial: '1, 2, 3' }),
      member('Zeri', 'Array[0..3] of Int', { initial: '4(0)' }),
      member('Misto', 'Array[1..5] of Int', { initial: '2(1), 3' }),
      member('Bit', 'Word', { initial: '2#0000_0000_0000_0001' }),
      member('Troppi', 'Array[1..3] of Int', { initial: '1, 2, 3, 4' }),
      member('Fuori', 'Array[1..3] of Int', { initial: '2(40000)' }),
      member('Anno', 'Date_And_Time', { initial: 'DT#2090-1-1-0:0:0.000' }),
    );
    d.blocks.push(db);
    const ds = checkDevice(d, cpu).filter((x) => x.code === 'VALUE_INVALID');
    expect(
      ds.map((x) => [x.ref.kind === 'member' ? x.ref.memberId : '', x.params?.reason]),
    ).toEqual([
      [db.members[5]!.id, 'TOO_LONG'],
      [db.members[6]!.id, 'OUT_OF_RANGE'],
      [db.members[7]!.id, 'OUT_OF_RANGE'],
    ]);
  });

  it('override di un membro: [i] per gli elementi di un array, .percorso per i membri del tipo', () => {
    const d = fresh();
    const udt = createUdt({ name: 'Asse', number: 1, newId });
    udt.members.push(member('speed', 'Int'));
    d.udts.push(udt);
    const db = createGlobalDb({ number: 1, name: 'Dati', newId });
    db.members.push(
      member('arr', 'Array[1..3] of Int', { overrides: { '[2]': '5', '[3]': 'x', '.a': '1' } }),
      member('ax', '"Asse"', { overrides: { '.speed': '7', '.nope': '1', '.speed ': 'x' } }),
    );
    d.blocks.push(db);
    const ds = checkDevice(d, cpu).filter((x) => x.code === 'VALUE_INVALID');
    expect(ds.map((x) => [x.ref.kind === 'member' ? x.ref.memberId : '', x.params?.path])).toEqual([
      [db.members[0]!.id, '[3]'],
      [db.members[0]!.id, '.a'],
      [db.members[1]!.id, '.nope'],
      [db.members[1]!.id, '.speed '],
    ]);
  });

  it('override di istanza non validi: VALUE_INVALID con il percorso', () => {
    const d = fresh();
    const fb = createCodeBlock({ kind: 'FB', number: 1, name: 'Nastro', language: 'AWL', newId });
    fb.interface.static.push(
      member('Vel', 'Int'),
      member('Pos', 'Struct', { members: [member('X', 'Real')] }),
    );
    const idb = createInstanceDb({ number: 1, name: 'Nastro_DB', instanceOf: 'Nastro', newId });
    idb.overrides = { Vel: '5', 'Pos.X': 'abc', 'Pos.Z': '1.0' };
    d.blocks.push(fb, idb);
    const ds = checkDevice(d, cpu);
    expect(ds.map((x) => [x.code, x.params?.path])).toEqual([
      ['VALUE_INVALID', 'Pos.X'],
      ['VALUE_INVALID', 'Pos.Z'],
    ]);
    // Un percorso che non porta a un membro si distingue da un valore errato.
    expect(ds[0]!.params?.reason).not.toBe('PATH_NOT_FOUND');
    expect(ds[1]!.params?.reason).toBe('PATH_NOT_FOUND');
  });
});

describe('memberAllowed', () => {
  it('tipi per sezione', () => {
    expect(memberAllowed('FB', 'input', type('Pointer'), no)).toBe(false);
    expect(memberAllowed('FC', 'input', type('Pointer'), no)).toBe(true);
    expect(memberAllowed('FB', 'static', type('"Nastro"'), (n) => n === 'Nastro')).toBe(true);
    expect(memberAllowed('FC', 'static', type('Int'), no)).toBe(false);
    expect(memberAllowed('FC', 'return', type('Struct'), no)).toBe(false);
    expect(memberAllowed('DB', 'members', type('Timer'), no)).toBe(false);
  });

  it('altre combinazioni della tabella', () => {
    const isFb = (n: string): boolean => n === 'Nastro';
    expect(memberAllowed('FB', 'input', type('Timer'), no)).toBe(true);
    expect(memberAllowed('FB', 'input', type('Block_DB'), no)).toBe(true);
    expect(memberAllowed('FB', 'output', type('Timer'), no)).toBe(false);
    expect(memberAllowed('FC', 'output', type('Any'), no)).toBe(true);
    expect(memberAllowed('FB', 'output', type('Any'), no)).toBe(false);
    expect(memberAllowed('FB', 'inOut', type('Any'), no)).toBe(true);
    expect(memberAllowed('OB', 'temp', type('Any'), no)).toBe(true);
    expect(memberAllowed('OB', 'temp', type('Timer'), no)).toBe(false);
    expect(memberAllowed('OB', 'input', type('Int'), no)).toBe(false);
    expect(memberAllowed('FC', 'return', type('Void'), no)).toBe(true);
    expect(memberAllowed('FC', 'return', type('Real'), no)).toBe(true);
    expect(memberAllowed('FB', 'return', type('Void'), no)).toBe(false);
    expect(memberAllowed('FB', 'temp', type('"Nastro"'), isFb)).toBe(false);
    expect(memberAllowed('UDT', 'members', type('"Altro"'), isFb)).toBe(true);
    expect(memberAllowed('UDT', 'members', type('"Nastro"'), isFb)).toBe(false);
    expect(memberAllowed('DB', 'members', type('Array[1..2] of Int'), no)).toBe(true);
    expect(memberAllowed('DB', 'static', type('Int'), no)).toBe(false);
  });
});

describe('checkDevice: interfacce e riferimenti', () => {
  it('nomi locali doppi fra sezioni e dentro uno struct; tipo non ammesso', () => {
    const d = fresh();
    const fc = createCodeBlock({ kind: 'FC', number: 1, name: 'F', language: 'AWL', newId });
    fc.interface.input.push(member('X', 'Int'));
    fc.interface.temp.push(
      member('x', 'Int'),
      member('S', 'Struct', { members: [member('A', 'Bool'), member('a', 'Bool')] }),
    );
    fc.interface.static.push(member('St', 'Int'));
    d.blocks.push(fc);
    const ds = checkDevice(d, cpu);
    expect(ds.map((x) => [x.code, x.ref.kind === 'member' ? x.ref.memberId : ''])).toEqual([
      ['NAME_DUPLICATE', fc.interface.input[0]!.id],
      ['TYPE_NOT_ALLOWED', fc.interface.static[0]!.id],
      ['NAME_DUPLICATE', fc.interface.temp[0]!.id],
      ['NAME_DUPLICATE', fc.interface.temp[1]!.members![0]!.id],
      ['NAME_DUPLICATE', fc.interface.temp[1]!.members![1]!.id],
    ]);
  });

  it('numeri doppi, fuori intervallo e OB non supportato', () => {
    const d = fresh();
    d.blocks.push(
      createCodeBlock({ kind: 'FB', number: 1, name: 'F1', language: 'AWL', newId }),
      createCodeBlock({ kind: 'FB', number: 1, name: 'F2', language: 'AWL', newId }),
      createCodeBlock({ kind: 'FC', number: 0, name: 'C0', language: 'AWL', newId }),
      createCodeBlock({
        kind: 'FC',
        number: cpu.limits.maxFc + 1,
        name: 'C1',
        language: 'AWL',
        newId,
      }),
      createGlobalDb({ number: 5, name: 'D5', newId }),
      createInstanceDb({ number: 5, name: 'I5', instanceOf: 'F1', newId }),
      createCodeBlock({ kind: 'OB', number: 1, name: 'Main2', language: 'AWL', newId }),
      createCodeBlock({ kind: 'OB', number: 77, name: 'Ob77', language: 'AWL', newId }),
    );
    d.udts.push(
      createUdt({ name: 'U1', number: 1, newId }),
      createUdt({ name: 'U2', number: 1, newId }),
    );
    const nameOf = (x: Diagnostic): string => {
      if (x.ref.kind === 'block')
        return d.blocks.find((b) => b.id === (x.ref as { id: string }).id)!.name;
      if (x.ref.kind === 'udt')
        return d.udts.find((u) => u.id === (x.ref as { id: string }).id)!.name;
      return '';
    };
    const got = checkDevice(d, cpu).map((x) => [x.code, nameOf(x)]);
    expect(got).toEqual([
      ['NUMBER_DUPLICATE', 'U1'],
      ['NUMBER_DUPLICATE', 'U2'],
      ['NUMBER_DUPLICATE', 'Main'],
      ['NUMBER_DUPLICATE', 'F1'],
      ['NUMBER_DUPLICATE', 'F2'],
      ['NUMBER_OUT_OF_RANGE', 'C0'],
      ['NUMBER_OUT_OF_RANGE', 'C1'],
      ['NUMBER_DUPLICATE', 'D5'],
      ['NUMBER_DUPLICATE', 'I5'],
      ['NUMBER_DUPLICATE', 'Main2'],
      ['OB_NOT_SUPPORTED', 'Ob77'],
    ]);
  });

  it('file con riferimenti rotti: diagnostica, nessuna eccezione', () => {
    const d = fresh();
    d.blocks.push(createInstanceDb({ number: 3, name: 'Orfano', instanceOf: 'Manca', newId }));
    const db = createGlobalDb({ number: 4, name: 'Dati', newId });
    db.members.push(member('M', '"NonCè"'));
    d.blocks.push(db);
    const a = createUdt({ name: 'A', number: 1, newId });
    const b = createUdt({ name: 'B', number: 2, newId });
    a.members.push(member('b', '"B"'));
    b.members.push(member('a', '"A"'));
    d.udts.push(a, b);
    const fb = createCodeBlock({ kind: 'FB', number: 1, name: 'Ric', language: 'AWL', newId });
    fb.interface.static.push(member('Me', '"Ric"'));
    d.blocks.push(fb);
    const ds = checkDevice(d, cpu);
    expect(codes(ds)).toEqual(
      expect.arrayContaining(['INSTANCE_FB_MISSING', 'TYPE_UNKNOWN', 'TYPE_CYCLE']),
    );
    const cycles = ds.filter((x) => x.code === 'TYPE_CYCLE').map((x) => x.ref.kind);
    expect(cycles).toEqual(['udt', 'udt', 'block']);
    expect(ds.find((x) => x.code === 'TYPE_UNKNOWN')?.params?.name).toBe('NonCè');
  });

  it('intestazione: proprietà non valide di blocchi e UDT', () => {
    const d = fresh();
    const fb = createCodeBlock({ kind: 'FB', number: 1, name: 'F', language: 'AWL', newId });
    fb.header.headerName = 'troppolungo';
    fb.header.version = '16.0';
    fb.header.family = 'ok_1';
    const u = createUdt({ name: 'U', number: 1, newId });
    u.author = 'Mario Rossi';
    d.blocks.push(fb);
    d.udts.push(u);
    const ds = checkDevice(d, cpu);
    expect(ds.map((x) => [x.code, x.ref.kind, x.property])).toEqual([
      ['HEADER_INVALID', 'udt', 'author'],
      ['HEADER_INVALID', 'block', 'headerName'],
      ['HEADER_INVALID', 'block', 'version'],
    ]);
  });
});

describe('checkDevice: proprietà della CPU', () => {
  const props = (d: PlcDevice): (string | undefined)[] =>
    checkDevice(d, cpu).map((x) => x.property);

  it('proprietà CPU non valide', () => {
    const d = fresh();
    d.properties.pn!.ipAddress = '192.168.0.0';
    d.properties.pn!.subnetMask = '255.0.255.0';
    d.properties.clockMemory.byte = 2048;
    const ds = checkDevice(d, cpu);
    expect(ds.map((x) => [x.code, x.property, x.field])).toEqual([
      ['PROPERTY_INVALID', 'pn.ipAddress', 'property'],
      ['PROPERTY_INVALID', 'pn.subnetMask', 'property'],
      ['PROPERTY_INVALID', 'clockMemory.byte', 'property'],
    ]);
    expect(ds[0]!.ref).toEqual({ kind: 'device', deviceId: d.id });
  });

  it('indirizzi IP e router', () => {
    const d = fresh();
    const pn = d.properties.pn!;
    for (const ip of ['127.0.0.1', '224.0.0.1', '0.1.2.3', '1.2.3', '192.168.0.255', 'a.b.c.d']) {
      pn.ipAddress = ip;
      expect(props(d)).toEqual(['pn.ipAddress']);
    }
    pn.ipAddress = '192.168.0.1';
    for (const m of ['255.255.255.255', '127.0.0.0', '255.255.255.253', '']) {
      pn.subnetMask = m;
      expect(props(d)).toEqual(['pn.subnetMask']);
    }
    pn.subnetMask = '128.0.0.0';
    expect(props(d)).toEqual([]);
    pn.subnetMask = '255.255.255.0';
    pn.useRouter = true;
    pn.routerAddress = '192.168.1.1';
    expect(props(d)).toEqual(['pn.routerAddress']);
    pn.routerAddress = '192.168.0.254';
    expect(props(d)).toEqual([]);
  });

  it('intervalli numerici', () => {
    const d = fresh();
    Object.assign(d.properties, { mpiAddress: 127, dpAddress: 0 });
    d.properties.cycle = { maxCycleMs: 6001, minCycleMs: 7000, commLoadPercent: 4 };
    d.properties.cyclicInterrupts.ob35Ms = 0;
    d.properties.retentivity = { mBytes: 99999, timers: 99999, counters: 99999 };
    expect(props(d)).toEqual([
      'mpiAddress',
      'dpAddress',
      'cycle.maxCycleMs',
      'cycle.minCycleMs',
      'cycle.commLoadPercent',
      'retentivity.mBytes',
      'retentivity.timers',
      'retentivity.counters',
      'cyclicInterrupts.ob35Ms',
    ]);
  });
});

describe('SFB come tipo di istanza', () => {
  it('DB di istanza di una SFB e multi-istanza "TON" senza errori', () => {
    const d = fresh();
    const fb = createCodeBlock({ kind: 'FB', number: 1, name: 'Ritardo', language: 'AWL', newId });
    fb.interface.static.push(member('T1', '"TON"'));
    const idb = createInstanceDb({ number: 1, name: 'T1_DB', instanceOf: 'TON', newId });
    idb.overrides = { PT: 'T#5s' };
    d.blocks.push(fb, idb);
    expect(checkDevice(d, cpu)).toEqual([]);
  });

  it("un override su un'istanza di SFB e verificato sull'interfaccia della SFB", () => {
    const d = fresh();
    const idb = createInstanceDb({ number: 1, name: 'T1_DB', instanceOf: 'TON', newId });
    idb.overrides = { PT: 'abc', Manca: '1' };
    d.blocks.push(idb);
    expect(checkDevice(d, cpu).map((x) => [x.code, x.params?.path])).toEqual([
      ['VALUE_INVALID', 'PT'],
      ['VALUE_INVALID', 'Manca'],
    ]);
  });

  it('un nome che non e ne un FB ne una SFB resta INSTANCE_FB_MISSING', () => {
    const d = fresh();
    d.blocks.push(createInstanceDb({ number: 1, name: 'X_DB', instanceOf: 'Nonexistent', newId }));
    expect(codes(checkDevice(d, cpu))).toEqual(['INSTANCE_FB_MISSING']);
  });

  it('un tag puo chiamarsi come una SFB: i blocchi di sistema non sono nei simboli del progetto', () => {
    const d = fresh();
    d.tagTables[0]!.tags.push(tag('TON', 'Bool', '%M0.0'));
    expect(checkDevice(d, cpu)).toEqual([]);
  });

  it('un FB o un UDT del progetto con il nome di una SFB ha la precedenza', () => {
    const d = fresh();
    const fb = createCodeBlock({ kind: 'FB', number: 1, name: 'TON', language: 'AWL', newId });
    fb.interface.input.push(member('Solo', 'Int'));
    const idb = createInstanceDb({ number: 1, name: 'T_DB', instanceOf: 'TON', newId });
    idb.overrides = { Solo: '3' };
    d.blocks.push(fb, idb);
    expect(checkDevice(d, cpu)).toEqual([]);
    idb.overrides = { PT: 'T#5s' };
    expect(codes(checkDevice(d, cpu))).toEqual(['VALUE_INVALID']);
  });
});
