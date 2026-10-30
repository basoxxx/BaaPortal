import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  BAAPLIB_MAX_BYTES,
  BaapFormatError,
  createCodeBlock,
  createLibraryItem,
  createProject,
  libraryItemObjects,
  LibraryFileError,
  readBaap,
  readBaaplib,
  withDependencies,
  writeBaap,
  writeBaaplib,
  type Library,
  type ObjectRef,
  type PlcDevice,
} from '../src/index';
import { makeDevice, now, seq } from './fixtures';

const blockRef = (d: PlcDevice, name: string): ObjectRef => ({
  kind: 'block',
  deviceId: d.id,
  id: d.blocks.find((b) => b.name === name)!.id,
});
const names = (d: PlcDevice, refs: ObjectRef[]) =>
  refs.map((r) =>
    r.kind === 'udt'
      ? d.udts.find((u) => u.id === (r as { id: string }).id)!.name
      : d.blocks.find((b) => b.id === (r as { id: string }).id)!.name,
  );

describe('dipendenze di un modello', () => {
  it('un FB porta l FB della multi-istanza e i suoi UDT, gli UDT prima', () => {
    const d = makeDevice(seq());
    expect(names(d, withDependencies(d, [blockRef(d, 'Linea')]))).toEqual([
      'Asse',
      'Linea',
      'Nastro',
    ]);
  });

  it('un DB di istanza porta il suo FB; un UDT gli UDT annidati; i chiamati per CALL', () => {
    const d = makeDevice(seq());
    expect(names(d, withDependencies(d, [blockRef(d, 'Nastro_DB')]))).toEqual([
      'Asse',
      'Nastro',
      'Nastro_DB',
    ]);
    const assi = { kind: 'udt' as const, deviceId: d.id, id: d.udts[1]!.id };
    expect(names(d, withDependencies(d, [assi]))).toEqual(['Assi', 'Asse']);
    const fc = createCodeBlock({ kind: 'FC', number: 7, name: 'Calc', language: 'AWL' });
    const ob = createCodeBlock({ kind: 'OB', number: 1, name: 'Main', language: 'AWL' });
    ob.networks[0]!.source = 'CALL "Calc"';
    d.blocks.push(fc, ob);
    expect(names(d, withDependencies(d, [blockRef(d, 'Main')]))).toEqual(['Main', 'Calc']);
  });

  it('createLibraryItem copia in profondità, prende il nome del primo oggetto, senza dipendenze se chiesto', () => {
    const d = makeDevice(seq());
    const item = createLibraryItem(d, [blockRef(d, 'Linea')], { newId: () => 'it1' })!;
    expect(item.name).toBe('Linea');
    expect(libraryItemObjects(item).map((o) => `${o.label} ${o.name}`)).toEqual([
      'UDT1 Asse',
      'FB2 Linea',
      'FB1 Nastro',
    ]);
    item.blocks[0]!.name = 'Cambiato';
    expect(d.blocks.some((b) => b.name === 'Cambiato')).toBe(false);
    const only = createLibraryItem(d, [blockRef(d, 'Linea')], { newId: () => 'x', deps: false })!;
    expect(only.blocks).toHaveLength(1);
    expect(createLibraryItem(d, [], { newId: () => 'x' })).toBeNull();
  });
});

function sampleLibrary(): Library {
  const d = makeDevice(seq());
  const item = createLibraryItem(
    d,
    [blockRef(d, 'Linea'), { kind: 'tagTable', deviceId: d.id, id: d.tagTables[0]!.id }],
    { newId: () => 'item-1', group: 'Motori' },
  )!;
  return { items: [item], groups: ['Motori', 'Vuota'] };
}

describe('libreria di progetto nel .baap', () => {
  it('si salva e si rilegge uguale; un progetto senza libreria resta senza', () => {
    const p = createProject({ name: 'P', author: '', comment: '' }, now);
    p.devices.push(makeDevice(seq('p')));
    expect('library' in readBaap(writeBaap(p, { appVersion: '1' }))).toBe(false);
    p.library = sampleLibrary();
    const back = readBaap(writeBaap(p, { appVersion: '1' }));
    expect(back.library).toEqual(p.library);
    expect(back.devices).toEqual(p.devices);
  });

  it('una libreria non valida nel file rende il progetto illeggibile', () => {
    const p = createProject({ name: 'P', author: '', comment: '' }, now);
    p.library = sampleLibrary();
    p.library.items.push(structuredClone(p.library.items[0]!));
    expect(() => readBaap(writeBaap(p, { appVersion: '1' }))).toThrow(BaapFormatError);
  });
});

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof LibraryFileError ? e.code : String(e);
  }
  return 'ok';
};
const zip = (files: Record<string, unknown>) =>
  zipSync(
    Object.fromEntries(
      Object.entries(files).map(([k, v]) => [
        k,
        strToU8(typeof v === 'string' ? v : JSON.stringify(v)),
      ]),
    ),
  );
const manifest = { format: 'baaportal-library', formatVersion: 1 };

describe('file .baaplib', () => {
  it('si scrive e si rilegge uguale', () => {
    const lib = sampleLibrary();
    expect(readBaaplib(writeBaaplib(lib, { appVersion: '1.7.0' }))).toEqual(lib);
  });

  it('rifiuta file malformati con un codice', () => {
    const lib = sampleLibrary();
    expect(code(() => readBaaplib(strToU8('ciao')))).toBe('NOT_ZIP');
    expect(code(() => readBaaplib(zip({ 'library.json': lib })))).toBe('MISSING_MANIFEST');
    expect(code(() => readBaaplib(zip({ 'manifest.json': '{', 'library.json': lib })))).toBe(
      'MISSING_MANIFEST',
    );
    expect(
      code(() =>
        readBaaplib(zip({ 'manifest.json': { format: 'baaportal-project' }, 'library.json': lib })),
      ),
    ).toBe('WRONG_FORMAT');
    expect(
      code(() =>
        readBaaplib(
          zip({ 'manifest.json': { ...manifest, formatVersion: 2 }, 'library.json': lib }),
        ),
      ),
    ).toBe('NEWER_FORMAT');
    expect(code(() => readBaaplib(zip({ 'manifest.json': manifest })))).toBe('INVALID');
    expect(code(() => readBaaplib(zip({ 'manifest.json': manifest, 'library.json': '[' })))).toBe(
      'INVALID',
    );
    expect(
      code(() =>
        readBaaplib(
          zip({ 'manifest.json': manifest, 'library.json': { items: [{}], groups: [] } }),
        ),
      ),
    ).toBe('INVALID');
    const dup = structuredClone(lib);
    dup.items[0]!.blocks.push(structuredClone(dup.items[0]!.blocks[0]!));
    expect(code(() => readBaaplib(zip({ 'manifest.json': manifest, 'library.json': dup })))).toBe(
      'INVALID',
    );
  });

  it('rifiuta file troppo grandi e voci che si gonfiano oltre il tetto', () => {
    expect(code(() => readBaaplib(new Uint8Array(BAAPLIB_MAX_BYTES + 1)))).toBe('TOO_BIG');
    // Un manifesto di 1 MB di spazi: compresso è minuscolo, gonfiato supera il tetto.
    const bomb = zipSync({ 'manifest.json': new Uint8Array(1024 * 1024).fill(32) }, { level: 9 });
    expect(bomb.length).toBeLessThan(10_000);
    expect(code(() => readBaaplib(bomb))).toBe('TOO_BIG');
  });
});
