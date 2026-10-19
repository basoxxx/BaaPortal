import { describe, expect, it } from 'vitest';
import { LOCAL_TSAP_PG, remoteTsap } from '../src';

describe('TSAP', () => {
  it('remoteTsap(pg, 0, 2) === 0x0102; remoteTsap(op, 0, 3) === 0x0203; rack 8 -> RangeError', () => {
    expect(remoteTsap('pg', 0, 2)).toBe(0x0102);
    expect(remoteTsap('op', 0, 3)).toBe(0x0203);
    expect(remoteTsap('basic', 0, 2)).toBe(0x0302);
    expect(remoteTsap('pg', 1, 2)).toBe(0x0122);
    expect(() => remoteTsap('pg', 8, 0)).toThrow(RangeError);
    expect(() => remoteTsap('pg', 0, 32)).toThrow(RangeError);
    expect(() => remoteTsap('pg', -1, 0)).toThrow(RangeError);
    expect(LOCAL_TSAP_PG).toBe(0x0100);
  });
});

describe('TSAP, tipo di connessione non valido', () => {
  it('remoteTsap con tipo a runtime non valido -> RangeError', () => {
    expect(() => remoteTsap('xx' as never, 0, 2)).toThrow(RangeError);
  });
});
