import { describe, expect, it } from 'vitest';
import type { WatchTable } from '@baaportal/project';
import { parseWatchCsv, watchToCsv } from '../src';

const table = (rows: WatchTable['rows']): WatchTable => ({ id: 'w', name: 'T', rows });

describe('tabelle di controllo csv', () => {
  it('esporta e rilegge operando, formato, comando e commento, formule comprese', () => {
    const rows = [
      { id: '1', operand: '%MW10', format: 'DEC' as const, modify: '-5', comment: '=1+1; "x"' },
      { id: '2', operand: '"Motore"', format: 'BOOL' as const },
    ];
    const csv = watchToCsv(table(rows));
    expect(csv).toContain("'=1+1");
    expect(csv).toContain("'-5");
    const back = parseWatchCsv(csv);
    expect(back.errors).toEqual([]);
    expect(back.rows).toMatchObject([
      { operand: '%MW10', format: 'DEC', modify: '-5', comment: '=1+1; "x"' },
      { operand: '"Motore"', format: 'BOOL', modify: '', comment: '' },
    ]);
  });

  it('segnala colonna mancante e operandi vuoti', () => {
    expect(parseWatchCsv('A;B\r\n1;2\r\n').errors).toEqual([{ line: 1, code: 'COLONNA_MANCANTE' }]);
    const p = parseWatchCsv('Operando,Formato\r\n,DEC\r\nMW0,HEX\r\n');
    expect(p.errors).toEqual([{ line: 2, code: 'OPERANDO_VUOTO' }]);
    expect(p.rows).toMatchObject([{ operand: 'MW0', format: 'HEX', modify: '' }]);
  });
});
