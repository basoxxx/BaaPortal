import { describe, expect, it } from 'vitest';
import {
  applyTranslations,
  createProject,
  listTextEntries,
  setLanguages,
  setTranslation,
  type PlcDevice,
  type Project,
} from '@baaportal/project';
import { parseTextsCsv, parseTextsXlsx, textsToCsv, textsToXlsx, XlsxFormatError } from '../src';

function sample(): Project {
  const p = createProject({ name: 'T', author: '', comment: '' }, new Date());
  p.devices.push({
    id: 'd1',
    name: 'PLC_1',
    blocks: [],
    udts: [],
    tagTables: [
      {
        id: 't1',
        name: 'Std',
        group: '',
        constants: [],
        tags: [
          { id: 'g1', name: 'Start', type: 'Bool', address: '%I0.0', hmi: true, comment: 'Avvio; "marcia"' },
          { id: 'g2', name: 'Stop', type: 'Bool', address: '%I0.1', hmi: true, comment: '=1+1' },
        ],
      },
    ],
  } as unknown as PlcDevice);
  setLanguages(p, { editing: 'it-IT', others: ['en-US', 'de-DE'] });
  return p;
}

describe.each([
  ['csv', (p: Project) => textsToCsv(p), (x: string, l: string[]) => parseTextsCsv(x, l)],
  [
    'xlsx',
    (p: Project) => textsToXlsx(p),
    (x: Uint8Array, l: string[]) => parseTextsXlsx(x, l),
  ],
] as const)('testi di progetto in %s', (_name, write, read) => {
  it('esporta e reimporta le traduzioni, formule comprese', () => {
    const p = sample();
    setTranslation(p, 'd1/g1/comment', 'en-US', 'Start; "run"');
    setTranslation(p, 'd1/g2/comment', 'de-DE', '=HYPERLINK("http://x")');
    const parsed = (read as (x: never, l: string[]) => ReturnType<typeof parseTextsCsv>)(
      (write as (p: Project) => never)(p),
      ['en-US', 'de-DE'],
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.translations).toEqual([
      { key: 'd1/g1/comment', lang: 'en-US', text: 'Start; "run"' },
      { key: 'd1/g2/comment', lang: 'de-DE', text: '=HYPERLINK("http://x")' },
    ]);
    const q = sample();
    expect(applyTranslations(q, parsed.translations)).toEqual({ applied: 2, skipped: 0 });
    expect(q.texts).toEqual(p.texts);
    expect(listTextEntries(q)).toHaveLength(2);
  });
});

describe('testi di progetto: file', () => {
  it('il csv neutralizza le formule in scrittura', () => {
    expect(textsToCsv(sample())).toContain("'=1+1");
  });

  it('segnala la colonna Key o le lingue mancanti', () => {
    expect(parseTextsCsv('A;B\r\n1;2\r\n', ['en-US']).errors).toEqual([
      { line: 1, code: 'COLONNA_MANCANTE' },
    ]);
    expect(parseTextsCsv('Key;it-IT\r\nk;x\r\n', ['en-US']).errors).toHaveLength(1);
  });

  it('un xlsx non valido lancia XlsxFormatError', () => {
    expect(() => parseTextsXlsx(new Uint8Array([1, 2, 3]), ['en-US'])).toThrow(XlsxFormatError);
  });
});
