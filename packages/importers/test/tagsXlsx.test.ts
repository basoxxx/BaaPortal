import { strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { TagTable } from '@baaportal/project';
import { XlsxFormatError, parseTagsXlsx, readXlsx, tagsToXlsx, writeXlsx } from '../src';

const table: TagTable = {
  id: 't',
  name: 'Tabella 1',
  group: '',
  tags: [
    { id: '1', name: 'Start', type: 'Bool', address: '%M0.1', hmi: true, comment: 'a;b <x>' },
    { id: '2', name: 'Livello', type: 'Int', address: '%MW10', hmi: false, comment: '' },
  ],
  constants: [{ id: 'c', name: 'Max', type: 'Int', value: '100', comment: 'limite' }],
};

describe('tabelle variabili xlsx', () => {
  it('tagsToXlsx → parseTagsXlsx roundtrip variabili e costanti', () => {
    const bytes = tagsToXlsx(table);
    expect(readXlsx(bytes).map((s) => s.name)).toEqual(['PLC Tags', 'User Constants']);
    const p = parseTagsXlsx(bytes);
    expect(p.errors).toEqual([]);
    expect(p.tags.map((t) => [t.name, t.type, t.address, t.comment, t.hmi, t.path])).toEqual([
      ['Start', 'Bool', '%M0.1', 'a;b <x>', true, 'Tabella 1'],
      ['Livello', 'Int', '%MW10', '', false, 'Tabella 1'],
    ]);
    expect(p.constants.map((c) => [c.name, c.type, c.value, c.comment])).toEqual([
      ['Max', 'Int', '100', 'limite'],
    ]);
  });

  it('foglio "Constants" accettato come "User Constants"', () => {
    const bytes = writeXlsx([
      { name: 'PLC Tags', rows: [['Name', 'Data Type', 'Logical Address']] },
      {
        name: 'Constants',
        rows: [
          ['Name', 'Data Type', 'Value'],
          ['K', 'Int', '5'],
        ],
      },
    ]);
    const p = parseTagsXlsx(bytes);
    expect(p.errors).toEqual([]);
    expect(p.constants).toMatchObject([{ name: 'K', type: 'Int', value: '5', line: 2 }]);
  });

  it('riga con indirizzo non valido → errore per riga, altre importate', () => {
    const bytes = writeXlsx([
      {
        name: 'PLC Tags',
        rows: [
          ['Name', 'Data Type', 'Logical Address'],
          ['A', 'Bool', '%M0.0'],
          ['B', 'Bool', '%Zeta'],
          ['C', 'Int', '%MW2'],
        ],
      },
    ]);
    const p = parseTagsXlsx(bytes);
    expect(p.errors).toEqual([{ line: 3, code: 'INDIRIZZO_NON_VALIDO', detail: '%Zeta' }]);
    expect(p.tags.map((t) => t.name)).toEqual(['A', 'C']);
  });

  it('righe tutte vuote ignorate; costanti con tipo non valido o valore vuoto → errore', () => {
    const bytes = writeXlsx([
      {
        name: 'PLC Tags',
        rows: [
          ['Name', 'Data Type', 'Logical Address'],
          ['', ' ', ''],
          ['A', 'Bool', '%M0.0'],
        ],
      },
      {
        name: 'User Constants',
        rows: [
          ['Name', 'Data Type', 'Value'],
          ['', '', ''],
          ['K', 'PIPPO', '1'],
          ['L', 'Int', ''],
          ['M', 'Int', '3'],
        ],
      },
    ]);
    const p = parseTagsXlsx(bytes);
    expect(p.tags.map((t) => t.name)).toEqual(['A']);
    expect(p.constants.map((c) => c.name)).toEqual(['M']);
    expect(p.errors).toEqual([
      { line: 3, code: 'TIPO_NON_VALIDO', detail: 'PIPPO' },
      { line: 4, code: 'VALORE_VUOTO', detail: 'L' },
    ]);
  });

  it('byte non xlsx → lancia XlsxFormatError; workbook senza fogli → nessuna riga', () => {
    expect(() => parseTagsXlsx(strToU8('no'))).toThrow(XlsxFormatError);
    expect(parseTagsXlsx(writeXlsx([]))).toEqual({ tags: [], constants: [], errors: [] });
  });
});
