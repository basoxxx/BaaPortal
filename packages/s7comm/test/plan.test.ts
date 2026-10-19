import { describe, expect, it } from 'vitest';
import { planReads, splitArea, type ReadItem } from '../src';

const resLen = (g: ReadItem[]): number => {
  let t = 14;
  g.forEach((it, i) => {
    const n = it.size === 'TIMER' || it.size === 'COUNTER' ? it.count * 2 : it.count;
    t += 4 + n + (n % 2 === 1 && i < g.length - 1 ? 1 : 0);
  });
  return t;
};

describe('planReads / splitArea', () => {
  it('planReads: 25 item piccoli -> 2 richieste; ogni risposta stimata <= PDU', () => {
    const items: ReadItem[] = Array.from({ length: 25 }, (_, i) => ({
      area: 'M',
      db: 0,
      start: i * 4,
      size: 'BYTE',
      count: 3,
    }));
    const groups = planReads(items, 240);
    expect(groups.length).toBe(2);
    expect(groups[0]!.length).toBe(19); // 10+2+12*19 = 240: la richiesta limita a 19 con PDU 240
    expect(groups.flat()).toEqual(items);
    for (const g of groups) {
      expect(resLen(g)).toBeLessThanOrEqual(240);
      expect(10 + 2 + 12 * g.length).toBeLessThanOrEqual(240);
    }
  });

  it('divide quando la risposta non entra nella PDU anche con meno di 20 item', () => {
    const items: ReadItem[] = Array.from({ length: 6 }, (_, i) => ({
      area: 'DB',
      db: 1,
      start: i * 50,
      size: 'BYTE',
      count: 50,
    }));
    const groups = planReads(items, 240);
    expect(groups.length).toBeGreaterThan(1);
    expect(groups.flat()).toEqual(items);
    for (const g of groups) expect(resLen(g)).toBeLessThanOrEqual(240);
  });

  it('item da solo piu grande della PDU -> RangeError; 222 byte con PDU 240 entra', () => {
    const big: ReadItem = { area: 'DB', db: 1, start: 0, size: 'BYTE', count: 223 };
    expect(() => planReads([big], 240)).toThrow(RangeError);
    expect(planReads([{ ...big, count: 222 }], 240).length).toBe(1);
  });

  it('timer/counter pesano 2 byte per elemento', () => {
    const t: ReadItem = { area: 'T', db: 0, start: 0, size: 'TIMER', count: 111 };
    expect(planReads([t], 240).length).toBe(1);
    expect(() => planReads([{ ...t, count: 112 }], 240)).toThrow(RangeError);
  });

  it('splitArea(DB, 1, 0, 1000, 240) -> pezzi da <= 222 byte che coprono 0..999 senza buchi', () => {
    const parts = splitArea('DB', 1, 0, 1000, 240);
    let next = 0;
    for (const p of parts) {
      expect(p.count).toBeLessThanOrEqual(222);
      expect(p.start).toBe(next);
      expect(p.area).toBe('DB');
      expect(p.db).toBe(1);
      next += p.count;
    }
    expect(next).toBe(1000);
    expect(parts.length).toBe(5);
    // ogni pezzo e pianificabile da solo
    for (const p of parts) expect(planReads([p], 240).length).toBe(1);
  });

  it('splitArea: lunghezza non valida, area C/T o PDU minuscola -> RangeError', () => {
    expect(() => splitArea('DB', 1, 0, 0, 240)).toThrow(RangeError);
    expect(() => splitArea('T', 0, 0, 10, 240)).toThrow(RangeError);
    expect(() => splitArea('DB', 1, 0, 10, 18)).toThrow(RangeError);
  });
});
