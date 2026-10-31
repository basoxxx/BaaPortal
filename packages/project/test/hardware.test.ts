import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  assignmentList,
  checkDevice,
  checkHardware,
  crossReferences,
  deleteModule,
  firstFreeSlot,
  insertModule,
  ioRanges,
  moveModule,
  readBaap,
  writeBaap,
  type PlcDevice,
} from '../src/index';
import { findModule } from '@baaportal/catalog';
import { cpu315pn, makeDevice, makeProject, ob1 } from './fixtures';

const PS = '6ES7 307-1EA01-0AA0';
const DI16 = '6ES7 321-1BH02-0AA0';
const DO16 = '6ES7 322-1BH01-0AA0';
const AI8 = '6ES7 331-7KF02-0AB0';
const IM360 = '6ES7 360-3AA01-0AA0';
const IM361 = '6ES7 361-3CA01-0AA0';

function rack(): PlcDevice {
  const dev = makeDevice();
  expect(insertModule(dev, PS, 0, 1, 'ps')).toBe(true);
  expect(insertModule(dev, DI16, 0, 4, 'di')).toBe(true);
  expect(insertModule(dev, DO16, 0, 5, 'do')).toBe(true);
  expect(insertModule(dev, AI8, 0, 6, 'ai')).toBe(true);
  return dev;
}
const codes = (dev: PlcDevice) =>
  checkHardware(dev, cpu315pn).map((i) => `${i.moduleId}:${i.code}`);

describe('configurazione hardware S7-300', () => {
  it('inserimento con gli indirizzi fissi del posto', () => {
    const dev = rack();
    const m = (id: string) => dev.hardware!.modules.find((x) => x.id === id)!;
    expect(m('ps')).toMatchObject({ slot: 1, name: 'PS 307 5A' });
    expect(m('ps').inputStart).toBeUndefined();
    expect(m('di')).toMatchObject({ inputStart: 0 });
    expect(m('di').outputStart).toBeUndefined();
    expect(m('do')).toMatchObject({ outputStart: 4 });
    expect(m('ai')).toMatchObject({ inputStart: 288 });
    expect(ioRanges(dev).I.map((r) => [r.from, r.to])).toEqual([
      [0, 1],
      [288, 303],
    ]);
    expect(codes(dev)).toEqual([]);
  });

  it('posti sbagliati o occupati e il posto 2 della CPU si rifiutano', () => {
    const dev = rack();
    expect(insertModule(dev, DI16, 0, 4, 'x')).toBe(false); // occupato
    expect(insertModule(dev, DI16, 0, 2, 'x')).toBe(false); // CPU
    expect(insertModule(dev, DI16, 0, 3, 'x')).toBe(false); // solo IM
    expect(insertModule(dev, PS, 0, 7, 'x')).toBe(false);
    expect(insertModule(dev, DI16, 4, 4, 'x')).toBe(false); // rack inesistente
    expect(insertModule(dev, 'nessuno', 0, 7, 'x')).toBe(false);
    expect(firstFreeSlot(dev, findModule(DI16)!, 0)).toBe(7);
    expect(firstFreeSlot(dev, findModule(PS)!, 0)).toBeUndefined();
  });

  it('spostamento: gli indirizzi fissi seguono il posto, quelli scelti restano', () => {
    const dev = rack();
    expect(moveModule(dev, 'di', 0, 8)).toBe(true);
    const di = dev.hardware!.modules.find((x) => x.id === 'di')!;
    expect(di).toMatchObject({ slot: 8, inputStart: 16 });
    di.inputStart = 100;
    expect(moveModule(dev, 'di', 0, 9)).toBe(true);
    expect(di).toMatchObject({ slot: 9, inputStart: 100 });
    expect(moveModule(dev, 'di', 0, 5)).toBe(false); // occupato da DO
    expect(deleteModule(dev, 'di')).toBe(true);
    expect(deleteModule(dev, 'di')).toBe(false);
  });

  it('sovrapposizione e indirizzi oltre i limiti della CPU sono errori', () => {
    const dev = rack();
    dev.hardware!.modules.find((x) => x.id === 'ai')!.inputStart = 1;
    expect(codes(dev)).toEqual(['ai:HW_ADDRESS_OVERLAP']);
    dev.hardware!.modules.find((x) => x.id === 'ai')!.inputStart = cpu315pn.limits.inputBytes - 8;
    expect(codes(dev)).toEqual(['ai:HW_ADDRESS_OUT_OF_RANGE']);
    const d = checkDevice(dev, cpu315pn).find((x) => x.code === 'HW_ADDRESS_OUT_OF_RANGE')!;
    expect(d).toMatchObject({ severity: 'error', property: 'hardware.ai', params: { area: 'I' } });
  });

  it('rack di ampliamento solo con IM 360 e IM 361; posto e modulo sconosciuto', () => {
    const dev = rack();
    dev.hardware!.modules.push({
      id: 'r1',
      rack: 1,
      slot: 4,
      orderNumber: DI16,
      name: 'DI',
      comment: '',
      inputStart: 32,
    });
    expect(codes(dev)).toEqual(['r1:HW_RACK_NOT_CONNECTED']);
    expect(insertModule(dev, IM360, 0, 3, 'im0')).toBe(true);
    expect(insertModule(dev, IM361, 1, 3, 'im1')).toBe(true);
    expect(codes(dev)).toEqual([]);
    dev.hardware!.modules.push(
      { id: 'bad', rack: 0, slot: 2, orderNumber: DI16, name: 'x', comment: '' },
      { id: 'dup', rack: 0, slot: 4, orderNumber: DO16, name: 'y', comment: '' },
      { id: 'unk', rack: 0, slot: 10, orderNumber: '6ES7 999-0AA00-0AA0', name: 'z', comment: '' },
    );
    expect(codes(dev)).toEqual([
      'bad:HW_SLOT_INVALID',
      'dup:HW_SLOT_TAKEN',
      'unk:HW_MODULE_UNKNOWN',
    ]);
  });

  it('I/Q del programma e dei tag senza modulo: solo avviso, e solo con una configurazione', () => {
    const dev = rack();
    dev.tagTables[0]!.tags.push({
      id: 'q',
      name: 'Fuori',
      type: 'Bool',
      address: '%Q20.0',
      hmi: false,
      comment: '',
    });
    const warn = checkDevice(dev, cpu315pn).filter((d) => d.code === 'IO_NOT_CONFIGURED');
    expect(warn.map((d) => [d.severity, d.ref.kind === 'tag' && d.ref.id])).toEqual([
      ['warning', 'q'],
    ]);
    const old = makeDevice();
    old.tagTables[0]!.tags.push({ ...dev.tagTables[0]!.tags.at(-1)! });
    expect(checkDevice(old, cpu315pn).some((d) => d.code === 'IO_NOT_CONFIGURED')).toBe(false);

    ob1(dev).networks[0]!.source = 'A I 0.0\n= Q 30.0';
    const list = assignmentList(dev, crossReferences(dev), cpu315pn.limits);
    const row = (a: string, b: number) =>
      list.find((x) => x.area === a)!.rows.find((r) => r.byte === b)!;
    expect(row('I', 0).unconfigured).toBe(false);
    expect(row('Q', 30).unconfigured).toBe(true);
    expect(row('Q', 20).unconfigured).toBe(true);
    expect(
      assignmentList(old, crossReferences(old), cpu315pn.limits)
        .flatMap((a) => a.rows)
        .every((r) => r.unconfigured === undefined),
    ).toBe(true);
  });
});

describe('configurazione hardware nel file .baap', () => {
  it('andata e ritorno identica', () => {
    const project = makeProject();
    const dev = project.devices[0]!;
    insertModule(dev, PS, 0, 1, 'ps');
    insertModule(dev, AI8, 0, 4, 'ai');
    dev.hardware!.modules[1]!.comment = 'Livelli';
    const back = readBaap(writeBaap(project, { appVersion: 'test' }));
    expect(back.devices[0]!.hardware).toEqual(dev.hardware);
  });

  it('un file senza configurazione si apre senza `hardware`', () => {
    const project = makeProject();
    const back = readBaap(writeBaap(project, { appVersion: 'test' }));
    expect('hardware' in back.devices[0]!).toBe(false);
    expect('simPanel' in back.devices[0]!).toBe(false);
  });

  it('preferenze del pannello di test (2.1): andata e ritorno', () => {
    const project = makeProject();
    project.devices[0]!.simPanel = { hex: false, inputs: [3, 9], outputs: [4] };
    const back = readBaap(writeBaap(project, { appVersion: 'test' }));
    expect(back.devices[0]!.simPanel).toEqual({ hex: false, inputs: [3, 9], outputs: [4] });
  });

  it('una configurazione malformata o con id ripetuti è INVALID_SCHEMA', () => {
    const project = makeProject();
    const dev = project.devices[0]!;
    insertModule(dev, PS, 0, 1, 'ps');
    const files = unzipSync(writeBaap(project, { appVersion: 'test' }));
    const path = `plc/${dev.id}/device.json`;
    const patch = (f: (j: { hardware: { modules: Record<string, unknown>[] } }) => void) => {
      const j = JSON.parse(strFromU8(files[path]!));
      f(j);
      return zipSync({ ...files, [path]: strToU8(JSON.stringify(j)) });
    };
    expect(() => readBaap(patch((j) => (j.hardware.modules[0]!.slot = 12)))).toThrow(
      'INVALID_SCHEMA',
    );
    expect(() => readBaap(patch((j) => (j.hardware.modules[0]!.id = dev.blocks[0]!.id)))).toThrow(
      'INVALID_SCHEMA',
    );
  });
});
