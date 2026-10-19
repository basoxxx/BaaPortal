import { describe, expect, it } from 'vitest';
import {
  addSource,
  createCodeBlock,
  createGlobalDb,
  createUdt,
  renameMemberWithOverrides,
  renameWithReferences,
  type CodeBlock,
  type PlcDevice,
} from '../src/index';
import { makeDevice, seq } from './fixtures';

const net = (b: CodeBlock, i = 0): string => b.networks[i]!.source;
const setCode = (b: CodeBlock, ...sources: string[]) => {
  b.language = 'AWL';
  b.networks = sources.map((source, i) => ({
    id: `${b.id}-n${i}`,
    title: '',
    comment: '',
    source,
  }));
};
const byName = (d: PlcDevice, name: string) => d.blocks.find((b) => b.name === name)!;
const code = (d: PlcDevice, name: string) => byName(d, name) as CodeBlock;

describe('rinomina nel codice: tag e blocchi', () => {
  it('rinominare un tag aggiorna il codice di tutti i segmenti in un passo', () => {
    const d = makeDevice();
    const tag = d.tagTables[0]!.tags[0]!;
    setCode(code(d, 'Main'), 'A "Start"\n= "Stop"', 'AN "start" // "Start"');
    setCode(code(d, 'Nastro'), 'A "Start"');
    setCode(code(d, 'Linea'), 'A "Start1"\nO "Start"');
    const src = addSource(d, 'Ext.awl', 'A "Start"\n');
    renameWithReferences(
      d,
      { kind: 'tag', deviceId: d.id, tableId: d.tagTables[0]!.id, id: tag.id },
      'Avvio',
    );
    expect(net(code(d, 'Main'))).toBe('A "Avvio"\n= "Stop"');
    expect(net(code(d, 'Main'), 1)).toBe('AN "Avvio" // "Start"');
    expect(net(code(d, 'Nastro'))).toBe('A "Avvio"');
    expect(net(code(d, 'Linea'))).toBe('A "Start1"\nO "Avvio"');
    // le sorgenti esterne sono file indipendenti
    expect(src.text).toBe('A "Start"\n');
  });

  it('una costante si rinomina come un tag', () => {
    const d = makeDevice();
    const c = d.tagTables[0]!.constants[0]!;
    setCode(code(d, 'Main'), 'L "Max"');
    renameWithReferences(
      d,
      { kind: 'constant', deviceId: d.id, tableId: d.tagTables[0]!.id, id: c.id },
      'Massimo',
    );
    expect(net(code(d, 'Main'))).toBe('L "Massimo"');
  });

  it('rinominare un blocco o un DB aggiorna CALL, apertura e DB simbolico', () => {
    const d = makeDevice();
    setCode(
      code(d, 'Main'),
      'CALL "Nastro", "Nastro_DB"\nOPN "Dati"\nL "Dati".DBW 4\nL "Dati".A.Pos.X',
    );
    renameWithReferences(d, { kind: 'block', deviceId: d.id, id: byName(d, 'Nastro').id }, 'Rullo');
    renameWithReferences(
      d,
      { kind: 'block', deviceId: d.id, id: byName(d, 'Dati').id },
      'Parametri',
    );
    renameWithReferences(
      d,
      { kind: 'block', deviceId: d.id, id: byName(d, 'Nastro_DB').id },
      'Rullo_DB',
    );
    expect(net(code(d, 'Main'))).toBe(
      'CALL "Rullo", "Rullo_DB"\nOPN "Parametri"\nL "Parametri".DBW 4\nL "Parametri".A.Pos.X',
    );
  });

  it('un nome non valido non tocca il codice', () => {
    const d = makeDevice();
    const tag = d.tagTables[0]!.tags[0]!;
    setCode(code(d, 'Main'), 'A "Start"');
    renameWithReferences(
      d,
      { kind: 'tag', deviceId: d.id, tableId: d.tagTables[0]!.id, id: tag.id },
      'a"b',
    );
    expect(net(code(d, 'Main'))).toBe('A "Start"');
  });
});

describe('rinomina nel codice: parametri di FB', () => {
  function fbDevice() {
    const d = makeDevice();
    const fb = code(d, 'Nastro');
    fb.interface.input.push({ id: 'p-vel', name: 'Vel', type: 'Int', comment: '' });
    fb.interface.static.push({ id: 'p-cnt', name: 'Cnt', type: 'Int', comment: '' });
    setCode(fb, 'L #Vel\nT #Cnt');
    // Linea ha la multi-istanza N di tipo Nastro
    setCode(
      code(d, 'Linea'),
      'CALL "Nastro", "Nastro_DB"\n(Vel := 5)',
      'CALL FB 1, DB 2\n(Vel := 6)',
      'CALL #N\n(Vel := 7)\nL #N.Cnt',
      'CALL "Altro"\n(Vel := 8)',
    );
    setCode(code(d, 'Main'), 'L "Nastro_DB".Vel\nL "Nastro_DB".Cnt\nL "Dati".A.Pos.X');
    return d;
  }
  const ref = (d: PlcDevice, memberId: string) => ({
    kind: 'member' as const,
    deviceId: d.id,
    ownerKind: 'block' as const,
    ownerId: byName(d, 'Nastro').id,
    memberId,
  });

  it('un parametro aggiorna i CALL dei chiamanti, #param nell FB e l istanza', () => {
    const d = fbDevice();
    renameWithReferences(d, ref(d, 'p-vel'), 'Velocita');
    expect(net(code(d, 'Nastro'))).toBe('L #Velocita\nT #Cnt');
    const linea = code(d, 'Linea');
    expect(net(linea, 0)).toBe('CALL "Nastro", "Nastro_DB"\n(Velocita := 5)');
    expect(net(linea, 1)).toBe('CALL FB 1, DB 2\n(Velocita := 6)');
    expect(net(linea, 2)).toBe('CALL #N\n(Velocita := 7)\nL #N.Cnt');
    expect(net(linea, 3)).toBe('CALL "Altro"\n(Vel := 8)');
    expect(net(code(d, 'Main'))).toBe(
      'L "Nastro_DB".Velocita\nL "Nastro_DB".Cnt\nL "Dati".A.Pos.X',
    );
    expect(code(d, 'Nastro').interface.input[0]!.name).toBe('Velocita');
  });

  it('un membro statico aggiorna il DB di istanza, #static e la multi-istanza', () => {
    const d = fbDevice();
    renameWithReferences(d, ref(d, 'p-cnt'), 'Conteggio');
    expect(net(code(d, 'Nastro'))).toBe('L #Vel\nT #Conteggio');
    expect(net(code(d, 'Linea'), 2)).toBe('CALL #N\n(Vel := 7)\nL #N.Conteggio');
    expect(net(code(d, 'Main'))).toBe(
      'L "Nastro_DB".Vel\nL "Nastro_DB".Conteggio\nL "Dati".A.Pos.X',
    );
  });
});

describe('rinomina nel codice: membri di DB, FC, OB', () => {
  it('membro di un DB globale: radice del DB e percorso giusto, anche con indici', () => {
    const d = makeDevice();
    const db = byName(d, 'Dati');
    if (db.kind !== 'DB') throw new Error();
    db.members.push({
      id: 'v',
      name: 'Assi',
      type: 'Struct',
      comment: '',
      members: [{ id: 'v-pos', name: 'Pos', type: 'Real', comment: '' }],
    });
    setCode(code(d, 'Main'), 'L "Dati".Assi.Pos\nL "Altro".Assi.Pos\nL "Dati".A.Pos.X');
    renameWithReferences(
      d,
      { kind: 'member', deviceId: d.id, ownerKind: 'block', ownerId: db.id, memberId: 'v-pos' },
      'Posizione',
    );
    expect(net(code(d, 'Main'))).toBe(
      'L "Dati".Assi.Posizione\nL "Altro".Assi.Pos\nL "Dati".A.Pos.X',
    );
  });

  it('membro di un FC: solo il locale di quel blocco, e i CALL con i suoi parametri', () => {
    const d = makeDevice();
    const fc = createCodeBlock({
      kind: 'FC',
      number: 1,
      name: 'Calcola',
      language: 'AWL',
      newId: seq('fc'),
    });
    fc.interface.input.push({ id: 'fc-a', name: 'A', type: 'Int', comment: '' });
    setCode(fc, 'L #A\nT #Tmp');
    d.blocks.push(fc);
    setCode(code(d, 'Main'), 'L #A\nCALL "Calcola"\n(A := 1)\nCALL FC 1\n(A := 2)');
    renameMemberWithOverrides(d, { kind: 'block', id: fc.id }, 'fc-a', 'Ingresso');
    expect(net(fc)).toBe('L #Ingresso\nT #Tmp');
    // #A nell OB1 e un altro locale
    expect(net(code(d, 'Main'))).toBe(
      'L #A\nCALL "Calcola"\n(Ingresso := 1)\nCALL FC 1\n(Ingresso := 2)',
    );
  });

  it('membro di un OB: locale solo in quell OB', () => {
    const d = makeDevice();
    const ob = code(d, 'Main');
    ob.interface.temp.push({ id: 't1', name: 'Tmp', type: 'Int', comment: '' });
    setCode(ob, 'L #Tmp');
    setCode(code(d, 'Linea'), 'L #Tmp');
    renameMemberWithOverrides(d, { kind: 'block', id: ob.id }, 't1', 'Appoggio');
    expect(net(ob)).toBe('L #Appoggio');
    expect(net(code(d, 'Linea'))).toBe('L #Tmp');
  });
});

describe('rinomina nel codice: membri di UDT', () => {
  function udtDevice() {
    const d = makeDevice();
    const asse = d.udts.find((u) => u.name === 'Asse')!;
    // un DB con un membro Pos non UDT, e un tag di tipo UDT
    const altro = createGlobalDb({ number: 5, name: 'Altro', newId: seq('x') });
    altro.members.push({
      id: 'alt-pos',
      name: 'Pos',
      type: 'Struct',
      comment: '',
      members: [{ id: 'alt-x', name: 'X', type: 'Real', comment: '' }],
    });
    const dati2 = createGlobalDb({ number: 6, name: 'Dati2', newId: seq('y') });
    dati2.members.push({
      id: 'd2-s',
      name: 'S',
      type: 'Struct',
      comment: '',
      members: [{ id: 'd2-a', name: 'Inner', type: '"Asse"', comment: '' }],
    });
    const assi = createUdt({ name: 'Assi3', number: 3, newId: seq('u') });
    assi.members.push({ id: 'as-l', name: 'Lista', type: 'Array[1..2] of "Asse"', comment: '' });
    d.udts.push(assi);
    const db3 = createGlobalDb({ number: 7, name: 'Dati3', newId: seq('z') });
    db3.members.push({ id: 'd3-g', name: 'G', type: '"Assi3"', comment: '' });
    d.blocks.push(altro, dati2, db3);
    d.tagTables[0]!.tags.push({
      id: 'tg',
      name: 'AsseTag',
      type: '"Asse"',
      address: '',
      hmi: false,
      comment: '',
    });
    const fbLoc = code(d, 'Linea');
    fbLoc.interface.temp.push({ id: 'loc', name: 'Loc', type: '"Asse"', comment: '' });
    setCode(
      code(d, 'Main'),
      [
        'L "Dati".A.Pos.X',
        'L "Altro".Pos.X',
        'L "AsseTag".Pos.X',
        'L "Nastro_DB".Ax.Pos.X',
        'L "Dati2".S.Inner.Pos.X',
        'L "Dati3".G.Lista[2].Pos.X',
        'L #Loc.Pos.X',
      ].join('\n'),
    );
    setCode(code(d, 'Nastro'), 'L #Ax.Pos.X');
    setCode(fbLoc, 'L #Loc.Pos.X\nL #N.Ax.Pos.X\nL #Loc.Pos');
    return { d, asse };
  }

  it('rinominare un membro di UDT tocca solo i percorsi di quel tipo', () => {
    const { d, asse } = udtDevice();
    const x = asse.members[0]!.members![0]!;
    renameMemberWithOverrides(d, { kind: 'udt', id: asse.id }, x.id, 'Quota');
    expect(net(code(d, 'Main')).split('\n')).toEqual([
      'L "Dati".A.Pos.Quota',
      'L "Altro".Pos.X',
      'L "AsseTag".Pos.Quota',
      'L "Nastro_DB".Ax.Pos.Quota',
      'L "Dati2".S.Inner.Pos.Quota',
      'L "Dati3".G.Lista[2].Pos.Quota',
      // #Loc e un locale di Linea, non di OB1
      'L #Loc.Pos.X',
    ]);
    expect(net(code(d, 'Nastro'))).toBe('L #Ax.Pos.Quota');
    expect(net(code(d, 'Linea'))).toBe('L #Loc.Pos.Quota\nL #N.Ax.Pos.Quota\nL #Loc.Pos');
    expect(x.name).toBe('Quota');
  });

  it('un membro di primo livello: Pos diventa Posizione solo dove il tipo e Asse', () => {
    const { d, asse } = udtDevice();
    renameMemberWithOverrides(d, { kind: 'udt', id: asse.id }, asse.members[0]!.id, 'Posizione');
    expect(net(code(d, 'Main')).split('\n').slice(0, 6)).toEqual([
      'L "Dati".A.Posizione.X',
      'L "Altro".Pos.X',
      'L "AsseTag".Posizione.X',
      'L "Nastro_DB".Ax.Posizione.X',
      'L "Dati2".S.Inner.Posizione.X',
      'L "Dati3".G.Lista[2].Posizione.X',
    ]);
    expect(net(code(d, 'Linea'))).toBe('L #Loc.Posizione.X\nL #N.Ax.Posizione.X\nL #Loc.Posizione');
  });

  it('tipo non risolvibile: il codice resta com e', () => {
    const { d, asse } = udtDevice();
    const db = byName(d, 'Dati');
    if (db.kind !== 'DB') throw new Error();
    db.members[0]!.type = '"Inesistente"';
    renameMemberWithOverrides(
      d,
      { kind: 'udt', id: asse.id },
      asse.members[0]!.members![0]!.id,
      'Quota',
    );
    expect(net(code(d, 'Main')).split('\n')[0]).toBe('L "Dati".A.Pos.X');
  });
});

describe('sorgenti esterne', () => {
  it('rinominare una sorgente cambia solo il nome, mai il testo', () => {
    const d = makeDevice();
    const s = addSource(d, 'Motori.awl', 'A "Start"\n');
    renameWithReferences(d, { kind: 'source', deviceId: d.id, id: s.id }, 'Pompe.awl');
    expect(d.sources[0]).toMatchObject({ name: 'Pompe.awl', text: 'A "Start"\n' });
  });

  it('i nomi di file nuovi sono unici nel dispositivo', () => {
    const d = makeDevice();
    addSource(d, 'Motori.awl', '');
    const b = addSource(d, 'motori.AWL', '');
    expect(b.name).toBe('motori_1.AWL');
  });
});

describe('rinomina nel codice: solo blocchi AWL', () => {
  it('un blocco SCL non si tocca, uno AWL dello stesso dispositivo si', () => {
    const d = makeDevice();
    const scl = 'IF "Start" THEN "Start".x := 1; END_IF;\nA "Start"\nL "Start".x';
    // Nastro e SCL nella fixture
    setCode(code(d, 'Nastro'), scl);
    code(d, 'Nastro').language = 'SCL';
    setCode(code(d, 'Linea'), 'A "Start"');
    const tag = d.tagTables[0]!.tags[0]!;
    renameWithReferences(
      d,
      { kind: 'tag', deviceId: d.id, tableId: d.tagTables[0]!.id, id: tag.id },
      'Avvio',
    );
    expect(net(code(d, 'Nastro'))).toBe(scl);
    expect(net(code(d, 'Linea'))).toBe('A "Avvio"');
  });
});
