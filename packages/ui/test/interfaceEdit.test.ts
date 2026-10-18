import { describe, expect, it } from 'vitest';
import type { Member } from '@baaportal/project';
import {
  applyType,
  cloneMembers,
  membersFromTsv,
  membersToTsv,
  setOverride,
} from '../src/editors/block/interfaceEdit';
import { mem } from './blockFixtures';

const seq = () => {
  let n = 0;
  return () => `n${++n}`;
};

describe('interfaceEdit', () => {
  it('applyType: normalizza, Struct crea i membri, un tipo semplice li toglie e azzera gli override', () => {
    const m: Member = mem('a', 'Int', { overrides: { '[1]': '2' } });
    applyType(m, 'struct');
    expect(m).toMatchObject({ type: 'Struct', members: [] });
    expect(m).not.toHaveProperty('overrides');
    m.members!.push(mem('p', 'Bool'));
    applyType(m, 'array[0..2] of struct');
    expect(m).toMatchObject({ type: 'Array[0..2] of Struct' });
    expect(m.members).toHaveLength(1);
    applyType(m, 'dint');
    expect(m.type).toBe('DInt');
    expect(m).not.toHaveProperty('members');
    // Un tipo che non si legge resta com'è: lo segna la diagnostica.
    applyType(m, 'Pippo');
    expect(m.type).toBe('Pippo');
  });

  it('setOverride: il valore vuoto toglie la chiave e, se è l’ultima, la mappa', () => {
    const m = mem('a', 'Int');
    setOverride(m, '[1]', '5');
    setOverride(m, '[2]', '6');
    expect(m.overrides).toEqual({ '[1]': '5', '[2]': '6' });
    setOverride(m, '[1]', '');
    setOverride(m, '[2]', '');
    expect(m).not.toHaveProperty('overrides');
  });

  it('cloneMembers: id nuovi in profondità, nomi unici, sola lettura persa', () => {
    const src = mem('s', 'Struct', {
      members: [mem('p', 'Bool')],
      overrides: { x: '1' },
      readOnly: true,
    });
    const out = cloneMembers([src, { nope: 1 }, mem('s', 'Int')], ['s'], seq());
    expect(out.map((m) => m.name)).toEqual(['s_1', 's_2']);
    expect(out[0]).toEqual({
      id: 'n1',
      name: 's_1',
      type: 'Struct',
      comment: '',
      overrides: { x: '1' },
      members: [{ id: 'n2', name: 'p', type: 'Bool', comment: '' }],
    });
    out[0]!.overrides!['x'] = '9';
    expect(src.overrides).toEqual({ x: '1' });
  });

  it('TSV: andata e ritorno con valore e commento; colonne mancanti e Struct', () => {
    const rows = [
      ['a', 'int', '5', 'uno'],
      ['b', '', ''],
      ['', 'struct'],
    ];
    const out = membersFromTsv(rows, [], seq());
    expect(out.map((m) => [m.name, m.type, m.initial, m.comment])).toEqual([
      ['a', 'Int', '5', 'uno'],
      ['b', 'Bool', undefined, ''],
      ['', 'Struct', undefined, ''],
    ]);
    expect(out[2]!.members).toEqual([]);
    expect(membersToTsv(out.slice(0, 1))).toBe('a\tInt\t5\tuno');
  });
});
