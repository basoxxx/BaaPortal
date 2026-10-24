import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  addWatchTable,
  checkDevice,
  createWatchRow,
  readBaap,
  renameWithReferences,
  watchResolverFor,
  writeBaap,
  type Project,
} from '../src/index';
import { cpu315pn, makeProject, seq } from './fixtures';

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type Any = any;
const files = (p: Project) => unzipSync(writeBaap(p, { appVersion: 'x' }));
const json = (f: Record<string, Uint8Array>, path: string): Any => JSON.parse(strFromU8(f[path]!));
const put = (f: Record<string, Uint8Array>, path: string, v: unknown) => {
  f[path] = strToU8(JSON.stringify(v));
};

function withTable(): Project {
  const p = makeProject();
  const d = p.devices[0]!;
  const newId = seq('w');
  const t = addWatchTable(d, 'Prova', newId);
  t.rows.push(
    { ...createWatchRow('"Start"', 'BOOL', newId), modify: 'TRUE', comment: 'avvio' },
    createWatchRow('MW10', 'DEC', newId),
  );
  addWatchTable(d, 'Altra', newId);
  return p;
}

describe('tabelle di controllo nel file (formato 4)', () => {
  it('salva e riapre una tabella con righe, formato, comando e commento', () => {
    const p = withTable();
    const back = readBaap(writeBaap(p, { appVersion: 'x' }));
    expect(back).toEqual(p);
    expect(back.devices[0]!.watchTables.map((w) => w.name)).toEqual(['Prova', 'Altra']);
    expect(back.devices[0]!.watchTables[0]!.rows[0]).toMatchObject({
      operand: '"Start"',
      modify: 'TRUE',
      comment: 'avvio',
    });
  });

  it('un file per tabella; device.json elenca gli id nell ordine', () => {
    const p = withTable();
    const d = p.devices[0]!;
    const f = files(p);
    expect(json(f, `plc/${d.id}/device.json`).watchTables).toEqual(['w1', 'w4']);
    expect(json(f, `plc/${d.id}/watch/w1.json`).rows).toHaveLength(2);
  });

  it('migrazione 3→4: un file del formato 3 si apre con watchTables [] su ogni PLC', () => {
    const p = makeProject();
    const second = structuredClone(p.devices[0]!);
    second.id = 'dev2';
    p.devices.push(second);
    const f = files(p);
    put(f, 'baaportal.json', { format: 'baaportal-project', formatVersion: 3 });
    const proj = json(f, 'project.json');
    proj.formatVersion = 3;
    put(f, 'project.json', proj);
    for (const d of p.devices) {
      const dev = json(f, `plc/${d.id}/device.json`);
      delete dev.watchTables;
      put(f, `plc/${d.id}/device.json`, dev);
    }
    const opened = readBaap(zipSync(f));
    expect(opened.formatVersion).toBe(4);
    expect(opened.devices.map((d) => d.watchTables)).toEqual([[], []]);
    expect(opened).toEqual(p);
  });

  it('un formato 3 con una chiave watchTables estranea la ignora', () => {
    const p = makeProject();
    const d = p.devices[0]!;
    const f = files(p);
    put(f, 'baaportal.json', { format: 'baaportal-project', formatVersion: 3 });
    const proj = json(f, 'project.json');
    proj.formatVersion = 3;
    put(f, 'project.json', proj);
    const dev = json(f, `plc/${d.id}/device.json`);
    dev.watchTables = ['zz'];
    put(f, `plc/${d.id}/device.json`, dev);
    expect(readBaap(zipSync(f)).devices[0]!.watchTables).toEqual([]);
  });

  it('un file elencato ma mancante, o un formato di riga sconosciuto, è INVALID_SCHEMA', () => {
    const p = withTable();
    const d = p.devices[0]!;
    const f = files(p);
    delete f[`plc/${d.id}/watch/w1.json`];
    expect(() => readBaap(zipSync(f))).toThrow(/INVALID_SCHEMA/);
    const g = files(p);
    const t = json(g, `plc/${d.id}/watch/w1.json`);
    t.rows[0].format = 'OCT';
    put(g, `plc/${d.id}/watch/w1.json`, t);
    expect(() => readBaap(zipSync(g))).toThrow(/INVALID_SCHEMA/);
  });

  it('un id di riga ripetuto nel dispositivo è INVALID_SCHEMA', () => {
    const p = withTable();
    p.devices[0]!.watchTables[1]!.rows.push(createWatchRow('MW0', 'DEC', () => 'w2'));
    expect(() => readBaap(writeBaap(p, { appVersion: 'x' }))).toThrow(/INVALID_SCHEMA/);
  });

  it('rinominare una tabella cambia solo il nome', () => {
    const p = withTable();
    const d = p.devices[0]!;
    renameWithReferences(d, { kind: 'watchTable', deviceId: d.id, id: 'w1' }, 'Nuova');
    expect(d.watchTables[0]).toMatchObject({ name: 'Nuova' });
    expect(d.watchTables[0]!.rows).toHaveLength(2);
  });
});

describe('risoluzione degli operandi', () => {
  const dev = () => {
    const p = makeProject();
    const d = p.devices[0]!;
    // Un tag con tipo Int e uno Real a indirizzi assoluti; un T e un C nei tag.
    d.tagTables[0]!.tags.push(
      { id: 'tg1', name: 'Vel', type: 'Int', address: '%MW20', hmi: false, comment: '' },
      { id: 'tg2', name: 'Temp', type: 'Real', address: '%MD30', hmi: false, comment: '' },
      { id: 'tg3', name: 'Ritardo', type: 'S5Time', address: '%MW40', hmi: false, comment: '' },
      { id: 'tg4', name: 'Tim', type: 'Timer', address: '%T7', hmi: false, comment: '' },
    );
    return d;
  };
  const resolve = (text: string) => watchResolverFor(dev(), cpu315pn)(text);

  it('simbolo di variabile con tipo: indirizzo, dimensione e formato predefinito', () => {
    expect(resolve('"Vel"')).toMatchObject({
      ok: true,
      target: { area: 'M', byte: 20, size: 'W' },
      format: 'DEC',
      sign: 'signed',
    });
    expect(resolve('"Temp"')).toMatchObject({ ok: true, format: 'FLOAT', target: { size: 'D' } });
    expect(resolve('"Ritardo"')).toMatchObject({ ok: true, format: 'S5TIME' });
    expect(resolve('"Start"')).toMatchObject({
      ok: true,
      target: { area: 'I', byte: 0, bit: 0, size: 'X' },
      format: 'BOOL',
    });
  });

  it('indirizzi nudi: il formato segue la dimensione', () => {
    expect(resolve('M 5.3')).toMatchObject({
      ok: true,
      target: { area: 'M', byte: 5, bit: 3, size: 'X' },
      format: 'BOOL',
    });
    expect(resolve('MB10')).toMatchObject({ ok: true, format: 'HEX', target: { size: 'B' } });
    expect(resolve('MW10')).toMatchObject({ ok: true, format: 'DEC' });
    expect(resolve('%QD4')).toMatchObject({ ok: true, target: { area: 'Q', byte: 4, size: 'D' } });
    expect(resolve('PIW 256')).toMatchObject({
      ok: true,
      target: { area: 'PI', byte: 256, size: 'W' },
    });
    expect(resolve('PQW 256')).toMatchObject({ ok: true, target: { area: 'PQ', size: 'W' } });
    // mnemonici tedeschi
    expect(resolve('EB 2')).toMatchObject({ ok: true, target: { area: 'I', byte: 2, size: 'B' } });
  });

  it('DB: assoluto e simbolico, con il layout dei membri', () => {
    expect(resolve('DB1.DBW4')).toMatchObject({
      ok: true,
      target: { area: 'DB', db: 1, byte: 4, size: 'W' },
    });
    expect(resolve('DB1.DBX2.5')).toMatchObject({
      ok: true,
      target: { area: 'DB', db: 1, byte: 2, bit: 5, size: 'X' },
    });
    expect(resolve('"Dati".DBD8')).toMatchObject({
      ok: true,
      target: { area: 'DB', db: 1, byte: 8 },
    });
    // DB "Dati": A è un UDT Asse { Pos { X: Real } } -> X a offset 0
    expect(resolve('"Dati".A.Pos.X')).toMatchObject({
      ok: true,
      target: { area: 'DB', db: 1, byte: 0, size: 'D' },
      format: 'FLOAT',
    });
  });

  it('T e C: il numero sta in byte', () => {
    expect(resolve('T 5')).toMatchObject({
      ok: true,
      target: { area: 'T', byte: 5, size: 'W' },
      format: 'S5TIME',
    });
    expect(resolve('C3')).toMatchObject({
      ok: true,
      target: { area: 'C', byte: 3 },
      format: 'BCD',
    });
    expect(resolve('"Tim"')).toMatchObject({ ok: true, target: { area: 'T', byte: 7 } });
    expect(resolve('T 9999')).toMatchObject({ ok: false, code: 'RANGE' });
  });

  it('righe non valide: il motivo', () => {
    expect(resolve('')).toMatchObject({ ok: false, code: 'EMPTY' });
    expect(resolve('???')).toMatchObject({ ok: false, code: 'SYNTAX' });
    expect(resolve('"Inesistente"')).toMatchObject({ ok: false, code: 'UNKNOWN' });
    expect(resolve('"Dati".Nulla')).toMatchObject({ ok: false, code: 'UNKNOWN' });
    expect(resolve('L 0.0')).toMatchObject({ ok: false });
    expect(resolve('16#FF')).toMatchObject({ ok: false, code: 'NOT_OPERAND' });
    expect(resolve('"Dati".A')).toMatchObject({ ok: false, code: 'UNSUPPORTED' });
    expect(resolve('#loc')).toMatchObject({ ok: false });
  });
});

describe('controlli delle tabelle di controllo', () => {
  it('nome duplicato nel PLC e operando che non si risolve: avvisi, mai errori', () => {
    const p = withTable();
    const d = p.devices[0]!;
    d.watchTables[1]!.name = 'prova';
    d.watchTables[0]!.rows.push(createWatchRow('"Inesistente"', 'DEC', seq('x')));
    d.watchTables[0]!.rows.push(createWatchRow('', 'DEC', seq('y')));
    const out = checkDevice(d, cpu315pn).filter((x) => x.ref.kind === 'watchTable');
    expect(out.map((x) => [x.code, x.severity])).toEqual([
      ['WATCH_NAME_DUPLICATE', 'warning'],
      ['WATCH_OPERAND_INVALID', 'warning'],
      ['WATCH_NAME_DUPLICATE', 'warning'],
    ]);
    expect(out[1]!.params).toEqual({ operand: '"Inesistente"', reason: 'UNKNOWN' });
  });

  it('una tabella valida non produce diagnostica', () => {
    const d = withTable().devices[0]!;
    expect(checkDevice(d, cpu315pn).filter((x) => x.ref.kind === 'watchTable')).toEqual([]);
  });
});
