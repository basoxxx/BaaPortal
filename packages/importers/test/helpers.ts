import { readFileSync } from 'node:fs';
import { findCpu } from '@baaportal/catalog';
import { createPlcDevice, type NewId, type ObjectRef, type PlcDevice } from '@baaportal/project';

export const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

export function seq(prefix = 'id'): NewId {
  let n = 0;
  return () => `${prefix}${++n}`;
}

/** Dispositivo senza blocchi, per applicare una sorgente da zero. */
export function emptyDevice(newId: NewId = seq('d')): PlcDevice {
  const d = createPlcDevice({
    cpu: findCpu('cpu-315-2-pn-dp')!,
    orderNumber: '6ES7 315-2EH14-0AB0',
    firmware: 'V3.2',
    name: 'PLC_1',
    texts: { defaultTagTable: 'Tabella' },
    newId,
  });
  d.blocks = [];
  return d;
}

/** Tutti gli oggetti del dispositivo, nell'ordine in cui sono memorizzati. */
export function allRefs(d: PlcDevice): ObjectRef[] {
  return [
    ...d.udts.map((u): ObjectRef => ({ kind: 'udt', deviceId: d.id, id: u.id })),
    ...d.blocks.map((b): ObjectRef => ({ kind: 'block', deviceId: d.id, id: b.id })),
  ];
}
