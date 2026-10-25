import { readBaap, writeBaap } from '@baaportal/project';
import { beforeAll, describe, expect, it } from 'vitest';
import { findCpu } from '@baaportal/catalog';
import {
  compileDevice,
  createCodeBlock,
  createGlobalDb,
  createPlcDevice,
  createProject,
  type PlcDevice,
} from '@baaportal/project';
import { parseBlockFile } from '@baaportal/s7comm';
import { initI18n } from '../../src/i18n';
import { createAppStore } from '../../src/state/store';
import { compareBlocks, type CompareProjectBlock } from '../../src/online/compare';
import type { OnlineBlock, PlcAccess, PlcUploadedFile } from '../../src/online/plcTypes';
import {
  buildUploadedProject,
  cpuFor,
  uploadFromDevice,
  uploadedProjectName,
} from '../../src/online/uploadProject';
import { FakeBridge } from '../fakeBridge';

const ACCESS: PlcAccess = { host: '192.168.0.10', rack: 0, slot: 2, connectionType: 'PG' };
const TEXTS = {
  defaultTagTable: 'Tabella',
  plc: 'PLC_1',
  namePrefix: 'Caricato da',
  missing: 'Blocchi non caricati dalla CPU',
};
const ORDER = '6ES7 315-2EH14-0AB0';

/** Un dispositivo con OB1, FC1 e DB1 e i file compilati, come li darebbe la CPU. */
function sample(): { dev: PlcDevice; files: PlcUploadedFile[] } {
  const dev = createPlcDevice({
    cpu: findCpu('cpu-315-2-pn-dp')!,
    orderNumber: ORDER,
    firmware: 'V3.3',
    name: 'PLC_1',
    texts: { defaultTagTable: 'Tabella' },
  });
  const ob = dev.blocks[0]!;
  ob.networks[0]!.source = 'CALL FC 1\nA %I0.0\n= %Q0.0';
  const fc = createCodeBlock({ kind: 'FC', number: 1, name: 'FC1', language: 'AWL' });
  fc.networks[0]!.source = 'A %I0.1\n= %Q0.1';
  const db = createGlobalDb({ number: 1, name: 'DB1' });
  dev.blocks.push(fc, db);
  const files = compileDevice(dev, findCpu(dev.cpu.typeId)).results.map((r) => {
    expect(r.file).toBeDefined();
    const b = dev.blocks.find((x) => x.id === r.blockId)!;
    return {
      type: b.kind === 'IDB' ? 'DB' : b.kind,
      number: b.number,
      bytes: r.file!,
    } as PlcUploadedFile;
  });
  return { dev, files };
}

const onlineOf = (files: PlcUploadedFile[]): OnlineBlock[] =>
  files.map((f) => {
    const p = parseBlockFile(f.bytes);
    return {
      type: f.type,
      number: f.number,
      loadLength: f.bytes.length,
      mc7Length: p.header.mc7Length,
      checksum: p.footer!.checksum,
    };
  });

const identity = { orderNumber: ORDER, moduleName: 'CPU 315-2 PN/DP' };
const build = (files: PlcUploadedFile[], id = identity) =>
  buildUploadedProject({ files, identity: id, access: ACCESS, now: new Date(), texts: TEXTS });

beforeAll(async () => {
  await initI18n('it');
});

describe('buildUploadedProject', () => {
  it('progetto nuovo con la CPU del catalogo e i blocchi in AWL', () => {
    const { files } = sample();
    const r = build(files);
    expect(r.cpuFound).toBe(true);
    expect(r.device.cpu.typeId).toBe('cpu-315-2-pn-dp');
    expect(r.device.cpu.orderNumber).toBe(ORDER);
    expect(r.device.blocks.map((b) => `${b.kind}${b.number}`).sort()).toEqual([
      'DB1',
      'FC1',
      'OB1',
    ]);
    for (const b of r.device.blocks) {
      if (b.kind !== 'DB') expect(b.language).toBe('AWL');
    }
    expect(r.device.properties.access).toEqual(ACCESS);
    expect(r.project.meta.name).toBe('Caricato da CPU 315-2 PN-DP 192.168.0.10');
    expect(r.skipped).toEqual([]);
  });

  it('CPU sconosciuta → CPU generica della stessa famiglia', () => {
    const { files } = sample();
    const r = build(files, { orderNumber: '6ES7 315-2ZZ99-0XX0' });
    expect(r.cpuFound).toBe(false);
    expect(r.device.cpu.typeId.startsWith('cpu-315')).toBe(true);
    expect(cpuFor('XXXX').found).toBe(false);
    expect(cpuFor('XXXX').cpu.id).toBe('cpu-315-2-pn-dp');
  });

  it('blocco non decodificabile → non ferma nulla, segnalato', () => {
    const { files } = sample();
    const bad: PlcUploadedFile = { type: 'FC', number: 9, bytes: new Uint8Array([1, 2, 3]) };
    const r = build([...files, bad]);
    expect(r.device.blocks).toHaveLength(3);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.label).toBe('FC9');
  });

  it('il nome del progetto è sempre un nome di file valido', () => {
    expect(uploadedProjectName({ orderNumber: 'X', moduleName: 'a/b:c.' }, ACCESS, 'P')).toBe(
      'P a-b-c. 192.168.0.10',
    );
  });

  it('andata e ritorno: carica dal dispositivo e poi confronta → tutti uguali', () => {
    const { files } = sample();
    const r = build(files);
    const again = compileDevice(r.device, findCpu(r.device.cpu.typeId)).results;
    const project: CompareProjectBlock[] = again.map((x) => {
      const b = r.device.blocks.find((y) => y.id === x.blockId)!;
      return {
        id: b.id,
        type: b.kind === 'IDB' ? 'DB' : b.kind,
        number: b.number,
        ...(x.file ? { file: x.file } : {}),
      };
    });
    const rows = compareBlocks(project, onlineOf(files));
    expect(rows.map((x) => `${x.type}${x.number}:${x.state}`).sort()).toEqual([
      'DB1:same',
      'FC1:same',
      'OB1:same',
    ]);
  });
});

describe('uploadFromDevice', () => {
  function setup() {
    const store = createAppStore();
    const bridge = new FakeBridge();
    const closed: string[] = [];
    let allow = true;
    const service = {
      close: async () => {
        closed.push('close');
        if (!allow) return false;
        store.getState().setDoc(null);
        return true;
      },
    } as never;
    return { store, bridge, service, closed, deny: () => (allow = false) };
  }

  it('crea un progetto non salvato, con la storia vuota e l’accesso nella CPU', async () => {
    const s = setup();
    const { files } = sample();
    s.bridge.plcUploadResults.push({ ok: true, files, identity, failed: [] });
    const out = await uploadFromDevice(s, ACCESS);
    expect(out).toBe('done');
    const st = s.store.getState();
    expect(st.doc?.dirty).toBe(true);
    expect(st.doc?.project.devices[0]?.properties.access).toEqual(ACCESS);
    expect(st.doc?.project.meta.name).toMatch(/^Caricato da /);
    expect(st.history.past).toHaveLength(0);
    expect(st.view).toBe('project');
    expect(s.bridge.plcUploadCalls).toEqual([ACCESS]);
  });

  it('interruzione → nessun progetto creato', async () => {
    const s = setup();
    s.bridge.plcUploadResults.push({ ok: false, cancelled: true });
    expect(await uploadFromDevice(s, ACCESS)).toBe('cancelled');
    expect(s.store.getState().doc).toBeNull();
    expect(s.closed).toEqual([]);
  });

  it('errore → messaggio e nessun progetto', async () => {
    const s = setup();
    s.bridge.plcUploadResults.push({ ok: false, error: 'Nessuna risposta' });
    expect(await uploadFromDevice(s, ACCESS)).toBe('failed');
    expect(s.store.getState().doc).toBeNull();
    expect(s.store.getState().messages.map((m) => m.textKey)).toContain('messages.uploadFailed');
  });

  it('CPU sconosciuta → avviso', async () => {
    const s = setup();
    const { files } = sample();
    s.bridge.plcUploadResults.push({
      ok: true,
      files,
      identity: { orderNumber: '6ES7 315-2ZZ99-0XX0' },
      failed: [],
    });
    await uploadFromDevice(s, ACCESS);
    expect(s.store.getState().messages.map((m) => m.textKey)).toContain(
      'messages.uploadCpuUnknown',
    );
  });

  it('progetto aperto con modifiche: la domanda di salvataggio annulla il caricato', async () => {
    const s = setup();
    const { files } = sample();
    s.store.getState().setDoc({
      project: createProject({ name: 'Vecchio', author: '', comment: '' }, new Date()),
      filePath: '/v.baap',
      dirty: true,
      revision: 1,
      savedRevision: 0,
    });
    s.deny();
    s.bridge.plcUploadResults.push({ ok: true, files, identity, failed: [] });
    expect(await uploadFromDevice(s, ACCESS)).toBe('cancelled');
    expect(s.closed).toEqual(['close']);
    expect(s.store.getState().doc?.project.meta.name).toBe('Vecchio');
  });

  it('il percorso del progetto non sovrascrive un file esistente', async () => {
    const s = setup();
    const { files } = sample();
    s.bridge.plcUploadResults.push({ ok: true, files, identity, failed: [] });
    const first = await s.bridge.defaultProjectDir();
    const name = 'Caricato da CPU 315-2 PN-DP 192.168.0.10';
    s.bridge.files.set(`${first}/${name}.baap`, new Uint8Array());
    await uploadFromDevice(s, ACCESS);
    expect(s.store.getState().doc?.filePath).toBe(`${first}/${name} (2).baap`);
  });
});

describe('blocchi non caricati', () => {
  function setup() {
    const store = createAppStore();
    const bridge = new FakeBridge();
    const service = {
      close: async () => {
        store.getState().setDoc(null);
        return true;
      },
    } as never;
    return { store, bridge, service };
  }
  const keys = (s: ReturnType<typeof setup>) =>
    s.store.getState().messages.map((m) => [m.severity, m.textKey]);

  it('un blocco rifiutato o non decodificabile resta scritto nel commento, anche dopo salva e riapri', () => {
    const { files } = sample();
    const bad: PlcUploadedFile = { type: 'FC', number: 9, bytes: new Uint8Array([1, 2, 3]) };
    const r = buildUploadedProject({
      files: [...files, bad],
      identity,
      access: ACCESS,
      now: new Date(),
      failed: [{ type: 'DB', number: 20, error: 'accesso negato' }],
      texts: TEXTS,
    });
    expect(r.missing).toBe(2);
    const c = r.project.meta.comment;
    expect(c).toMatch(/^Blocchi non caricati dalla CPU: DB20 \(accesso negato\), FC9 \(/);
    const back = readBaap(writeBaap(r.project, { appVersion: '0.1.0' }));
    expect(back.meta.comment).toBe(c);
  });

  it('senza mancanti il commento è vuoto', () => {
    expect(build(sample().files).project.meta.comment).toBe('');
  });

  it('failed non vuoto: avviso (non info) con i conteggi e riga nel commento', async () => {
    const s = setup();
    s.bridge.plcUploadResults.push({
      ok: true,
      files: sample().files,
      identity,
      failed: [{ type: 'DB', number: 20, error: 'protetto' }],
    });
    expect(await uploadFromDevice(s, ACCESS)).toBe('done');
    expect(keys(s)).toContainEqual(['warning', 'messages.uploadDonePartial']);
    expect(keys(s)).not.toContainEqual(['info', 'messages.uploadDone']);
    expect(s.store.getState().doc?.project.meta.comment).toContain('DB20 (protetto)');
  });

  it('tutti i blocchi rifiutati: errore, il progetto aperto resta e nessun progetto vuoto', async () => {
    const s = setup();
    s.store.getState().setDoc({
      project: createProject({ name: 'Vecchio', author: '', comment: '' }, new Date()),
      filePath: '/v.baap',
      dirty: true,
      revision: 1,
      savedRevision: 0,
    });
    s.bridge.plcUploadResults.push({
      ok: true,
      files: [],
      identity,
      failed: [
        { type: 'OB', number: 1, error: 'livello di protezione 3' },
        { type: 'FC', number: 1, error: 'livello di protezione 3' },
      ],
    });
    expect(await uploadFromDevice(s, ACCESS)).toBe('failed');
    expect(s.store.getState().doc?.project.meta.name).toBe('Vecchio');
    expect(s.store.getState().doc?.dirty).toBe(true);
    expect(keys(s)).toContainEqual(['error', 'messages.uploadNothing']);
  });

  it('firmware della CPU nel catalogo: lo usa; sconosciuto: il più recente e un avviso', async () => {
    const { files } = sample();
    const versions = findCpu('cpu-315-2-pn-dp')!.versions.find((v) => v.orderNumber === ORDER)!;
    const old = versions.firmware.at(-1)!;
    const ok = build(files, { ...identity, firmware: old } as never);
    expect(ok.device.cpu.firmware).toBe(old);
    expect(ok.firmwareUnknown).toBe(false);
    const bad = build(files, { ...identity, firmware: 'V9.9' } as never);
    expect(bad.device.cpu.firmware).toBe(versions.firmware[0]);
    expect(bad.firmwareUnknown).toBe(true);
    // senza firmware letto (CPU che non lo dà) resta il più recente, senza avviso
    expect(build(files).firmwareUnknown).toBe(false);
  });

  it('blocco importato in sola lettura: torna con i byte originali e confronta uguale', () => {
    const { dev } = sample();
    const dbBlock = dev.blocks.find((b) => b.kind === 'DB')!;
    const file = compileDevice(dev, findCpu(dev.cpu.typeId), [dbBlock.id]).results[0]!.file!;
    const bytes = file.slice();
    // genere 0x10 dell'SSB: il DB non si ricodifica e resta coi byte originali
    bytes[36 + parseBlockFile(file).header.mc7Length] = 0x10;
    const up: PlcUploadedFile = { type: 'DB', number: dbBlock.number, bytes };
    const r = build([up]);
    expect(r.device.blocks[0]!.mc7?.exact).toBe(false);
    const again = compileDevice(r.device, findCpu(r.device.cpu.typeId)).results[0]!;
    expect(Array.from(again.file!)).toEqual(Array.from(bytes));
    const rows = compareBlocks(
      [{ id: r.device.blocks[0]!.id, type: 'DB', number: dbBlock.number, file: again.file! }],
      onlineOf([up]),
    );
    expect(rows[0]!.state).toBe('same');
  });
});
