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
    ['porta fuori campo', { host: 'h', port: 0, rack: 0, slot: 2, connectionType: 'PG' }],
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
