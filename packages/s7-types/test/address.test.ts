import { describe, expect, it } from 'vitest';
import {
  addressBitRange,
  addressFitsType,
  formatAddress,
  incrementAddress,
  parseAddress,
  parseType,
  rangesOverlap,
} from '../src';

function addr(text: string) {
  const r = parseAddress(text);
  if (!r.ok) throw new Error(`indirizzo non valido: ${text}`);
  return r.address;
}
function type(text: string) {
  const r = parseType(text);
  if (!r.ok) throw new Error(`tipo non valido: ${text}`);
  return r.type;
}

describe('parseAddress', () => {
  it.each([
    ['M0.0', '%M0.0'],
    ['%mw10', '%MW10'],
    ['E 1.7', '%I1.7'],
    ['A4.0', '%Q4.0'],
    ['EB0', '%IB0'],
    ['AW2', '%QW2'],
    ['MD4', '%MD4'],
    ['PEW256', '%PIW256'],
    ['PIW256', '%PIW256'],
    ['PAW256', '%PQW256'],
    ['T5', '%T5'],
    ['Z3', '%C3'],
    ['c3', '%C3'],
  ])('parseAddress(%s) → %s', (a, b) => {
    const r = parseAddress(a);
    expect(r.ok && formatAddress(r.address)).toBe(b);
  });

  it.each([
    ['M0.8', 'BIT_RANGE'],
    ['MW', 'SYNTAX'],
    ['PI0.0', 'SYNTAX'],
    ['M70000.0', 'NUMBER_RANGE'],
    ['DB1.DBX0.0', 'SYNTAX'],
    ['T70000', 'NUMBER_RANGE'],
    ['L0.0', 'SYNTAX'],
    ['MW0.1', 'SYNTAX'],
  ])('parseAddress(%s) rifiuta con %s', (a, error) =>
    expect(parseAddress(a)).toEqual({ ok: false, error }),
  );
});

describe('indirizzi e tipi', () => {
  it('compatibilità indirizzo/tipo', () => {
    const fits = (a: string, ty: string) => addressFitsType(addr(a), type(ty));
    expect([
      fits('M0.0', 'Bool'),
      fits('MW0', 'Int'),
      fits('MW0', 'Bool'),
      fits('MD0', 'Real'),
      fits('T1', 'Timer'),
      fits('T1', 'Int'),
      fits('MB0', 'Char'),
      fits('PIW256', 'Word'),
      fits('MW0', 'String[2]'),
    ]).toEqual([true, true, false, true, true, false, true, true, false]);
  });

  it('sovrapposizioni', () => {
    const ov = (a: string, b: string) => rangesOverlap(addr(a), addr(b));
    expect([
      ov('MW0', 'M1.3'),
      ov('MW0', 'MW2'),
      ov('MD0', 'MW2'),
      ov('IW0', 'PIW0'),
      ov('T1', 'T1'),
      ov('C1', 'T1'),
    ]).toEqual([true, false, true, false, true, false]);
  });

  it('intervalli di bit', () => {
    expect(addressBitRange(addr('M1.3'))).toEqual({ area: 'M', from: 11, to: 11 });
    expect(addressBitRange(addr('MD2'))).toEqual({ area: 'M', from: 16, to: 47 });
    expect(addressBitRange(addr('T7'))).toEqual({ area: 'T', from: 7, to: 7 });
  });

  it.each([
    ['M0.7', '%M1.0'],
    ['MW10', '%MW12'],
    ['MD4', '%MD8'],
    ['IB3', '%IB4'],
    ['T9', '%T10'],
  ])('incrementAddress(%s) → %s', (a, b) =>
    expect(formatAddress(incrementAddress(addr(a)))).toBe(b),
  );
});
