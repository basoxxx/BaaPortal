import { findOb } from '@baaportal/catalog';
import { createCodeBlock, createUdt } from '@baaportal/project';
import { describe, expect, it } from 'vitest';
import { applySource, generateAwlSource, parseAwlSource, type SourceError } from '../src/index';
import { allRefs, emptyDevice, fixture, seq } from './helpers';

function errors(text: string, device?: Parameters<typeof parseAwlSource>[1]): SourceError[] {
  const r = parseAwlSource(text, device);
  if (r.ok) throw new Error('atteso un errore');
  return r.errors;
}
function ok(text: string) {
  const r = parseAwlSource(text);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.source;
}

describe('OB con numero', () => {
  it('generazione in forma assoluta: ORGANIZATION_BLOCK OB 35', () => {
    const d = emptyDevice();
    d.blocks.push(
      createCodeBlock({
        kind: 'OB',
        number: 35,
        name: 'Ciclico',
        language: 'AWL',
        newId: seq('g'),
      }),
    );
    const text = generateAwlSource(d, allRefs(d), 'international');
    expect(text).toContain('ORGANIZATION_BLOCK OB 35\n');
    expect(text).not.toContain('ORGANIZATION_BLOCK "');
  });

  it('un OB con numero e senza oggetto prende il nome del catalogo, o OB<n>', () => {
    const d = emptyDevice();
    applySource(
      d,
      ok(
        'ORGANIZATION_BLOCK OB 35\nBEGIN\nEND_ORGANIZATION_BLOCK\nORGANIZATION_BLOCK OB 9999\nBEGIN\nEND_ORGANIZATION_BLOCK\n',
      ),
      seq('n'),
    );
    expect(d.blocks.map((b) => [b.name, b.number])).toEqual([
      [findOb(35)!.defaultName, 35],
      ['OB9999', 9999],
    ]);
  });

  it('un OB con nome sconosciuto e senza corrispondenza: OB_NUMBER_UNKNOWN sulla riga di intestazione', () => {
    const e = errors('\nORGANIZATION_BLOCK "Pippo"\nBEGIN\nEND_ORGANIZATION_BLOCK\n');
    expect(e).toEqual([expect.objectContaining({ code: 'OB_NUMBER_UNKNOWN', line: 2 })]);
  });

  it('un OB con nome del catalogo prende il numero del catalogo', () => {
    const name = findOb(35)!.defaultName;
    const d = emptyDevice();
    applySource(d, ok(`ORGANIZATION_BLOCK "${name}"\nBEGIN\nEND_ORGANIZATION_BLOCK\n`), seq('n'));
    expect(d.blocks[0]).toMatchObject({ number: 35, name });
  });

  it('un OB con nome gia presente nel dispositivo si accetta e sostituisce', () => {
    const d = emptyDevice();
    d.blocks.push(
      createCodeBlock({ kind: 'OB', number: 40, name: 'Mio', language: 'AWL', newId: seq('o') }),
    );
    const r = parseAwlSource('ORGANIZATION_BLOCK "mio"\nBEGIN\nEND_ORGANIZATION_BLOCK\n', d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    applySource(d, r.source, seq('n'));
    expect(d.blocks).toHaveLength(1);
    expect(d.blocks[0]).toMatchObject({ number: 40, name: 'mio' });
  });
});

describe('sezioni S7-1x00', () => {
  it('VAR RETAIN e VAR CONSTANT: UNSUPPORTED_SECTION sulla riga', () => {
    const e = errors(
      'FUNCTION_BLOCK "A"\nVAR RETAIN\n  x : Int;\nEND_VAR\nVAR CONSTANT\n  y : Int := 1;\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n',
    );
    expect(e.map((x) => [x.code, x.line])).toEqual([
      ['UNSUPPORTED_SECTION', 2],
      ['UNSUPPORTED_SECTION', 5],
    ]);
  });

  it('DB globale con VAR ... END_VAR: un solo errore chiaro, nessun BAD_ASSIGNMENT', () => {
    const e = errors(
      'DATA_BLOCK "D"\n{ S7_Optimized_Access := \'TRUE\' }\nVERSION : 0.1\nNON_RETAIN\nVAR\n  x : Int;\nEND_VAR\nBEGIN\n  x := 1;\nEND_DATA_BLOCK\n',
    );
    expect(e).toEqual([expect.objectContaining({ code: 'UNSUPPORTED_SECTION', line: 5 })]);
  });
});

describe('titolo e nome degli UDT', () => {
  it('TITLE e NAME si conservano e si riscrivono nella posizione dei blocchi', () => {
    const text =
      'TYPE "T"\nTITLE = Titolo\n// commento\nAUTHOR : Io\nFAMILY : Fam\nNAME : Nm\nVERSION : 0.2\n\nSTRUCT\n  a : Int;\nEND_STRUCT;\n\nEND_TYPE\n';
    const s = ok(text);
    const u = s.units[0]!;
    if (u.kind !== 'UDT') throw new Error();
    expect(u.udt).toMatchObject({ title: 'Titolo', headerName: 'Nm', comment: 'commento' });
    const d = emptyDevice();
    applySource(d, s, seq('n'));
    expect(d.udts[0]).toMatchObject({ title: 'Titolo', headerName: 'Nm', comment: 'commento' });
    expect(generateAwlSource(d, allRefs(d), 'international')).toBe(text);
  });

  it('createUdt: titolo e nome vuoti', () => {
    expect(createUdt({ name: 'A', number: 1 })).toMatchObject({ title: '', headerName: '' });
  });
});

describe('spazi prima delle parole chiave e MISSING_END', () => {
  it('parole chiave di unita e di fine rientrate', () => {
    const s = ok(
      '\tFUNCTION_BLOCK "A"\n\tBEGIN\n\tNETWORK\n\tTITLE =\n\t\tNOP 0;\n\tEND_FUNCTION_BLOCK\n\n  TYPE "U"\n  STRUCT\n  END_STRUCT;\n  END_TYPE\n',
    );
    expect(s.units.map((u) => u.name)).toEqual(['A', 'U']);
  });

  it('MISSING_END alla riga dell unita seguente', () => {
    const e = errors(
      'FUNCTION "A" : Void\nBEGIN\nNETWORK\nTITLE =\n\nFUNCTION "B" : Void\nBEGIN\nEND_FUNCTION\n',
    );
    expect(e).toEqual([expect.objectContaining({ code: 'MISSING_END', line: 6, col: 1 })]);
  });

  it('MISSING_END a fine file', () => {
    const e = errors('FUNCTION "A" : Void\nBEGIN\nNETWORK\nTITLE =\n');
    expect(e).toEqual([expect.objectContaining({ code: 'MISSING_END', line: 5 })]);
  });

  it('i fixture di OB restano validi', () => {
    expect(parseAwlSource(fixture('ob1.awl')).ok).toBe(true);
  });
});

describe('OB con nome di catalogo e numeri doppi', () => {
  const dupes = (d: ReturnType<typeof emptyDevice>): string[] => {
    const fam = (k: string) => (k === 'IDB' ? 'DB' : k);
    const keys = [
      ...d.blocks.map((b) => `${fam(b.kind)}${b.number}`),
      ...d.udts.map((u) => `UDT${u.number}`),
    ];
    return keys.filter((k, i) => keys.indexOf(k) !== i);
  };

  it('un OB con nome di catalogo sostituisce l OB esistente con quel numero e ne tiene il nome', () => {
    const d = emptyDevice();
    const old = createCodeBlock({
      kind: 'OB',
      number: 1,
      name: 'Zyx',
      language: 'AWL',
      newId: seq('o'),
    });
    old.group = 'G';
    d.blocks.push(old);
    const r = parseAwlSource('ORGANIZATION_BLOCK "Main"\nBEGIN\nEND_ORGANIZATION_BLOCK\n', d);
    if (!r.ok) throw new Error();
    const res = applySource(d, r.source, seq('n'));
    expect(d.blocks).toHaveLength(1);
    expect(d.blocks[0]).toMatchObject({ id: old.id, group: 'G', number: 1, name: 'Zyx' });
    expect(res.replaced).toEqual([{ kind: 'block', deviceId: d.id, id: old.id }]);
    expect(res.created).toEqual([]);
  });

  it('nessun numero doppio con nomi e numeri che collidono con oggetti esistenti', () => {
    const d = emptyDevice();
    const mk = (kind: 'OB' | 'FB' | 'FC', number: number, name: string) =>
      createCodeBlock({ kind, number, name, language: 'AWL', newId: seq(`o${kind}${number}`) });
    d.blocks.push(mk('OB', 1, 'Zyx'), mk('FB', 5, 'Altro'), mk('FC', 2, 'Calc'));
    d.udts.push(createUdt({ name: 'U3', number: 3, newId: seq('u') }));
    const text = [
      'ORGANIZATION_BLOCK "Main"\nBEGIN\nEND_ORGANIZATION_BLOCK',
      'ORGANIZATION_BLOCK OB 1\nBEGIN\nEND_ORGANIZATION_BLOCK',
      'FUNCTION_BLOCK FB 5\nBEGIN\nEND_FUNCTION_BLOCK',
      'FUNCTION_BLOCK "Nuovo"\nBEGIN\nEND_FUNCTION_BLOCK',
      'FUNCTION FC 2 : Void\nBEGIN\nEND_FUNCTION',
      'FUNCTION "Calc" : Void\nBEGIN\nEND_FUNCTION',
      'TYPE UDT 3\nSTRUCT\nEND_STRUCT;\nEND_TYPE',
      'TYPE "U3"\nSTRUCT\nEND_STRUCT;\nEND_TYPE',
      'DATA_BLOCK DB 7\nFB 5\nBEGIN\nEND_DATA_BLOCK',
      'DATA_BLOCK "D7"\nSTRUCT\nEND_STRUCT;\nBEGIN\nEND_DATA_BLOCK',
      'DATA_BLOCK "I"\n"Nuovo"\nBEGIN\nEND_DATA_BLOCK',
    ].join('\n\n');
    const r = parseAwlSource(text, d);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    applySource(d, r.source, seq('n'));
    expect(dupes(d)).toEqual([]);
    expect(d.blocks.filter((b) => b.kind === 'OB')).toHaveLength(1);
  });
});
