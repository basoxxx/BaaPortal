import { describe, expect, it } from 'vitest';
import type { Tag, TagTable } from '@baaportal/project';
import {
  TAG_COLUMNS,
  constantsToCsv,
  fromLogicalAddress,
  parseTagsCsv,
  tagsToCsv,
  toLogicalAddress,
} from '../src';

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
  it('formule: =, +, -, @, tab e CR iniziali si esportano con un apice e si rileggono identici', () => {
    const comments = [
      '=1+1',
      '+SUM(A1)',
      '-2',
      '@cmd',
      '\tx',
      '\rx',
      "'=già",
      "''-x",
      "'ciao",
      'a=b',
    ];
    const tags = comments.map((c, i) => tag(`V${i}`, 'Int', `%MW${i * 2}`, c));
    const csv = tagsToCsv(table(tags));
    const lines = csv.slice(1).split('\r\n');
    expect(lines[1]).toBe("V0;Tabella 1;Int;%MW0;'=1+1;True;True;True");
    expect(lines[7]).toBe("V6;Tabella 1;Int;%MW12;''=già;True;True;True");
    expect(lines[9]).toBe("V8;Tabella 1;Int;%MW16;'ciao;True;True;True");
    expect(lines[10]).toBe('V9;Tabella 1;Int;%MW18;a=b;True;True;True');
    const parsed = parseTagsCsv(csv);
    expect(parsed.errors).toEqual([]);
    expect(parsed.tags.map((t) => t.comment)).toEqual(comments);
  });

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

  it('separatore tab', () => {
    const p = parseTagsCsv('Name\tData Type\tLogical Address\nA\tBool\t%M0.0\n');
    expect(p.errors).toEqual([]);
    expect(p.tags.map((t) => t.name)).toEqual(['A']);
  });

  it('BOM su file con ","', () => {
    const p = parseTagsCsv('\ufeffName,Data Type,Logical Address\nA,Bool,%M0.0\n');
    expect(p.errors).toEqual([]);
    expect(p.tags).toHaveLength(1);
  });

  it('ultima riga senza a capo finale', () => {
    const p = parseTagsCsv('Name;Data Type;Logical Address\nA;Bool;%M0.0\nB;Int;%MW2');
    expect(p.errors).toEqual([]);
    expect(p.tags.map((t) => t.name)).toEqual(['A', 'B']);
  });

  it('riga vuota nel mezzo ignorata, i numeri di riga restano quelli del file', () => {
    const p = parseTagsCsv('Name;Data Type;Logical Address\nA;Bool;%M0.0\n\nB;Int;%MW2\n');
    expect(p.errors).toEqual([]);
    expect(p.tags.map((t) => [t.name, t.line])).toEqual([
      ['A', 2],
      ['B', 4],
    ]);
  });

  it('campo tra virgolette con ";" in importazione', () => {
    const p = parseTagsCsv('Name;Data Type;Logical Address;Comment\nA;Bool;%M0.0;"uno;due"\n');
    expect(p.errors).toEqual([]);
    expect(p.tags[0]!.comment).toBe('uno;due');
  });

  it('RIGA_ILLEGGIBILE con virgolette non chiuse; le righe prima restano', () => {
    const p = parseTagsCsv(
      'Name;Data Type;Logical Address;Comment\nA;Bool;%M0.0;x\nB;Bool;%M0.1;"aperta\n',
    );
    expect(p.tags.map((t) => t.name)).toEqual(['A']);
    expect(p.errors).toEqual([{ line: 3, code: 'RIGA_ILLEGGIBILE' }]);
  });

  it('virgolette non chiuse: errore sulla riga, le righe dopo si leggono', () => {
    const p = parseTagsCsv(
      'Name;Data Type;Logical Address;Comment\nA;Bool;%M0.0;"aperta\nB;Bool;%M0.1;x\nC;Bool;%M0.2;y\n',
    );
    expect(p.tags.map((t) => t.name)).toEqual(['B', 'C']);
    expect(p.errors).toEqual([{ line: 2, code: 'RIGA_ILLEGGIBILE' }]);
  });

  it('costanti in un csv a parte: si esportano e si riconoscono', () => {
    const t = {
      ...table([]),
      constants: [{ id: 'c', name: 'Max', type: 'Int', value: '100', comment: 'x' }],
    };
    const p = parseTagsCsv(constantsToCsv(t));
    expect(p.tags).toEqual([]);
    expect(p.constants).toMatchObject([{ name: 'Max', type: 'Int', value: '100', comment: 'x' }]);
    expect(p.errors).toEqual([]);
  });

  it('NOME_VUOTO', () => {
    const p = parseTagsCsv('Name;Data Type;Logical Address\n;Bool;%M0.0\n');
    expect(p.errors).toEqual([{ line: 2, code: 'NOME_VUOTO' }]);
  });

  it('INDIRIZZO_NON_VALIDO (anche indirizzo incompatibile col tipo)', () => {
    const p = parseTagsCsv('Name;Data Type;Logical Address\nA;Bool;%Zeta\nB;Int;%M0.0\n');
    expect(p.errors).toEqual([
      { line: 2, code: 'INDIRIZZO_NON_VALIDO', detail: '%Zeta' },
      { line: 3, code: 'INDIRIZZO_NON_VALIDO', detail: '%M0.0' },
    ]);
  });

  it('record con tutte le celle vuote (";;;") ignorato, nessun NOME_VUOTO', () => {
    const p = parseTagsCsv('Name;Data Type;Logical Address\nA;Bool;%M0.0\n;;\n ; ;\n');
    expect(p.errors).toEqual([]);
    expect(p.tags).toHaveLength(1);
  });
});
