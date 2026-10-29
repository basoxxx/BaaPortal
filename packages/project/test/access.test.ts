import { describe, expect, it } from 'vitest';
import { createProject, readBaap, writeBaap, checkDevice, createPlcDevice } from '../src/index';
import { cpu315pn, seq } from './fixtures';

const now = new Date('2026-10-24T10:00:00.000Z');

function projectWithPlc() {
  const p = createProject({ name: 'X', author: '', comment: '' }, now);
  p.devices.push(
    createPlcDevice({
      cpu: cpu315pn,
      orderNumber: '6ES7 315-2EH14-0AB0',
      firmware: 'V3.2',
      name: 'PLC_1',
      texts: { defaultTagTable: 'Standard' },
      newId: seq('a'),
    }),
  );
  return p;
}

describe('CpuProperties.access', () => {
  it('access si salva e si riapre', () => {
    const p = projectWithPlc();
    p.devices[0]!.properties.access = {
      host: '192.0.2.10',
      port: 10102,
      rack: 0,
      slot: 2,
      connectionType: 'PG',
      remoteTsap: 0x0302,
    };
    const back = readBaap(writeBaap(p, { appVersion: '0.1.0' }));
    expect(back.devices[0]!.properties.access).toEqual(p.devices[0]!.properties.access);
  });

  const mpi = {
    kind: 'mpi',
    port: 'COM3',
    baudRate: 38400,
    parity: 'odd',
    localAddress: 0,
    cpuAddress: 2,
    highestAddress: 31,
    busSpeed: '187.5k',
    variant: 'auto',
  } as const;
  const tcp = { host: '192.0.2.10', rack: 0, slot: 2, connectionType: 'PG' } as const;

  it('access con link MPI si salva e si riapre uguale', () => {
    const p = projectWithPlc();
    p.devices[0]!.properties.access = { ...tcp, link: { ...mpi } };
    const back = readBaap(writeBaap(p, { appVersion: '0.1.0' }));
    expect(back.devices[0]!.properties.access).toEqual(p.devices[0]!.properties.access);
  });

  it('access senza link resta TCP (file vecchi)', () => {
    const p = projectWithPlc();
    p.devices[0]!.properties.access = { ...tcp };
    const back = readBaap(writeBaap(p, { appVersion: '0.1.0' }));
    expect(back.devices[0]!.properties.access).toEqual(tcp);
    expect(back.devices[0]!.properties.access?.link).toBeUndefined();
  });

  it('con MPI un host vuoto non dà avvisi', () => {
    const d = projectWithPlc().devices[0]!;
    d.properties.access = { ...tcp, host: '', link: { ...mpi } };
    expect(checkDevice(d, cpu315pn).filter((x) => x.property === 'access.host')).toHaveLength(0);
  });

  it('un file senza access si apre', () => {
    const p = projectWithPlc();
    const back = readBaap(writeBaap(p, { appVersion: '0.1.0' }));
    expect(back.devices[0]!.properties.access).toBeUndefined();
  });

  it.each([
    ['connectionType errato', { host: 'h', rack: 0, slot: 2, connectionType: 'XX' }],
    ['rack mancante', { host: 'h', slot: 2, connectionType: 'PG' }],
    ['rack fuori campo', { host: 'h', rack: 8, slot: 2, connectionType: 'PG' }],
    ['slot fuori campo', { host: 'h', rack: 0, slot: 32, connectionType: 'PG' }],
    [
      'remoteTsap fuori campo',
      { host: 'h', rack: 0, slot: 2, connectionType: 'PG', remoteTsap: 65536 },
    ],
    ['remoteTsap negativo', { host: 'h', rack: 0, slot: 2, connectionType: 'PG', remoteTsap: -1 }],
    [
      'remoteTsap non intero',
      { host: 'h', rack: 0, slot: 2, connectionType: 'PG', remoteTsap: 1.5 },
    ],
    ['host troppo lungo', { host: 'a'.repeat(65), rack: 0, slot: 2, connectionType: 'PG' }],
    ['porta fuori campo', { host: 'h', port: 0, rack: 0, slot: 2, connectionType: 'PG' }],
    ['link sconosciuto', { ...tcp, link: { kind: 'usb' } }],
    ['indirizzo CPU oltre 126', { ...tcp, link: { ...mpi, cpuAddress: 127 } }],
    ['indirizzo locale negativo', { ...tcp, link: { ...mpi, localAddress: -1 } }],
    ['HSA non ammesso', { ...tcp, link: { ...mpi, highestAddress: 30 } }],
    ['velocità del bus sconosciuta', { ...tcp, link: { ...mpi, busSpeed: '12M' } }],
    ['parità sconosciuta', { ...tcp, link: { ...mpi, parity: 'mark' } }],
    ['baud rate non intero', { ...tcp, link: { ...mpi, baudRate: 9600.5 } }],
    ['baud rate zero', { ...tcp, link: { ...mpi, baudRate: 0 } }],
    ['porta seriale vuota', { ...tcp, link: { ...mpi, port: '' } }],
    ['variante sconosciuta', { ...tcp, link: { ...mpi, variant: 'v3' } }],
  ])('access malformato (%s): INVALID_SCHEMA', (_n, access) => {
    const p = projectWithPlc();
    (p.devices[0]!.properties as unknown as Record<string, unknown>).access = access;
    let err: unknown;
    try {
      readBaap(writeBaap(p, { appVersion: '0.1.0' }));
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ name: 'BaapFormatError', code: 'INVALID_SCHEMA' });
  });

  it('access con host non valido: avviso dei controlli', () => {
    const p = projectWithPlc();
    const d = p.devices[0]!;
    d.properties.access = { host: 'plc.local', rack: 0, slot: 2, connectionType: 'PG' };
    const ds = checkDevice(d, cpu315pn).filter((x) => x.property === 'access.host');
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ severity: 'warning', code: 'PROPERTY_INVALID' });
    d.properties.access.host = '192.0.2.10';
    expect(checkDevice(d, cpu315pn).filter((x) => x.property === 'access.host')).toHaveLength(0);
  });
});
