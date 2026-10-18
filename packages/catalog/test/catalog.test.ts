import { describe, expect, it } from 'vitest';
import { formatType, layoutStruct } from '@baaportal/s7-types';
import { CPU_CATALOG, OB_DEFINITIONS, findCpu, findCpuByOrderNumber, findOb } from '../src';

describe('catalogo CPU e OB', () => {
  it("ogni CPU: id unico, nome CPU 31x, numeri d'articolo validi, OB1, fonte", () => {
    expect(new Set(CPU_CATALOG.map((c) => c.id)).size).toBe(CPU_CATALOG.length);
    for (const c of CPU_CATALOG) {
      expect(c.name).toMatch(/^CPU 31\d/);
      expect(c.versions.length).toBeGreaterThan(0);
      for (const v of c.versions) {
        expect(v.orderNumber).toMatch(/^6ES7 31\d-[0-9A-Z]{5}-0AB0$/);
        expect(v.firmware.length).toBeGreaterThan(0);
      }
      expect(c.obs).toContain(1);
      for (const ob of c.obs) expect(findOb(ob)).toBeDefined();
      expect(c.source.trim()).not.toBe('');
      expect(c.retentiveMax.mBytes).toBeLessThanOrEqual(c.limits.mBytes);
      expect(findCpu(c.id)).toBe(c);
    }
    expect(findCpu('__proto__')).toBeUndefined();
    expect(findCpuByOrderNumber('constructor')).toBeUndefined();
  });
  it('CPU 315-2 PN/DP', () => {
    const { cpu } = findCpuByOrderNumber('6ES7 315-2EH14-0AB0')!;
    expect(cpu).toMatchObject({
      name: 'CPU 315-2 PN/DP',
      group: 'standard',
      interfaces: { mpi: true, dp: true, pn: true },
    });
    expect(cpu.limits).toMatchObject({ mBytes: 2048, timers: 256, counters: 256 });
  });
  it('le informazioni di avvio di ogni OB occupano 20 byte', () => {
    for (const ob of OB_DEFINITIONS) {
      const r = layoutStruct(ob.startInfo, () => null);
      expect(r.ok && r.sizeBytes).toBe(20);
    }
  });
  it('OB1: nomi e tipi delle informazioni di avvio', () => {
    expect(findOb(1)!.startInfo.map((m) => `${m.name}:${formatType(m.type)}`)).toEqual([
      'OB1_EV_CLASS:Byte',
      'OB1_SCAN_1:Byte',
      'OB1_PRIORITY:Byte',
      'OB1_OB_NUMBR:Byte',
      'OB1_RESERVED_1:Byte',
      'OB1_RESERVED_2:Byte',
      'OB1_PREV_CYCLE:Int',
      'OB1_MIN_CYCLE:Int',
      'OB1_MAX_CYCLE:Int',
      'OB1_DATE_TIME:Date_And_Time',
    ]);
    expect(findOb(1)!.defaultName).toBe('Main');
  });
});
