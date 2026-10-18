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
