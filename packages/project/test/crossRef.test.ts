import type { LadElem, LadNetwork, LadOut } from '@baaportal/ladfbd';
import { describe, expect, it } from 'vitest';
import {
  callGraph,
  createCodeBlock,
  createInstanceDb,
  crossReferences,
  createGlobalDb,
  type CodeBlock,
  type Language,
  type PlcDevice,
  type XrefOperand,
  xrefOperandAt,
} from '../src/index';
import { makeDevice, seq } from './fixtures';

let n = 0;
const id = (p: string) => `${p}${++n}`;
const contact = (op: string): LadElem => ({ id: id('c'), k: 'contact', neg: false, op });
const coil = (op: string): LadOut => ({ id: id('o'), k: 'coil', op });
const lad = (series: LadElem[], outs: LadOut[]): LadNetwork => ({
  root: { id: id('N'), series, outs },
});
const member = (name: string, type: string) => ({ id: id('m'), name, type, comment: '' });

function code(
  dev: PlcDevice,
  kind: 'OB' | 'FB' | 'FC',
  number: number,
  name: string,
  language: Language,
  sources: string[] = [''],
): CodeBlock {
  const b = createCodeBlock({ kind, number, name, language, newId: () => id('b') });
  b.networks = sources.map((source) => ({ id: id('n'), title: '', comment: '', source }));
  dev.blocks.push(b);
  return b;
}

const OB1 = [
  `A "Start"
AN I 0.1
= Q 4.0
S M 10.3
R "Motore"
L MW 10
T MB 11
FP M 20.0`,
  `A "Start"
SD T 5
A I 0.2
R T 5
A "Ritardo"
L "Dati".Vel
T DB1.DBW 2
OPN "Dati"
L MW [MD 50]
CALL "Calc"
(IN1 := M 30.0,
 OUT1 := Q 5.0,
 IO1 := MW 40)
CALL FB 2 , DB 3
UC FC 3`,
];

function fixture() {
  const dev = makeDevice(seq('x'));
  dev.blocks.length = 0;
  const tags = dev.tagTables[0]!.tags;
  tags.push(
    { id: 't1', name: 'Motore', type: 'Bool', address: '%Q4.1', hmi: false, comment: '' },
    { id: 't2', name: 'Livello', type: 'Int', address: '%MW10', hmi: false, comment: '' },
    { id: 't3', name: 'Ritardo', type: 'Timer', address: '%T5', hmi: false, comment: '' },
  );
  const db = createGlobalDb({ number: 1, name: 'Dati', newId: () => id('d') });
  db.members.push(member('Vuoto', 'Int'), member('Vel', 'Int'));
  dev.blocks.push(db);
  const ob = code(dev, 'OB', 1, 'Main', 'AWL', OB1);
  const calc = code(dev, 'FC', 1, 'Calc', 'KOP');
  calc.interface.input.push(member('IN1', 'Bool'));
  calc.interface.output.push(member('OUT1', 'Bool'));
  calc.interface.inOut.push(member('IO1', 'Int'));
  calc.networks[0]!.lad = lad([contact('"Start"')], [coil('"Motore"')]);
  const fup = code(dev, 'FC', 6, 'Porta', 'FUP');
  fup.networks[0]!.lad = lad([contact('I 0.2')], [coil('M 10.3')]);
  const fb = code(dev, 'FB', 2, 'Nastro', 'SCL', ['"Motore" := "Start";\n"Dati".Vel := 7;']);
  dev.blocks.push(
    createInstanceDb({ number: 3, name: 'Nastro_DB', instanceOf: 'Nastro', newId: () => id('i') }),
  );
  code(dev, 'FC', 3, 'Su', 'AWL', ['CALL FC 4']);
  code(dev, 'FC', 4, 'Giu', 'AWL', ['CALL FC 3']);
  code(dev, 'FC', 9, 'Orfano', 'AWL', ['NOP 0']);
  return { dev, ob, calc, fup, fb };
}

const find = (xs: XrefOperand[], address: string) => {
  const x = xs.find((o) => o.address === address);
  if (!x) throw new Error(`manca ${address}: ${xs.map((o) => o.address).join(', ')}`);
  return x;
};
const accesses = (x: XrefOperand, block?: string) =>
  x.uses.filter((u) => !block || u.block === block).map((u) => `${u.instruction}:${u.access}`);

describe('crossReferences', () => {
  it('AWL: lettura, scrittura, S/R, L/T e fronti', () => {
    const { dev } = fixture();
    const xs = crossReferences(dev);
    expect(accesses(find(xs, '%I0.1'))).toEqual(['AN:read']);
    expect(accesses(find(xs, '%Q4.0'))).toEqual(['=:write']);
    expect(accesses(find(xs, '%M10.3'), 'OB1')).toEqual(['S:write']);
    expect(accesses(find(xs, '%MB11'))).toEqual(['T:write']);
    expect(accesses(find(xs, '%M20.0'))).toEqual(['FP:readWrite']);
    const mw10 = find(xs, '%MW10');
    expect(accesses(mw10)).toEqual(['L:read']);
    expect(mw10.symbol).toBe('"Livello"');
    expect(mw10.type).toBe('Int');
    const u = find(xs, '%I0.1').uses[0]!;
    expect(u).toMatchObject({ block: 'OB1', language: 'AWL', network: 1, line: 2 });
  });

  it('simbolo e indirizzo assoluto sono la stessa voce', () => {
    const { dev } = fixture();
    const xs = crossReferences(dev);
    const start = find(xs, '%I0.0');
    expect(start.symbol).toBe('"Start"');
    expect(start.uses.map((u) => u.block)).toEqual(['OB1', 'OB1', 'FC1', 'FB2']);
    const motore = find(xs, '%Q4.1');
    expect(accesses(motore)).toEqual(['R:write', '=:write', '=:write']);
  });

  it('temporizzatori: avvio e reset scrivono, A legge (anche col simbolo)', () => {
    const { dev } = fixture();
    const t5 = find(crossReferences(dev), '%T5');
    expect(t5.symbol).toBe('"Ritardo"');
    expect(accesses(t5)).toEqual(['SD:write', 'R:write', 'A:read']);
  });

  it('membri di DB, DB assoluto, OPN e puntatore indiretto', () => {
    const { dev } = fixture();
    const xs = crossReferences(dev);
    const vel = find(xs, '%DB1.DBW2');
    expect(vel.symbol).toBe('"Dati".Vel');
    expect(accesses(vel)).toEqual(['L:read', 'T:write', 'T:write']);
    expect(accesses(find(xs, 'DB1'))).toEqual(['OPN:open']);
    expect(find(xs, 'DB1').symbol).toBe('Dati');
    expect(accesses(find(xs, '%MD50'))).toEqual(['L:read']);
  });

  it('CALL: i parametri attuali secondo la direzione, il DB di istanza', () => {
    const { dev } = fixture();
    const xs = crossReferences(dev);
    expect(accesses(find(xs, '%M30.0'))).toEqual(['CALL:read']);
    expect(accesses(find(xs, '%Q5.0'))).toEqual(['CALL:write']);
    expect(accesses(find(xs, '%MW40'))).toEqual(['CALL:readWrite']);
    expect(find(xs, '%MW40').uses[0]!.line).toBe(13);
    const fc1 = find(xs, 'FC1');
    expect(fc1.symbol).toBe('Calc');
    expect(accesses(fc1)).toEqual(['CALL:call']);
    expect(find(xs, 'FB2').uses[0]!.instance).toBe('DB 3');
    expect(accesses(find(xs, 'DB3'))).toEqual(['CALL:call']);
    expect(accesses(find(xs, 'FC3'))).toEqual(['UC:call', 'CALL:call']);
  });

  it('KOP e FUP: la riga porta all elemento; SCL: alla riga SCL', () => {
    const { dev, calc, fup } = fixture();
    const xs = crossReferences(dev);
    const kop = find(xs, '%I0.0').uses.find((u) => u.block === 'FC1')!;
    expect(kop.language).toBe('KOP');
    expect(kop.elemId).toBe((calc.networks[0]!.lad!.root.series[0] as { id: string }).id);
    const fupUse = find(xs, '%M10.3').uses.find((u) => u.block === 'FC6')!;
    expect(fupUse).toMatchObject({ language: 'FUP', access: 'write' });
    expect(fupUse.elemId).toBe(fup.networks[0]!.lad!.root.outs[0]!.id);
    const scl = find(xs, '%DB1.DBW2').uses.find((u) => u.block === 'FB2')!;
    expect(scl).toMatchObject({ language: 'SCL', network: 1, line: 2, access: 'write' });
    expect(find(xs, '%I0.0').uses.find((u) => u.block === 'FB2')!).toMatchObject({
      line: 1,
      access: 'read',
    });
  });

  it('accessi sovrapposti: MW10 con M10.3 e MB11, non con MW40', () => {
    const { dev } = fixture();
    const xs = crossReferences(dev);
    expect(find(xs, '%MW10').overlaps.sort()).toEqual(['%M10.3', '%MB11']);
    expect(find(xs, '%M10.3').overlaps).toEqual(['%MW10']);
    expect(find(xs, '%MW40').overlaps).toEqual([]);
  });

  it('un simbolo sconosciuto resta col testo scritto', () => {
    const { dev, ob } = fixture();
    ob.networks[0]!.source += '\nA "Manca"';
    expect(find(crossReferences(dev), '"Manca"').kind).toBe('unknown');
  });
});

describe('callGraph', () => {
  it('radici, chiamate in ordine, dipendenze, ricorsione e blocchi non usati', () => {
    const { dev } = fixture();
    const g = callGraph(dev);
    expect(g.roots).toEqual(['OB1']);
    expect(g.calls.get('OB1')!.map((e) => e.callee)).toEqual(['FC1', 'FB2', 'FC3']);
    expect(g.calls.get('OB1')![1]!.use.instance).toBe('DB 3');
    expect(g.callers.get('FC3')!.map((e) => e.caller)).toEqual(['OB1', 'FC4']);
    expect([...g.recursive].sort()).toEqual(['FC3', 'FC4']);
    expect(g.unreferenced).toEqual(['FC6', 'FC9']);
    expect(g.blocks.get('FC1')).toMatchObject({ name: 'Calc' });
  });

  it('multi-istanza e blocchi di sistema', () => {
    const { dev } = fixture();
    const fb5 = code(dev, 'FB', 5, 'Linea', 'AWL', [
      'CALL #N\nCALL SFC 20\n(SRCBLK := P#M 0.0 BYTE 2, RET_VAL := MW 60, DSTBLK := P#M 4.0 BYTE 2)',
    ]);
    fb5.interface.static.push(member('N', '"Nastro"'));
    const xs = crossReferences(dev);
    const fb2 = find(xs, 'FB2');
    expect(fb2.uses.find((u) => u.block === 'FB5')!.instance).toBe('#N');
    expect(accesses(find(xs, '%MW60'))).toEqual(['CALL:write']);
    const g = callGraph(dev, xs);
    expect(g.calls.get('FB5')!.map((e) => e.callee)).toEqual(['FB2', 'SFC20']);
    expect(g.blocks.get('SFC20')!.blockId).toBeUndefined();
  });
});

describe('xrefOperandAt', () => {
  it('l operando sotto il cursore col nome della sua voce, anche in tedesco', () => {
    const { dev, ob } = fixture();
    expect(xrefOperandAt(dev, ob.id, 'U E 0.0', 4, 'german')).toBe('%I0.0');
    expect(xrefOperandAt(dev, ob.id, 'A "Ritardo"', 5, 'international')).toBe('%T5');
    expect(xrefOperandAt(dev, ob.id, 'L "Dati".Vel', 3, 'international')).toBe('%DB1.DBW2');
    expect(xrefOperandAt(dev, ob.id, 'NOT', 1, 'international')).toBeUndefined();
  });
});
