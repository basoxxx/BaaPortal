import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  MODULE_CATALOG,
  defaultStartAddress,
  findCpu,
  findModule,
  moduleTypeSchema,
  slotAccepts,
} from '../src';

const mod = (order: string) => findModule(order)!;

describe('catalogo dei moduli S7-300', () => {
  it('ogni voce rispetta lo schema', () => {
    expect(() => z.array(moduleTypeSchema).parse(MODULE_CATALOG)).not.toThrow();
  });
  it("i numeri d'articolo sono unici", () => {
    const all = MODULE_CATALOG.map((m) => m.orderNumber.replace(/\s+/g, ''));
    expect(new Set(all).size).toBe(all.length);
  });
  it('lo schema rifiuta occupazioni incoerenti', () => {
    const ok = mod('6ES7 321-1BL00-0AA0');
    expect(moduleTypeSchema.safeParse({ ...ok, inputBytes: 5 }).success).toBe(false);
    expect(moduleTypeSchema.safeParse({ ...ok, inputBytes: 0 }).success).toBe(false);
    const ps = mod('6ES7 307-1EA01-0AA0');
    expect(moduleTypeSchema.safeParse({ ...ps, inputBytes: 1 }).success).toBe(false);
  });
  it("ricerca per numero d'articolo, anche senza spazi", () => {
    expect(findModule('6es7321-1BH02-0AA0')?.name).toBe('DI 16x24VDC');
    expect(findModule('constructor')).toBeUndefined();
  });
  it('ci sono le famiglie richieste', () => {
    const fams = new Set(MODULE_CATALOG.map((m) => m.family));
    for (const f of [
      'PS 307',
      'SM 321',
      'SM 322',
      'SM 323',
      'SM 331',
      'SM 332',
      'SM 334',
      'CP 340/341',
      'CP 343-1',
      'IM 360/361/365',
      'FM 350-1',
    ]) {
      expect(fams.has(f), f).toBe(true);
    }
  });
  it('regole dei posti', () => {
    const ps = mod('6ES7 307-1EA01-0AA0');
    const di = mod('6ES7 321-1BH02-0AA0');
    const im360 = mod('6ES7 360-3AA01-0AA0');
    const im361 = mod('6ES7 361-3CA01-0AA0');
    const im365 = mod('6ES7 365-0BA01-0AA0');
    expect(slotAccepts(ps, 0, 1)).toBe(true);
    expect(slotAccepts(ps, 0, 4)).toBe(false);
    expect(slotAccepts(di, 0, 2)).toBe(false);
    expect(slotAccepts(di, 0, 3)).toBe(false);
    expect(slotAccepts(di, 0, 4)).toBe(true);
    expect(slotAccepts(di, 0, 11)).toBe(true);
    expect(slotAccepts(di, 0, 12)).toBe(false);
    expect(slotAccepts(im360, 0, 3)).toBe(true);
    expect(slotAccepts(im360, 1, 3)).toBe(false);
    expect(slotAccepts(im361, 2, 3)).toBe(true);
    expect(slotAccepts(im361, 0, 3)).toBe(false);
    expect(slotAccepts(im365, 1, 3)).toBe(true);
    expect(slotAccepts(im365, 2, 3)).toBe(false);
    // 31xC: il posto 11 del rack 3 avrebbe gli indirizzi dell'I/O integrato.
    expect(slotAccepts(di, 3, 11)).toBe(true);
    expect(slotAccepts(di, 3, 11, findCpu('cpu-313c'))).toBe(false);
    expect(slotAccepts(di, 3, 10, findCpu('cpu-313c'))).toBe(true);
    expect(slotAccepts(di, 3, 11, findCpu('cpu-315-2-dp'))).toBe(true);
  });
  it('indirizzi fissi per posto', () => {
    const di = mod('6ES7 321-1BH02-0AA0');
    const ai = mod('6ES7 331-7KF02-0AB0');
    expect(defaultStartAddress(di, 0, 4)).toBe(0);
    expect(defaultStartAddress(di, 0, 11)).toBe(28);
    expect(defaultStartAddress(di, 1, 4)).toBe(32);
    expect(defaultStartAddress(ai, 0, 4)).toBe(256);
    expect(defaultStartAddress(ai, 0, 6)).toBe(288);
    expect(defaultStartAddress(ai, 3, 11)).toBe(256 + 384 + 112);
    expect(defaultStartAddress(mod('6ES7 307-1EA01-0AA0'), 0, 1)).toBeUndefined();
  });
});
