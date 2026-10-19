import { describe, expect, it } from 'vitest';
import { defaultLiteral, parseLiteral, parseType, type DataType } from '../src';

function t(text: string): DataType {
  const r = parseType(text);
  if (!r.ok) throw new Error(`tipo non valido: ${text}`);
  return r.type;
}

const VALID: [string, string, string][] = [
  ['Bool', 'TRUE', 'true'],
  ['Bool', '0', 'false'],
  ['Byte', '255', '16#FF'],
  ['Byte', 'B#16#0a', '16#A'],
  ['Byte', '2#1010', '16#A'],
  ['Word', 'W#16#1', '16#1'],
  ['Word', 'B#(1,2)', '16#102'],
  ['DWord', 'DW#16#FFFFFFFF', '16#FFFFFFFF'],
  ['DWord', 'B#(1,2,3,4)', '16#1020304'],
  ['Int', '-32768', '-32768'],
  ['DInt', 'L#5', '5'],
  ['Real', '1', '1.0'],
  ['Real', '-1.5e3', '-1500.0'],
  ['Real', '-0', '0.0'],
  ['S5Time', 's5time#100ms', 'S5T#100MS'],
  ['S5Time', 'S5T#2H46M30S', 'S5T#2H46M30S'],
  ['S5Time', 'S5T#0ms', 'S5T#0MS'],
  ['Time', 'T#1d_2h_3m_4s_5ms', 'T#1D2H3M4S5MS'],
  ['Time', 'TIME#-1s', 'T#-1S'],
  ['Time', 'T#90s', 'T#1M30S'],
  ['Date', 'DATE#2026-10-18', 'D#2026-10-18'],
  ['Time_Of_Day', 'TIME_OF_DAY#1:2:3.4', 'TOD#01:02:03.400'],
  ['Date_And_Time', 'DT#2026-10-18-12:30:00', 'DT#2026-10-18-12:30:00.000'],
  ['Char', "'$''", "'$''"],
  ['String[5]', "'a$Lb'", "'a$Lb'"],
  ['String[2]', "'$41$42'", "'$41$42'"],
  // STEP 7 V5.5: anno a due cifre (90-99 → 1990-1999, 00-89 → 2000-2089).
  ['Date_And_Time', 'DT#90-1-1-0:0:0.000', 'DT#1990-01-01-00:00:00.000'],
  ['Date_And_Time', 'DT#89-12-31-23:59:59.999', 'DT#2089-12-31-23:59:59.999'],
  ['Date_And_Time', 'DATE_AND_TIME#05-6-7-8:9:10', 'DT#2005-06-07-08:09:10.000'],
  // Cifre separate da '_'.
  ['Word', '2#0000_0000_0000_0001', '16#1'],
  ['Byte', '2#1010_1010', '16#AA'],
  ['Word', '16#FF_FF', '16#FFFF'],
  ['Word', 'W#16#00_FF', '16#FF'],
  ['DWord', 'DW#16#FFFF_0000', '16#FFFF0000'],
  ['Byte', 'B#16#0_F', '16#F'],
  // Valori iniziali di un array: elenco, ripetizione, misti; anche meno elementi della dimensione.
  ['Array[1..3] of Int', '1, 2, 3', '1, 2, 3'],
  ['Array[1..4] of Int', '4(0)', '4(0)'],
  ['Array[1..5] of Int', '2(1), 3', '2(1), 3'],
  ['Array[1..5] of Int', ' 2 ( 1 ) ,3 ', '2(1), 3'],
  ['Array[0..1, 1..2] of Bool', '4(TRUE)', '4(true)'],
  ['Array[1..3] of Int', '7', '7'],
  ['Array[1..2] of Char', "'a', ','", "'a', ','"],
  ['Array[1..2] of String[4]', "'a$'b', 'c,d'", "'a$'b', 'c,d'"],
  ['Array[1..2] of Word', '2#0000_0001, W#16#FF', '16#1, 16#FF'],
];

describe('parseLiteral', () => {
  it.each(VALID)('parseLiteral(%s, %s) → %s', (type, text, canonical) => {
    expect(parseLiteral(t(type), text)).toEqual({ ok: true, canonical });
  });

  it.each([
    ['Byte', '256', 'OUT_OF_RANGE'],
    ['Int', '32768', 'OUT_OF_RANGE'],
    ['Real', '3.5E+38', 'OUT_OF_RANGE'],
    ['Real', '1,5', 'SYNTAX'],
    ['S5Time', 'S5T#2H46M31S', 'OUT_OF_RANGE'],
    ['S5Time', 'S5T#5MS', 'OUT_OF_RANGE'],
    ['Time', 'T#25D', 'OUT_OF_RANGE'],
    ['Date', 'D#1989-12-31', 'OUT_OF_RANGE'],
    ['Date', 'D#2026-02-30', 'OUT_OF_RANGE'],
    ['Time_Of_Day', 'TOD#24:00:00', 'OUT_OF_RANGE'],
    ['Char', "'AB'", 'TOO_LONG'],
    ['String[5]', "'abcdef'", 'TOO_LONG'],
    ['String[5]', "'$Q'", 'SYNTAX'],
    ['Timer', '1', 'NO_VALUE'],
    ['Bool', 'si', 'SYNTAX'],
    ['Time', 'T#1S2H', 'SYNTAX'],
    ['Date_And_Time', 'DT#2090-01-01-00:00:00', 'OUT_OF_RANGE'],
    ['Date_And_Time', 'DT#1989-12-31-23:59:59', 'OUT_OF_RANGE'],
    ['Date_And_Time', 'DT#90-2-30-0:0:0.000', 'OUT_OF_RANGE'],
    ['Date_And_Time', 'DT#090-1-1-0:0:0.000', 'SYNTAX'],
    ['Date_And_Time', 'DT#9-1-1-0:0:0.000', 'SYNTAX'],
    ['Word', '2#_0001', 'SYNTAX'],
    ['Word', '16#FF__FF', 'SYNTAX'],
    ['Word', '16#FF_', 'SYNTAX'],
    ['Word', '1_000', 'SYNTAX'],
    ['Word', '2#1_0000_0000_0000_0000', 'OUT_OF_RANGE'],
    ['Array[1..3] of Int', '1, 2, 3, 4', 'TOO_LONG'],
    ['Array[1..3] of Int', '2(1), 2(2)', 'TOO_LONG'],
    ['Array[0..1, 1..2] of Int', '5(0)', 'TOO_LONG'],
    ['Array[1..3] of Int', '1, 40000', 'OUT_OF_RANGE'],
    ['Array[1..3] of Int', '1, , 2', 'SYNTAX'],
    ['Array[1..3] of Int', '0(1)', 'SYNTAX'],
    ['Array[1..3] of Int', '2()', 'SYNTAX'],
    ['Array[1..3] of Int', '2(1', 'SYNTAX'],
    ['Array[1..3] of Int', '', 'SYNTAX'],
    ['Array[1..2] of Struct', '1', 'NO_VALUE'],
    ['Array[1..2] of "Asse"', '1', 'NO_VALUE'],
  ])('parseLiteral(%s, %s) rifiuta con %s', (type, text, error) => {
    expect(parseLiteral(t(type), text)).toEqual({ ok: false, error });
  });

  it('ogni valore canonico si rilegge identico', () => {
    for (const [type, , canonical] of VALID) {
      expect(parseLiteral(t(type), canonical)).toEqual({ ok: true, canonical });
    }
  });
});

describe('defaultLiteral', () => {
  it('valori predefiniti', () => {
    expect(
      [
        'Bool',
        'Byte',
        'Int',
        'Real',
        'S5Time',
        'Time',
        'Date',
        'Time_Of_Day',
        'Date_And_Time',
        'Char',
        'String[4]',
        'Timer',
      ].map((x) => defaultLiteral(t(x))),
    ).toEqual([
      'false',
      '16#0',
      '0',
      '0.0',
      'S5T#0MS',
      'T#0MS',
      'D#1990-01-01',
      'TOD#00:00:00.000',
      'DT#1990-01-01-00:00:00.000',
      "' '",
      "''",
      null,
    ]);
  });
  it('i valori predefiniti sono validi', () => {
    for (const x of [
      'Bool',
      'Word',
      'DInt',
      'Real',
      'S5Time',
      'Time',
      'Date',
      'Char',
      'String[4]',
    ]) {
      const d = defaultLiteral(t(x));
      expect(d && parseLiteral(t(x), d)).toEqual({ ok: true, canonical: d });
    }
  });
});
