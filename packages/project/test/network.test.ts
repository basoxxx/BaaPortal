import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  assignmentList,
  checkDevice,
  checkHardware,
  checkNetworks,
  configuredAccess,
  connectNode,
  crossReferences,
  createSubnet,
  deleteModule,
  deleteSubnet,
  deviceNodes,
  insertModule,
  insertStation,
  insertStationModule,
  ioRanges,
  ipValid,
  maskValid,
  readBaap,
  setNodeAddress,
  writeBaap,
  type Project,
} from '../src/index';
import { cpu315pn, makeDevice, makeProject } from './fixtures';

const CP = '6GK7 343-1EX30-0XE0';
const DI16 = '6ES7 321-1BH02-0AA0';
const ET200S = '6ES7 151-1AA05-0AB0';
const ET200SPN = '6ES7 151-3AA23-0AB0';
const ET200M = '6ES7 153-1AA03-0XB0';
const DI2 = '6ES7 131-4BB01-0AA0';
const DO4 = '6ES7 132-4BD02-0AA0';

function project(): Project {
  const p = makeProject();
  p.subnets = [
    createSubnet('MPI', 'mpi', 'MPI_1'),
    createSubnet('PROFIBUS', 'dp', 'PROFIBUS_1'),
    createSubnet('ETHERNET', 'eth', 'Ethernet_1'),
  ];
  return p;
}
const dev = (p: Project) => p.devices[0]!;
const codes = (p: Project) => checkNetworks(p).map((i) => `${i.node ?? i.subnetId}:${i.code}`);

describe('sottoreti e interfacce', () => {
  it('interfacce della CPU, del CP e delle stazioni', () => {
    const p = project();
    insertModule(dev(p), CP, 0, 4, 'cp');
    insertStation(dev(p), ET200S, 'st', 'ET200S_1');
    expect(deviceNodes(dev(p)).map((n) => `${n.port}:${n.kind}`)).toEqual([
      'X1:MPI/DP',
      'X2:PN',
      'cp:PN',
      'st:DP',
    ]);
  });

  it('collegamento con indirizzo proposto e scollegamento', () => {
    const p = project();
    const id = dev(p).id;
    expect(connectNode(p, id, 'X1', 'mpi')).toBe(true);
    expect(connectNode(p, id, 'X2', 'mpi')).toBe(false); // PN su MPI
    expect(connectNode(p, id, 'X2', 'eth')).toBe(true);
    expect(connectNode(p, id, 'X9', 'eth')).toBe(false);
    const nodes = deviceNodes(dev(p));
    expect(nodes[0]).toMatchObject({ subnetId: 'mpi', address: 2 });
    expect(nodes[1]).toMatchObject({ subnetId: 'eth', ip: '192.168.0.1' });
    expect(connectNode(p, id, 'X1', undefined)).toBe(true);
    expect(deviceNodes(dev(p))[0]!.address).toBeUndefined();
    expect(codes(p)).toEqual([`${id}/X1:NET_NOT_CONNECTED`]);
  });

  it('doppioni, campi e IP non validi', () => {
    const p = project();
    const id = dev(p).id;
    insertModule(dev(p), CP, 0, 4, 'cp');
    insertStation(dev(p), ET200S, 'st', 'ET200S_1');
    connectNode(p, id, 'X1', 'dp');
    connectNode(p, id, 'X2', 'eth');
    connectNode(p, id, 'cp', 'eth');
    connectNode(p, id, 'st', 'dp');
    expect(codes(p)).toEqual([]);
    setNodeAddress(p, id, 'st', { address: 2 });
    setNodeAddress(p, id, 'cp', { ip: '192.168.0.1' });
    expect(codes(p)).toEqual([`${id}/cp:NET_IP_DUPLICATE`, `${id}/st:NET_ADDRESS_DUPLICATE`]);
    setNodeAddress(p, id, 'st', { address: 127 });
    setNodeAddress(p, id, 'cp', { ip: '192.168.0.255' }); // broadcast con /24
    expect(codes(p)).toEqual([`${id}/cp:NET_IP_INVALID`, `${id}/st:NET_ADDRESS_OUT_OF_RANGE`]);
    p.subnets![1]!.highestAddress = 31;
    setNodeAddress(p, id, 'st', { address: 40 });
    expect(codes(p)).toContain(`${id}/st:NET_ADDRESS_OUT_OF_RANGE`);
  });

  it('stazione senza master sulla sua sottorete e sottorete eliminata', () => {
    const p = project();
    const id = dev(p).id;
    insertStation(dev(p), ET200SPN, 'st', 'ET200S PN');
    expect(dev(p).hardware!.stations![0]!.deviceName).toBe('et200s-pn');
    connectNode(p, id, 'X1', 'mpi');
    connectNode(p, id, 'X2', 'eth');
    connectNode(p, id, 'st', 'eth');
    expect(codes(p)).toEqual([]);
    connectNode(p, id, 'X2', undefined);
    expect(codes(p)).toEqual([`${id}/X2:NET_NOT_CONNECTED`, `${id}/st:NET_STATION_NO_MASTER`]);
    deleteSubnet(p, 'eth');
    expect(deviceNodes(dev(p)).find((n) => n.port === 'st')!.subnetId).toBeUndefined();
  });

  it('parametri della sottorete', () => {
    expect(maskValid('255.255.255.0')).toBe(true);
    expect(maskValid('255.0.255.0')).toBe(false);
    expect(ipValid('10.0.0.1', '255.0.0.0')).toBe(true);
    expect(ipValid('10.0.0.0', '255.0.0.0')).toBe(false);
    expect(ipValid('300.1.1.1')).toBe(false);
    expect(ipValid('127.0.0.1')).toBe(false);
    const p = project();
    p.subnets![2]!.subnetMask = '255.0.255.0';
    p.subnets![2]!.gateway = 'x';
    p.subnets![0]!.rate = '12M'; // non su MPI
    expect(codes(p).filter((c) => !c.includes('NOT_CONNECTED'))).toEqual([
      'mpi:NET_RATE_INVALID',
      'eth:NET_MASK_INVALID',
      'eth:NET_GATEWAY_INVALID',
    ]);
  });

  it('il CP tolto lascia anche il collegamento', () => {
    const p = project();
    insertModule(dev(p), CP, 0, 4, 'cp');
    connectNode(p, dev(p).id, 'cp', 'eth');
    deleteModule(dev(p), 'cp');
    expect(dev(p).hardware!.interfaces!.map((i) => i.port)).toEqual([]);
  });

  it('indirizzi configurati per «Dispositivi accessibili»', () => {
    const p = project();
    expect(configuredAccess(p, dev(p).id)).toEqual({});
    connectNode(p, dev(p).id, 'X1', 'mpi');
    connectNode(p, dev(p).id, 'X2', 'eth');
    expect(configuredAccess(p, dev(p).id)).toEqual({ ip: '192.168.0.1', mpi: 2 });
  });
});

describe('periferia decentrata ET 200', () => {
  it('indirizzi liberi nello spazio della CPU, sovrapposizioni e assegnazione', () => {
    const p = project();
    const d = dev(p);
    insertModule(d, DI16, 0, 4, 'di'); // IB0..1
    insertStation(d, ET200S, 'st', 'ET200S_1');
    expect(insertStationModule(d, 'st', DI2, 1, 'e1')).toBe(true);
    expect(insertStationModule(d, 'st', DO4, 2, 'e2')).toBe(true);
    expect(insertStationModule(d, 'st', DO4, 2, 'x')).toBe(false); // occupato
    expect(insertStationModule(d, 'st', DI16, 3, 'x')).toBe(false); // SM S7-300 nella ET 200S
    insertStation(d, ET200M, 'm', 'ET200M_1');
    expect(insertStationModule(d, 'm', DI16, 3, 'x')).toBe(false); // posto 3 non ammesso
    expect(insertStationModule(d, 'm', DI16, 4, 'e3')).toBe(true);
    const ranges = ioRanges(d);
    expect(ranges.I.map((r) => `${r.moduleId}:${r.from}-${r.to}`)).toEqual([
      'di:0-1',
      'e1:2-2',
      'e3:3-4',
    ]);
    expect(ranges.Q.map((r) => `${r.moduleId}:${r.from}`)).toEqual(['e2:0']);
    expect(checkHardware(d, cpu315pn)).toEqual([]);

    // Sovrapposizione con il rack, segnalata come per i moduli centrali.
    d.hardware!.stations![0]!.modules[0]!.inputStart = 1;
    expect(checkHardware(d, cpu315pn).map((i) => `${i.moduleId}:${i.code}`)).toEqual([
      'e1:HW_ADDRESS_OVERLAP',
    ]);
    d.hardware!.stations![0]!.modules[0]!.inputStart = 2;

    // L'elenco di assegnazione non segnala più IO_NOT_CONFIGURED per i byte della ET 200.
    d.tagTables[0]!.tags.push(
      { id: 't1', name: 'Dec', type: 'Bool', address: '%I2.0', hmi: false, comment: '' },
      { id: 't2', name: 'Fuori', type: 'Bool', address: '%I9.0', hmi: false, comment: '' },
    );
    const notConf = checkDevice(d, cpu315pn)
      .filter((x) => x.code === 'IO_NOT_CONFIGURED')
      .map((x) => ('id' in x.ref ? x.ref.id : ''));
    expect(notConf).toEqual(['t2']);
    const list = assignmentList(d, crossReferences(d), cpu315pn.limits);
    const rowsI = list.find((x) => x.area === 'I')!.rows;
    expect(rowsI.find((r) => r.byte === 2)!.unconfigured).toBe(false);
    expect(rowsI.find((r) => r.byte === 9)!.unconfigured).toBe(true);
  });

  it('modulo nel posto sbagliato di un file modificato a mano', () => {
    const d = makeDevice();
    insertStation(d, ET200M, 'm', 'ET200M_1');
    insertStationModule(d, 'm', DI16, 4, 'e1');
    d.hardware!.stations![0]!.modules[0]!.slot = 2;
    expect(checkHardware(d, cpu315pn).map((i) => i.code)).toEqual(['HW_SLOT_INVALID']);
  });
});

describe('file .baap', () => {
  it('sottoreti, interfacce e stazioni fanno il giro', () => {
    const p = project();
    const id = dev(p).id;
    insertModule(dev(p), CP, 0, 4, 'cp');
    insertStation(dev(p), ET200SPN, 'st', 'ET200S_1');
    insertStationModule(dev(p), 'st', DI2, 1, 'e1');
    connectNode(p, id, 'cp', 'eth');
    connectNode(p, id, 'st', 'eth');
    const back = readBaap(writeBaap(p, { appVersion: 'test' }));
    expect(back.subnets).toEqual(p.subnets);
    expect(back.devices[0]!.hardware).toEqual(dev(p).hardware);
  });

  it('i file senza reti si aprono come prima', () => {
    const p = makeProject();
    const back = readBaap(writeBaap(p, { appVersion: 'test' }));
    expect(back.subnets).toBeUndefined();
    expect(deviceNodes(back.devices[0]!).every((n) => n.subnetId === undefined)).toBe(true);
    expect(checkNetworks(back).map((i) => i.code)).toEqual([
      'NET_NOT_CONNECTED',
      'NET_NOT_CONNECTED',
    ]);
  });

  it('una sottorete di tipo sconosciuto o una stazione con id doppio si rifiutano', () => {
    const p = project();
    insertStation(dev(p), ET200S, 'st', 'A');
    const files = unzipSync(writeBaap(p, { appVersion: 'test' }));
    const pj = JSON.parse(strFromU8(files['project.json']!));
    pj.subnets[0].type = 'CAN';
    expect(() =>
      readBaap(zipSync({ ...files, 'project.json': strToU8(JSON.stringify(pj)) })),
    ).toThrow();
    const path = `plc/${dev(p).id}/device.json`;
    const dj = JSON.parse(strFromU8(files[path]!));
    dj.hardware.stations.push({ ...dj.hardware.stations[0] });
    expect(() => readBaap(zipSync({ ...files, [path]: strToU8(JSON.stringify(dj)) }))).toThrow();
  });
});
