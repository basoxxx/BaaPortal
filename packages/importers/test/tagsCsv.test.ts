import { describe, expect, it } from 'vitest';
import type { Tag, TagTable } from '@baaportal/project';
import { TAG_COLUMNS, fromLogicalAddress, parseTagsCsv, tagsToCsv, toLogicalAddress } from '../src';

const tag = (name: string, type: string, address: string, comment = '', hmi = true): Tag => ({
  id: name,
  name,
  type,
  address,
  hmi,
  comment,
});
const table = (tags: Tag[]): TagTable => ({
  id: 't',
  name: 'Tabella 1',
  group: '',
  tags,
  constants: [],
});

describe('tabelle variabili csv', () => {
  it('tagsToCsv: BOM, intestazione TAG_COLUMNS, separatore ";", CRLF, indirizzo %MW10', () => {
    const csv = tagsToCsv(table([tag('Contatore', 'Int', '%MW10', 'ciao')]));
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe(TAG_COLUMNS.join(';'));
    expect(lines[1]).toBe('Contatore;Tabella 1;Int;%MW10;ciao;True;True;True');
    expect(lines[2]).toBe('');
    expect(csv.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });

  it('roundtrip tagsToCsv → parseTagsCsv su BOOL/INT/REAL/WORD con commenti contenenti ";" e virgolette', () => {
    const tags = [
      tag('A', 'Bool', '%I0.0', 'a;b'),
      tag('B', 'Int', '%MW10', 'dice "ciao"', false),
      tag('C', 'Real', '%MD20', ''),
      tag('D', 'Word', '%MW30', 'x;"y"'),
    ];
    const parsed = parseTagsCsv(tagsToCsv(table(tags)));
    expect(parsed.errors).toEqual([]);
    expect(
      parsed.tags.map(({ name, type, address, comment, hmi, path }) => ({
        name,
        type,
        address,
        comment,
        hmi,
        path,
      })),
    ).toEqual(
      tags.map((t) => ({
        name: t.name,
        type: t.type,
        address: t.address,
        comment: t.comment,
        hmi: t.hmi,
        path: 'Tabella 1',
      })),
    );
  });

  it('csv di Excel con "," e LF, colonne in ordine diverso e "Typeobject ID" in più → letto giusto', () => {
    const csv =
      'logical address,Name,Typeobject ID,Data Type,Comment,Hmi Accessible\n' +
      '%M0.1,Start,xx,Bool,avvio,False\n' +
      'MW4,Livello,yy,Int,,True\n';
    const p = parseTagsCsv(csv);
    expect(p.errors).toEqual([]);
    expect(p.tags).toHaveLength(2);
    expect(p.tags[0]).toMatchObject({
      line: 2,
      name: 'Start',
      type: 'Bool',
      address: '%M0.1',
      comment: 'avvio',
      hmi: false,
    });
    expect(p.tags[1]).toMatchObject({
      line: 3,
      name: 'Livello',
      type: 'Int',
      address: '%MW4',
      hmi: true,
    });
  });

  it('campo tra virgolette con a capo dentro → un solo tag, commento con a capo', () => {
    const csv =
      'Name;Data Type;Logical Address;Comment\r\nA;Bool;%M0.0;"riga1\r\nriga2"\r\nB;Bool;%M0.1;x\r\n';
    const p = parseTagsCsv(csv);
    expect(p.errors).toEqual([]);
    expect(p.tags).toHaveLength(2);
    expect(p.tags[0]!.comment).toBe('riga1\r\nriga2');
    expect(p.tags[1]).toMatchObject({ name: 'B', line: 4 });
  });

  it('riga con tipo "PIPPO" → errors [{line:3, code:"TIPO_NON_VALIDO"}], le altre righe importate', () => {
    const csv = 'Name;Data Type;Logical Address\nA;Bool;%M0.0\nB;PIPPO;%M0.1\nC;Bool;%M0.2\n';
    const p = parseTagsCsv(csv);
    expect(p.errors).toEqual([{ line: 3, code: 'TIPO_NON_VALIDO', detail: 'PIPPO' }]);
    expect(p.tags.map((t) => t.name)).toEqual(['A', 'C']);
  });

  it('intestazione senza "Logical Address" → errors [{line:1, code:"COLONNA_MANCANTE"}], nessun tag', () => {
    const p = parseTagsCsv('Name;Data Type\nA;Bool\n');
    expect(p.errors).toEqual([{ line: 1, code: 'COLONNA_MANCANTE', detail: 'Logical Address' }]);
    expect(p.tags).toEqual([]);
  });

  it('nomi doppi nel file → secondo in errors con NOME_DOPPIO', () => {
    const p = parseTagsCsv('Name;Data Type;Logical Address\nA;Bool;%M0.0\nA;Bool;%M0.1\n');
    expect(p.tags).toHaveLength(1);
    expect(p.errors).toEqual([{ line: 3, code: 'NOME_DOPPIO', detail: 'A' }]);
  });

  it('fromLogicalAddress accetta "%M0.1" e "M0.1"; toLogicalAddress(fromLogicalAddress(x)) === x', () => {
    expect(fromLogicalAddress('%M0.1')).toBe('%M0.1');
    expect(fromLogicalAddress('M0.1')).toBe('%M0.1');
    for (const x of ['%I0.0', '%MW10', '%MD4', '%T3', '%QB1']) {
      expect(toLogicalAddress(fromLogicalAddress(x))).toBe(x);
    }
  });
});
