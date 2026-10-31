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

  it('CPU compatta 31xC: I/O integrato al posto 2 più i moduli della configurazione', () => {
    expect(simIoOf(device('cpu-314c-2-dp'))).toEqual([
      {
        id: 'integrated-0',
        name: 'DI24/DO16',
        rack: 0,
        slot: 2,
        inputs: { start: 124, bytes: 3 },
        outputs: { start: 124, bytes: 2 },
      },
      {
        id: 'integrated-1',
        name: 'AI5/AO2',
        rack: 0,
        slot: 2,
        inputs: { start: 752, bytes: 10 },
        outputs: { start: 752, bytes: 4 },
      },
      expect.objectContaining({ id: 'm1' }),
    ]);
  });

  it('CPU compatta senza configurazione hardware: niente moduli (tutto il campo della CPU)', () => {
    const dev = device('cpu-312c');
    delete dev.hardware;
    expect(simIoOf(dev)).toEqual([]);
  });
});
