import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { XlsxFormatError, readXlsx, writeXlsx } from '../src';

const zip = (files: Record<string, string>): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

const workbook = (sheets: string, rels: string): Record<string, string> => ({
  '[Content_Types].xml':
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets}</sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
});

describe('ooxml minimo', () => {
  it('writeXlsx → readXlsx roundtrip con <, &, accenti, a capo', () => {
    const sheets = [
      {
        name: 'Uno',
        rows: [
          ['a<b', 'x & y', 'perché è così'],
          ['riga1\nriga2', '', ' spazi '],
        ],
      },
      { name: 'Due', rows: [['"q"', "it's", '>']] },
    ];
    expect(readXlsx(writeXlsx(sheets))).toEqual(sheets);
  });

  it('legge sharedStrings con testo ricco e celle numeriche 10 / 2.5 / booleane', () => {
    const bytes = zip({
      ...workbook(
        '<sheet name="Foglio A" sheetId="1" r:id="rId7"/>',
        '<Relationship Id="rId7" Type="x" Target="worksheets/dati.xml"/>',
      ),
      'xl/sharedStrings.xml':
        '<sst><si><t>semplice</t></si><si><r><t xml:space="preserve">ric</t></r><r><rPr><b/></rPr><t>co &amp; &#65;&#x42;</t></r></si></sst>',
      'xl/worksheets/dati.xml':
        '<worksheet><sheetData><row r="1">' +
        '<c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>' +
        '<c r="C1"><v>10</v></c><c r="D1"><v>2.5</v></c><c r="E1"><v>3.0</v></c>' +
        '<c r="F1" t="b"><v>1</v></c><c r="G1" t="b"><v>0</v></c>' +
        '<c r="H1" t="inlineStr"><is><t>in linea</t></is></c></row></sheetData></worksheet>',
    });
    expect(readXlsx(bytes)).toEqual([
      {
        name: 'Foglio A',
        rows: [['semplice', 'ricco & AB', '10', '2.5', '3', 'True', 'False', 'in linea']],
      },
    ]);
  });

  it('celle saltate (A1, C1) → riga ["x","","z"]', () => {
    const bytes = zip({
      ...workbook(
        '<sheet name="S" r:id="rId1"/>',
        '<Relationship Id="rId1" Target="/xl/worksheets/sheet1.xml"/>',
      ),
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c><c r="C1" t="inlineStr"><is><t>z</t></is></c></row><row r="3"><c r="B3" t="inlineStr"><is><t>q</t></is></c></row></sheetData></worksheet>',
    });
    expect(readXlsx(bytes)[0]!.rows).toEqual([['x', '', 'z'], [], ['', 'q']]);
  });

  it('byte non zip → XlsxFormatError NON_ZIP; zip senza workbook → NON_XLSX', () => {
    const notZip = (): unknown => readXlsx(strToU8('questo non è uno zip'));
    expect(notZip).toThrow(XlsxFormatError);
    expect(notZip).toThrow(expect.objectContaining({ code: 'NON_ZIP' }));
    const noBook = (): unknown => readXlsx(zip({ 'a.txt': 'ciao' }));
    expect(noBook).toThrow(expect.objectContaining({ code: 'NON_XLSX' }));
  });

  it('foglio mancante o XML rotto → FOGLIO_ILLEGGIBILE', () => {
    const bytes = zip(
      workbook(
        '<sheet name="S" r:id="rId1"/>',
        '<Relationship Id="rId1" Target="worksheets/s.xml"/>',
      ),
    );
    expect(() => readXlsx(bytes)).toThrow(expect.objectContaining({ code: 'FOGLIO_ILLEGGIBILE' }));
  });

  const sheetZip = (sheetXml: string): Uint8Array =>
    zip({
      ...workbook(
        '<sheet name="S" r:id="rId1"/>',
        '<Relationship Id="rId1" Target="worksheets/s.xml"/>',
      ),
      'xl/worksheets/s.xml': sheetXml,
    });

  it('tag con prefisso x:, CDATA, <c/> autochiusa, colonna AA e xml:space', () => {
    const bytes = sheetZip(
      '<x:worksheet xmlns:x="urn:x"><x:sheetData><x:row r="1">' +
        '<x:c r="A1" t="inlineStr"><x:is><x:t xml:space="preserve">  due spazi </x:t></x:is></x:c>' +
        '<x:c r="B1"/>' +
        '<x:c r="C1" t="inlineStr"><x:is><x:t><![CDATA[a<b&c]]></x:t></x:is></x:c>' +
        '<x:c r="AA1" t="inlineStr"><x:is><x:t>aa</x:t></x:is></x:c>' +
        '</x:row></x:sheetData></x:worksheet>',
    );
    const row = readXlsx(bytes)[0]!.rows[0]!;
    expect(row).toHaveLength(27);
    expect(row[0]).toBe('  due spazi ');
    expect(row[1]).toBe('');
    expect(row[2]).toBe('a<b&c');
    expect(row[26]).toBe('aa');
  });

  it('riferimento di colonna enorme o riga fuori limite → FOGLIO_ILLEGGIBILE', () => {
    const big = sheetZip(
      '<worksheet><sheetData><row r="1"><c r="ZZZZZZZZ1" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>',
    );
    expect(() => readXlsx(big)).toThrow(expect.objectContaining({ code: 'FOGLIO_ILLEGGIBILE' }));
    const rows = sheetZip('<worksheet><sheetData><row r="2000000"/></sheetData></worksheet>');
    expect(() => readXlsx(rows)).toThrow(expect.objectContaining({ code: 'FOGLIO_ILLEGGIBILE' }));
  });

  it('zip oltre 50 MB rifiutato prima di decomprimere', () => {
    expect(() => readXlsx(new Uint8Array(50 * 1024 * 1024 + 1))).toThrow(XlsxFormatError);
  });
});
