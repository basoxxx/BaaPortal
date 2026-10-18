import { describe, expect, it } from 'vitest';
import type { CpuProperties, Tag } from '@baaportal/project';
import { parseTsv } from '../src/grid/tsv';
import {
  cloneTags,
  constantsFromTsv,
  fillConstants,
  fillTags,
  isRetentive,
  newConstantAfter,
  newTagAfter,
  tagsFromTsv,
  tagsToTsv,
} from '../src/editors/tags/tagRows';

const seq = () => {
  let n = 0;
  return () => `n${++n}`;
};
const tag = (name: string, type: string, address: string, extra: Partial<Tag> = {}): Tag => ({
  id: `t-${name}`,
  name,
  type,
  address,
  hmi: true,
  comment: '',
  ...extra,
});
const pick = (t: Tag) => ({ name: t.name, type: t.type, address: t.address, hmi: t.hmi });

describe('tagRows', () => {
  it('newTagAfter continua tipo e indirizzo', () => {
    expect(pick(newTagAfter(tag('A', 'Bool', '%M0.7'), 'B', seq()))).toEqual({
      name: 'B',
      type: 'Bool',
      address: '%M1.0',
      hmi: true,
    });
    expect(pick(newTagAfter(undefined, 'X', seq()))).toEqual({
      name: 'X',
      type: 'Bool',
      address: '%M0.0',
      hmi: true,
    });
    expect(newTagAfter(tag('A', 'Int', '%MW4'), 'B', seq()).address).toBe('%MW6');
  });

  it('newTagAfter: indirizzo incompatibile o non valido, indirizzo base secondo il tipo', () => {
    expect(newTagAfter(tag('A', 'Real', 'XYZ'), 'B', seq()).address).toBe('%MD0');
    expect(newTagAfter(tag('A', 'Int', '%MW2'), 'B', seq()).address).toBe('%MW4');
    expect(newTagAfter(tag('A', 'Timer', '%T3'), 'B', seq()).address).toBe('%T4');
    expect(newTagAfter(tag('A', 'Byte', ''), 'B', seq()).address).toBe('%MB0');
    expect(newTagAfter(tag('A', 'Counter', ''), 'B', seq()).address).toBe('%C0');
    // Un tipo non valido resta com'è e l'indirizzo è quello dei Bool.
    expect(pick(newTagAfter(tag('A', 'Bol', '%M0.0'), 'B', seq()))).toMatchObject({
      type: 'Bol',
      address: '%M0.0',
    });
  });

  it('fillTags: nomi e indirizzi incrementati, nomi già presi saltati', () => {
    const out = fillTags(tag('Motore_1', 'Int', '%MW10', { comment: 'c' }), 3, ['Motore_3'], seq());
    expect(out.map((t) => [t.name, t.address])).toEqual([
      ['Motore_2', '%MW12'],
      ['Motore_4', '%MW14'],
      ['Motore_5', '%MW16'],
    ]);
    expect(out.every((t) => t.type === 'Int' && t.comment === 'c' && t.hmi)).toBe(true);
    expect(new Set(out.map((t) => t.id)).size).toBe(3);
  });

  it('fillTags: con indirizzo non valido lo copia così com’è', () => {
    const out = fillTags(tag('A', 'Int', 'boh'), 2, [], seq());
    expect(out.map((t) => [t.name, t.address])).toEqual([
      ['A_1', 'boh'],
      ['A_2', 'boh'],
    ]);
  });

  it('tagsFromTsv: \\r\\n, colonne mancanti, nomi doppi, righe sbagliate conservate', () => {
    expect(
      tagsFromTsv(parseTsv('A\tInt\t%MW0\r\nA\r\nB\tBol\tXYZ\r\n'), ['a'], seq()).map((t) => [
        t.name,
        t.type,
        t.address,
      ]),
    ).toEqual([
      ['A_1', 'Int', '%MW0'],
      ['A_2', 'Bool', '%M0.0'],
      ['B', 'Bol', 'XYZ'],
    ]);
  });

  it('tagsFromTsv: normalizza tipo e indirizzo, legge HMI e commento, ignora la ritenzione', () => {
    const [a, b, c] = tagsFromTsv(
      parseTsv(
        'A\tint\t%mw 4\tTRUE\tFALSE\tnota\nB\tBool\t%M0.1\tFALSE\t0\t\nC\tBool\t%M0.2\tx\t1',
      ),
      [],
      seq(),
    );
    expect(a).toMatchObject({ type: 'Int', address: '%MW4', hmi: false, comment: 'nota' });
    expect(b).toMatchObject({ hmi: false, comment: '' });
    expect(c).toMatchObject({ hmi: true });
  });

  it('tagsToTsv: stesse colonne, ritenzione TRUE/FALSE', () => {
    const text = tagsToTsv(
      [tag('A', 'Int', '%MW0', { comment: 'x' }), tag('B', 'Bool', '%M5.0', { hmi: false })],
      (t) => t.name === 'A',
    );
    expect(text).toBe('A\tInt\t%MW0\tTRUE\tTRUE\tx\r\nB\tBool\t%M5.0\tFALSE\tFALSE\t');
    // Si può rileggere con tagsFromTsv.
    const back = tagsFromTsv(parseTsv(text), [], seq());
    expect(back.map(pick)).toEqual([
      { name: 'A', type: 'Int', address: '%MW0', hmi: true },
      { name: 'B', type: 'Bool', address: '%M5.0', hmi: false },
    ]);
  });

  it('cloneTags: id nuovi, nomi unici, righe non valide scartate', () => {
    const out = cloneTags(
      [tag('A', 'Int', '%MW0'), { foo: 1 }, null, tag('B', 'Int', '%MW2')],
      ['A'],
      seq(),
    );
    expect(out.map((t) => [t.id, t.name, t.address])).toEqual([
      ['n1', 'A_1', '%MW0'],
      ['n2', 'B', '%MW2'],
    ]);
  });

  it('isRetentive con ritenzione MB0..15, T0..-, C0..7', () => {
    const props = { retentivity: { mBytes: 16, timers: 0, counters: 8 } } as CpuProperties;
    const r = (address: string) => isRetentive(tag('x', 'Int', address), props);
    expect(r('%MW14')).toBe(true);
    expect(r('%MW16')).toBe(false);
    expect(r('%M15.7')).toBe(true);
    expect(r('%C7')).toBe(true);
    expect(r('%C8')).toBe(false);
    expect(r('%T0')).toBe(false);
    expect(r('%IW0')).toBe(false);
    expect(r('boh')).toBe(false);
    expect(
      isRetentive(tag('x', 'Timer', '%T0'), {
        retentivity: { mBytes: 0, timers: 2, counters: 0 },
      } as CpuProperties),
    ).toBe(true);
  });

  it('costanti: nuova, riempimento (solo il nome) e lettura da TSV', () => {
    const prev = { id: 'c0', name: 'Max_1', type: 'Real', value: '2.5', comment: 'k' };
    expect(newConstantAfter(prev, 'Z', seq())).toMatchObject({
      name: 'Z',
      type: 'Real',
      value: '0.0',
    });
    expect(newConstantAfter(undefined, 'Z', seq())).toMatchObject({ type: 'Int', value: '0' });
    expect(
      fillConstants(prev, 2, ['Max_2'], seq()).map((c) => [c.name, c.type, c.value, c.comment]),
    ).toEqual([
      ['Max_3', 'Real', '2.5', 'k'],
      ['Max_4', 'Real', '2.5', 'k'],
    ]);
    expect(
      constantsFromTsv(parseTsv('K\treal\t1.5\tc\nK\r\nM\tBol\tzz'), [], seq()).map((c) => [
        c.name,
        c.type,
        c.value,
        c.comment,
      ]),
    ).toEqual([
      ['K', 'Real', '1.5', 'c'],
      ['K_1', 'Int', '0', ''],
      ['M', 'Bol', 'zz', ''],
    ]);
  });
});
