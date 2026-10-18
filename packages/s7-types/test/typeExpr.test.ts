import { describe, expect, it } from 'vitest';
import { formatType, parseType } from '../src';

describe('parseType', () => {
  it.each([
    ['Bool', 'Bool'],
    ['INT', 'Int'],
    ['dword', 'DWord'],
    ['TOD', 'Time_Of_Day'],
    ['DT', 'Date_And_Time'],
    ['S5TIME', 'S5Time'],
    ['String', 'String[254]'],
    ['STRING[20]', 'String[20]'],
    ['string [ 8 ]', 'String[8]'],
    ['ARRAY[1..10] OF INT', 'Array[1..10] of Int'],
    ['Array [0..3, -2..2] of Bool', 'Array[0..3, -2..2] of Bool'],
    ['"Motore"', '"Motore"'],
    ['Array[1..2] of "Asse"', 'Array[1..2] of "Asse"'],
    ['Struct', 'Struct'],
    ['Array[1..4] of Struct', 'Array[1..4] of Struct'],
    ['Timer', 'Timer'],
    ['block_fb', 'Block_FB'],
    ['ANY', 'Any'],
    ['Void', 'Void'],
    ['Array[1..3] of String[5]', 'Array[1..3] of String[5]'],
    ['Array[1..3] of Date_And_Time', 'Array[1..3] of Date_And_Time'],
  ])('parseType(%s) → %s', (input, out) => {
    const r = parseType(input);
    expect(r.ok && formatType(r.type)).toBe(out);
  });

  it.each([
    ['Bol', 'SYNTAX'],
    ['', 'SYNTAX'],
    ['Int Int', 'SYNTAX'],
    ['Array[1..2 of Int', 'SYNTAX'],
    ['String[0]', 'STRING_LENGTH'],
    ['String[255]', 'STRING_LENGTH'],
    ['Array[5..1] of Int', 'ARRAY_BOUNDS'],
    ['Array[1..40000] of Int', 'ARRAY_BOUNDS'],
    ['Array[1..2,1..2,1..2,1..2,1..2,1..2,1..2] of Int', 'ARRAY_DIMENSIONS'],
    ['Array[1..2] of Array[1..2] of Int', 'NESTED_ARRAY'],
    ['Array[1..2] of Timer', 'ARRAY_OF_PARAMETER'],
    ['"senza fine', 'SYNTAX'],
  ])('parseType(%s) rifiuta con %s', (input, error) => {
    expect(parseType(input)).toEqual({ ok: false, error });
  });

  it('struct e array di struct hanno membri vuoti', () => {
    expect(parseType('Struct')).toEqual({ ok: true, type: { kind: 'struct', members: [] } });
  });
});
