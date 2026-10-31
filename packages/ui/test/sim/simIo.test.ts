import { describe, expect, it } from 'vitest';
import { findCpu } from '@baaportal/catalog';
import { createPlcDevice } from '@baaportal/project';
import { simIoOf } from '../../src/sim/simController';

function device(cpuId: string) {
  const cpu = findCpu(cpuId)!;
  const dev = createPlcDevice({
    cpu,
    orderNumber: cpu.versions[0]!.orderNumber,
    firmware: cpu.versions[0]!.firmware[0]!,
    name: 'PLC',
    texts: { defaultTagTable: 'Tabella' },
  });
  dev.hardware = {
    modules: [
      {
        id: 'm1',
        rack: 0,
        slot: 4,
        orderNumber: '6ES7 321-1BL00-0AA0',
        name: 'DI32',
        comment: '',
        inputStart: 0,
      },
    ],
  };
  return dev;
}

describe('simIoOf', () => {
  it('CPU standard: i moduli della configurazione', () => {
    expect(simIoOf(device('cpu-315-2-dp')).map((m) => m.id)).toEqual(['m1']);
  });

  it('CPU compatta 31xC: nessuna periferia dalla configurazione (I/O integrato non nel catalogo)', () => {
    expect(simIoOf(device('cpu-314c-2-dp'))).toEqual([]);
  });
});
