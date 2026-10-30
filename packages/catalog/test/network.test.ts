import { describe, expect, it } from 'vitest';
import {
  ET200S_MODULES,
  STATION_CATALOG,
  cpuPorts,
  findCpu,
  findIoModule,
  findModule,
  findStation,
  modulePort,
  portAccepts,
  stationAccepts,
} from '../src';

const ports = (id: string) => cpuPorts(findCpu(id)!).map((p) => `${p.id} ${p.kind}`);

describe('interfacce e stazioni ET 200', () => {
  it('interfacce delle CPU secondo il tipo', () => {
    for (const id of ['cpu-312', 'cpu-314', 'cpu-312c', 'cpu-313c', 'cpu-313c-2-ptp'])
      expect(ports(id)).toEqual(['X1 MPI']);
    for (const id of ['cpu-313c-2-dp', 'cpu-314c-2-dp', 'cpu-315f-2-dp'])
      expect(ports(id)).toEqual(['X1 MPI', 'X2 DP']);
    // 317-2 DP: la prima interfaccia è MPI/DP (manuale 03/2011, dati tecnici della CPU 317-2 DP).
    expect(ports('cpu-317-2-dp')).toEqual(['X1 MPI/DP', 'X2 DP']);
    expect(ports('cpu-317f-2-dp')).toEqual(['X1 MPI/DP', 'X2 DP']);
    for (const id of ['cpu-314c-2-pn-dp', 'cpu-317-2-pn-dp', 'cpu-315f-2-pn-dp'])
      expect(ports(id)).toEqual(['X1 MPI/DP', 'X2 PN']);
    expect(ports('cpu-315-2-dp')).toEqual(['X1 MPI', 'X2 DP']);
    expect(ports('cpu-315-2-pn-dp')).toEqual(['X1 MPI/DP', 'X2 PN']);
    expect(ports('cpu-319-3-pn-dp')).toEqual(['X1 MPI/DP', 'X2 DP', 'X3 PN']);
    expect(ports('cpu-319f-3-pn-dp')).toEqual(['X1 MPI/DP', 'X2 DP', 'X3 PN']);
  });
  it('quale interfaccia va su quale sottorete', () => {
    expect(portAccepts('MPI/DP', 'MPI')).toBe(true);
    expect(portAccepts('MPI/DP', 'PROFIBUS')).toBe(true);
    expect(portAccepts('MPI/DP', 'ETHERNET')).toBe(false);
    expect(portAccepts('DP', 'MPI')).toBe(false);
    expect(portAccepts('PN', 'ETHERNET')).toBe(true);
    expect(portAccepts('MPI', 'PROFIBUS')).toBe(false);
  });
  it('solo i CP 343-1 hanno un’interfaccia Ethernet', () => {
    expect(modulePort(findModule('6GK7 343-1EX30-0XE0')!)).toBe('PN');
    expect(modulePort(findModule('6ES7 340-1AH02-0AE0')!)).toBeUndefined();
  });
  it('stazioni e moduli ammessi', () => {
    expect(STATION_CATALOG.map((s) => `${s.name}:${s.bus}`)).toEqual([
      'IM151-1 Standard:DP',
      'IM151-3 PN:PN',
      'IM 153-1:DP',
    ]);
    const et200s = findStation('6es7151-1AA05-0AB0')!;
    const et200m = findStation('6ES7 153-1AA03-0XB0')!;
    const di2 = findIoModule('6ES7 131-4BB01-0AA0')!;
    const sm = findIoModule('6ES7 321-1BH02-0AA0')!;
    expect(di2.inputBytes).toBe(1);
    expect(findModule(di2.orderNumber)).toBeUndefined(); // non va nel rack S7-300
    expect(stationAccepts(et200s, di2, 1)).toBe(true);
    expect(stationAccepts(et200s, sm, 1)).toBe(false);
    expect(stationAccepts(et200m, sm, 4)).toBe(true);
    expect(stationAccepts(et200m, sm, 3)).toBe(false);
    expect(stationAccepts(et200m, di2, 4)).toBe(false);
    expect(ET200S_MODULES.every((m) => m.inputBytes + m.outputBytes === 1)).toBe(true);
  });
});
