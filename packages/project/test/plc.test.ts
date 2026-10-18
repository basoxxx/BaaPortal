import { findCpu } from '@baaportal/catalog';
import { describe, expect, it } from 'vitest';
import {
  createCodeBlock,
  createGlobalDb,
  createInstanceDb,
  createPlcDevice,
  createUdt,
  findBlock,
  findDevice,
  findTagTable,
  findUdt,
  memberPath,
  nextFreeNumber,
  renameWithReferences,
  symbolNames,
  toTypedMembers,
  typeResolver,
  uniqueName,
  createNamer,
  type CodeBlock,
  type Member,
} from '../src/index';
import { cpu315pn, makeDevice, makeProject, ob1, seq } from './fixtures';

const m = (name: string, type: string, extra: Partial<Member> = {}): Member => ({
  id: name,
  name,
  type,
  comment: '',
  ...extra,
});

describe('createPlcDevice', () => {
  it('valori predefiniti', () => {
    const d = createPlcDevice({
      cpu: cpu315pn,
      orderNumber: '6ES7 315-2EH14-0AB0',
      firmware: 'V3.2',
      name: 'PLC_1',
      texts: { defaultTagTable: 'Tabella delle variabili standard' },
      newId: seq(),
    });
    expect(d.properties).toEqual({
      comment: '',
      pn: {
        ipAddress: '192.168.0.1',
        subnetMask: '255.255.255.0',
        useRouter: false,
        routerAddress: '',
      },
      mpiAddress: 2,
      dpAddress: 2,
      cycle: { maxCycleMs: 150, minCycleMs: 0, commLoadPercent: 20 },
      clockMemory: { enabled: false, byte: 0 },
      retentivity: { mBytes: 16, timers: 0, counters: 8 },
      cyclicInterrupts: { ob35Ms: 100 },
    });
    expect(d.cpu).toEqual({
      typeId: 'cpu-315-2-pn-dp',
      orderNumber: '6ES7 315-2EH14-0AB0',
      firmware: 'V3.2',
    });
    expect(d.groups).toEqual({ blocks: [], tags: [], types: [] });
    expect(d.tagTables.map((t) => t.name)).toEqual(['Tabella delle variabili standard']);
    const b = d.blocks[0] as CodeBlock;
    expect([
      b.kind,
      b.number,
      b.name,
      b.language,
      b.interface.temp.length,
      b.interface.temp.every((x) => x.readOnly && x.comment === ''),
      b.networks.length,
    ]).toEqual(['OB', 1, 'Main', 'AWL', 10, true, 1]);
  });

  it('senza PN né DP le proprietà relative mancano', () => {
    const cpu = findCpu('cpu-312')!;
    expect(cpu.interfaces.pn || cpu.interfaces.dp).toBe(false);
    const d = createPlcDevice({
      cpu,
      orderNumber: cpu.versions[0]!.orderNumber,
      firmware: 'V1',
      name: 'P',
      texts: { defaultTagTable: 'T' },
    });
    expect('pn' in d.properties).toBe(false);
    expect('dpAddress' in d.properties).toBe(false);
  });
});

describe('creazione oggetti', () => {
  it('blocchi e UDT con i valori predefiniti', () => {
    const newId = seq();
    const fc = createCodeBlock({ kind: 'FC', number: 3, name: 'F', language: 'SCL', newId });
    expect(fc.interface.returnType).toBe('Void');
    const fb = createCodeBlock({ kind: 'FB', number: 3, name: 'F', language: 'SCL', newId });
    expect(fb.interface).toEqual({
      input: [],
      output: [],
      inOut: [],
      static: [],
      temp: [],
      returnType: '',
    });
    expect(fb.header).toEqual({
      title: '',
      comment: '',
      author: '',
      family: '',
      headerName: '',
      version: '0.1',
    });
    const ob = createCodeBlock({ kind: 'OB', number: 999, name: 'X', language: 'AWL', newId });
    expect(ob.interface.temp).toEqual([]);
    expect(createGlobalDb({ number: 1, name: 'D', newId }).attributes).toEqual({
      unlinked: false,
      readOnly: false,
      nonRetain: false,
    });
    expect(createInstanceDb({ number: 2, name: 'I', instanceOf: 'F', newId })).toMatchObject({
      kind: 'IDB',
      instanceOf: 'F',
      overrides: {},
    });
    expect(createUdt({ name: 'U', number: 1, newId })).toMatchObject({
      version: '0.1',
      members: [],
    });
  });

  it('gli id usano newId e sono tutti distinti', () => {
    const d = makeDevice();
    const ids = [d.id, ...d.blocks.flatMap((b) => [b.id])];
    expect(new Set(ids).size).toBe(ids.length);
    expect(createUdt({ name: 'U', number: 1 }).id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('numeri e nomi', () => {
  it('nextFreeNumber: buchi, DB e IDB condivisi, pieno → null', () => {
    const newId = seq();
    const d = makeDevice(newId);
    d.blocks = [
      createCodeBlock({ kind: 'FB', number: 1, name: 'a', language: 'AWL', newId }),
      createCodeBlock({ kind: 'FB', number: 2, name: 'b', language: 'AWL', newId }),
      createCodeBlock({ kind: 'FB', number: 4, name: 'c', language: 'AWL', newId }),
      createGlobalDb({ number: 1, name: 'g', newId }),
      createInstanceDb({ number: 2, name: 'i', instanceOf: 'a', newId }),
    ];
    expect(nextFreeNumber(d, 'FB', 10)).toBe(3);
    expect(nextFreeNumber(d, 'DB', 10)).toBe(3);
    expect(nextFreeNumber(d, 'OB', 10)).toBe(1);
    expect(nextFreeNumber(d, 'FC', 10)).toBe(1);
    expect(nextFreeNumber(d, 'FB', 2)).toBeNull();
    d.udts = [createUdt({ name: 'u', number: 1, newId })];
    expect(nextFreeNumber(d, 'UDT', 1)).toBeNull();
    expect(nextFreeNumber(d, 'UDT', 2)).toBe(2);
  });

  it('uniqueName', () => {
    expect(uniqueName('Motore', ['motore', 'Motore_1'])).toBe('Motore_2');
    expect(uniqueName('Nastro', ['Motore'])).toBe('Nastro');
    expect(uniqueName('constructor', ['x'])).toBe('constructor');
    // Il primo libero della sequenza, anche con buchi; zeri iniziali conservati.
    expect(uniqueName('Motore', ['Motore', 'Motore_5'])).toBe('Motore_1');
    expect(uniqueName('A_09', ['a_09', 'A_10'])).toBe('A_11');
    expect(uniqueName('MOTORE_1', ['motore_1', 'Motore_2'])).toBe('MOTORE_3');
  });

  it('createNamer: come uniqueName ripetuto, con i nomi dati che diventano presi', () => {
    const taken = ['Motore', 'Motore_1', 'Motore_3', 'Pompa_01', 'pompa_02'];
    const bases = ['Motore', 'motore', 'Motore_1', 'Pompa_01', 'Pompa', 'MOTORE', 'Motore_3', 'x'];
    const unique = createNamer(taken);
    const got = bases.map((b) => unique(b));
    const list = [...taken];
    const expected = bases.map((b) => {
      const n = uniqueName(b, list);
      list.push(n);
      return n;
    });
    expect(got).toEqual(expected);
    expect(got).toEqual([
      'Motore_2',
      'motore_4',
      'Motore_5',
      'Pompa_03',
      'Pompa',
      'MOTORE_6',
      'Motore_7',
      'x',
    ]);
  });

  it('createNamer: 1000 nomi già presi e ripetuti restano rapidi', () => {
    const taken = Array.from({ length: 1000 }, (_, i) => `Variabile_${i + 1}`);
    const t0 = performance.now();
    const unique = createNamer(taken);
    const out = taken.map((n) => unique(n));
    const ms = performance.now() - t0;
    expect(out[0]).toBe('Variabile_1001');
    expect(out[999]).toBe('Variabile_2000');
    expect(new Set(out).size).toBe(1000);
    expect(ms).toBeLessThan(200);
  }, 30_000);

  it('symbolNames: tag, costanti, blocchi e UDT', () => {
    expect(symbolNames(makeDevice()).sort()).toEqual(
      [
        'Start',
        'Stop',
        'Max',
        'Main',
        'Nastro',
        'Linea',
        'Dati',
        'Nastro_DB',
        'Asse',
        'Assi',
      ].sort(),
    );
  });

  it('ricerche per id esatto', () => {
    const p = makeProject();
    const d = p.devices[0]!;
    expect(findDevice(p, d.id)).toBe(d);
    expect(findDevice(p, 'x')).toBeUndefined();
    expect(findBlock(d, d.blocks[1]!.id)).toBe(d.blocks[1]);
    expect(findUdt(d, d.udts[0]!.id)).toBe(d.udts[0]);
    expect(findTagTable(d, d.tagTables[0]!.id)).toBe(d.tagTables[0]);
    expect(findBlock(d, '__proto__')).toBeUndefined();
  });
});

describe('renameWithReferences', () => {
  it('rinomina di un UDT aggiorna tutti i riferimenti', () => {
    const d = makeDevice();
    const dati = d.blocks.find((b) => b.kind === 'DB') as unknown as { members: Member[] };
    const asse = d.udts[0]!;
    renameWithReferences(d, { kind: 'udt', deviceId: d.id, id: asse.id }, 'Asse2');
    expect(asse.name).toBe('Asse2');
    expect([
      (d.blocks[1] as CodeBlock).interface.static[0]!.type,
      d.udts[1]!.members[0]!.type,
      dati.members[0]!.type,
    ]).toEqual(['"Asse2"', 'Array[1..2] of "Asse2"', '"Asse2"']);
    // i tipi che riguardano altri oggetti restano invariati
    expect((d.blocks[2] as CodeBlock).interface.static[0]!.type).toBe('"Nastro"');
  });

  it('il confronto ignora le maiuscole e i tipi illeggibili restano invariati', () => {
    const d = makeDevice();
    const fb = d.blocks[1] as CodeBlock;
    fb.interface.input.push(m('a', '"ASSE"'), m('b', 'Array[1..2] of'), m('c', 'Real'));
    const nested = m('s', 'Struct', { members: [m('in', 'Array[0..1] of "asse"')] });
    fb.interface.temp.push(nested);
    renameWithReferences(d, { kind: 'udt', deviceId: d.id, id: d.udts[0]!.id }, 'Nuovo');
    expect(fb.interface.input.map((x) => x.type)).toEqual(['"Nuovo"', 'Array[1..2] of', 'Real']);
    expect(nested.members![0]!.type).toBe('Array[0..1] of "Nuovo"');
  });

  it('rinomina di un FB aggiorna DB di istanza e multi-istanze', () => {
    const d = makeDevice();
    const nastro = d.blocks[1]!;
    renameWithReferences(d, { kind: 'block', deviceId: d.id, id: nastro.id }, 'Nastro2');
    expect(d.blocks[1]!.name).toBe('Nastro2');
    expect((d.blocks[4] as { instanceOf: string }).instanceOf).toBe('Nastro2');
    expect((d.blocks[2] as CodeBlock).interface.static[0]!.type).toBe('"Nastro2"');
  });

  it('un blocco non FB cambia solo il nome', () => {
    const d = makeDevice();
    (d.blocks[1] as CodeBlock).interface.static.push(m('x', '"Main"'));
    renameWithReferences(d, { kind: 'block', deviceId: d.id, id: d.blocks[0]!.id }, 'Main2');
    expect(d.blocks[0]!.name).toBe('Main2');
    expect((d.blocks[1] as CodeBlock).interface.static.at(-1)!.type).toBe('"Main"');
  });

  it('dispositivo, tabella, tag, costante e membro cambiano solo il nome', () => {
    const d = makeDevice();
    const t = d.tagTables[0]!;
    renameWithReferences(d, { kind: 'device', deviceId: d.id }, 'PLC_2');
    renameWithReferences(d, { kind: 'tagTable', deviceId: d.id, id: t.id }, 'T2');
    renameWithReferences(d, { kind: 'tag', deviceId: d.id, tableId: t.id, id: t.tags[0]!.id }, 'S');
    renameWithReferences(
      d,
      { kind: 'constant', deviceId: d.id, tableId: t.id, id: t.constants[0]!.id },
      'Mx',
    );
    const pos = d.udts[0]!.members[0]!;
    renameWithReferences(
      d,
      {
        kind: 'member',
        deviceId: d.id,
        ownerKind: 'udt',
        ownerId: d.udts[0]!.id,
        memberId: pos.members![0]!.id,
      },
      'Y',
    );
    const fb = d.blocks[1] as CodeBlock;
    renameWithReferences(
      d,
      {
        kind: 'member',
        deviceId: d.id,
        ownerKind: 'block',
        ownerId: fb.id,
        memberId: fb.interface.static[0]!.id,
      },
      'Ax2',
    );
    expect([d.name, t.name, t.tags[0]!.name, t.constants[0]!.name]).toEqual([
      'PLC_2',
      'T2',
      'S',
      'Mx',
    ]);
    expect(pos.members![0]!.name).toBe('Y');
    expect(fb.interface.static[0]!.name).toBe('Ax2');
  });
});

describe('members', () => {
  it('memberPath', () => {
    expect(memberPath('', 'a')).toBe('a');
    expect(memberPath('a', 'b')).toBe('a.b');
    expect(memberPath('a', [1, 2])).toBe('a[1,2]');
    expect(memberPath('', [3])).toBe('[3]');
  });

  it('toTypedMembers: struct annidate, array di struct, tipi non validi saltati', () => {
    const r = toTypedMembers([
      m('a', 'Int'),
      m('bad', 'Array[1..'),
      m('s', 'Struct', { members: [m('x', 'Real'), m('y', '???')] }),
      m('arr', 'Array[1..2] of Struct', { members: [m('z', 'Bool')] }),
    ]);
    expect(r.map((x) => x.name)).toEqual(['a', 's', 'arr']);
    expect(r[1]!.type).toEqual({
      kind: 'struct',
      members: [{ name: 'x', type: { kind: 'elementary', name: 'Real' } }],
    });
    expect(r[2]!.type).toMatchObject({
      kind: 'array',
      element: { kind: 'struct', members: [{ name: 'z' }] },
    });
  });

  it('typeResolver: UDT, FB, sconosciuto', () => {
    const d = makeDevice();
    const r = typeResolver(d);
    expect(r('asse')).toMatchObject({ kind: 'udt' });
    const fb = r('Nastro');
    expect(fb).toMatchObject({ kind: 'fb', sections: { input: [], static: [{ name: 'Ax' }] } });
    expect(r('Main')).toBeNull();
    expect(r('toString')).toBeNull();
  });

  it('i membri ob1 sono in sola lettura', () => {
    expect(ob1(makeDevice()).interface.temp.every((x) => x.readOnly === true)).toBe(true);
  });
});
