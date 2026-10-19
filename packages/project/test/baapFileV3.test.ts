import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { addSource, createSource, readBaap, writeBaap, type Project } from '../src/index';
import { makeProject, seq } from './fixtures';

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type Any = any;
type Files = Record<string, Uint8Array>;
const json = (f: Files, path: string): Any => JSON.parse(strFromU8(f[path]!));
const put = (f: Files, path: string, v: unknown) => {
  f[path] = strToU8(JSON.stringify(v));
};
const files = (p: Project): Files => unzipSync(writeBaap(p, { appVersion: 'x' }));
const code = (b: Uint8Array): string | undefined => {
  try {
    readBaap(b);
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
};

const TEXT_A = 'A "Avviamento"\r\n= "Velocità"\r\n// perché è così\r\n';
const TEXT_B = 'L 1\nT MW 0\n';

function withSources(): Project {
  const p = makeProject();
  const d = p.devices[0]!;
  const newId = seq('s');
  d.sources.push(
    createSource('Motori.awl', TEXT_A, newId),
    createSource('Altro.awl', TEXT_B, newId),
  );
  return p;
}

describe('file .baap formato 3: sorgenti esterne', () => {
  it('andata e ritorno con il testo identico (accenti, CRLF, LF) e nell ordine', () => {
    const p = withSources();
    const back = readBaap(writeBaap(p, { appVersion: '0.3.0' }));
    expect(back).toEqual(p);
    expect(back.devices[0]!.sources.map((s) => s.name)).toEqual(['Motori.awl', 'Altro.awl']);
    expect(back.devices[0]!.sources[0]!.text).toBe(TEXT_A);
  });

  it('un file per sorgente in UTF-8 senza BOM, byte per byte; device.json ha id e nome in ordine', () => {
    const p = withSources();
    const d = p.devices[0]!;
    const f = files(p);
    const raw = f[`plc/${d.id}/sources/s1.awl`]!;
    expect(Array.from(raw.slice(0, 3))).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(Array.from(raw)).toEqual(Array.from(strToU8(TEXT_A)));
    expect(json(f, `plc/${d.id}/device.json`).sources).toEqual([
      { id: 's1', name: 'Motori.awl' },
      { id: 's2', name: 'Altro.awl' },
    ]);
  });

  it('un BOM scritto nel testo resta nel testo (non si perde in lettura)', () => {
    const p = makeProject();
    p.devices[0]!.sources.push(createSource('Bom.awl', '﻿A M 0.0\n', seq('b')));
    expect(readBaap(writeBaap(p, { appVersion: 'x' }))).toEqual(p);
  });

  it('le chiavi sconosciute di una voce di sorgente si conservano', () => {
    const p = withSources();
    const d = p.devices[0]!;
    const f = files(p);
    const dev = json(f, `plc/${d.id}/device.json`);
    dev.sources[0].futureKey = 1;
    put(f, `plc/${d.id}/device.json`, dev);
    const back = readBaap(zipSync(f));
    expect(json(files(back), `plc/${d.id}/device.json`).sources[0]).toEqual({
      id: 's1',
      name: 'Motori.awl',
      futureKey: 1,
    });
  });

  it('un file elencato ma mancante è INVALID_SCHEMA', () => {
    const p = withSources();
    const f = files(p);
    delete f[`plc/${p.devices[0]!.id}/sources/s2.awl`];
    expect(code(zipSync(f))).toBe('INVALID_SCHEMA');
  });

  it('un id di sorgente duplicato è INVALID_SCHEMA', () => {
    const p = withSources();
    const d = p.devices[0]!;
    const f = files(p);
    const dev = json(f, `plc/${d.id}/device.json`);
    dev.sources = [dev.sources[0], dev.sources[0]];
    put(f, `plc/${d.id}/device.json`, dev);
    expect(code(zipSync(f))).toBe('INVALID_SCHEMA');
  });

  it('un id di sorgente uguale a quello di un altro oggetto è INVALID_SCHEMA', () => {
    const p = withSources();
    const d = p.devices[0]!;
    const f = files(p);
    const dev = json(f, `plc/${d.id}/device.json`);
    dev.sources[0].id = d.blocks[0]!.id;
    f[`plc/${d.id}/sources/${d.blocks[0]!.id}.awl`] = strToU8('x');
    put(f, `plc/${d.id}/device.json`, dev);
    expect(code(zipSync(f))).toBe('INVALID_SCHEMA');
  });

  it.each(['../x', 'a/b', 'a\\b', 'a:b', 'x..y', '..'])(
    'id non sicuro %s è INVALID_SCHEMA',
    (bad) => {
      const p = withSources();
      const d = p.devices[0]!;
      const f = files(p);
      const dev = json(f, `plc/${d.id}/device.json`);
      dev.sources[0].id = bad;
      put(f, `plc/${d.id}/device.json`, dev);
      f[`plc/${d.id}/sources/${bad}.awl`] = strToU8('x');
      expect(code(zipSync(f))).toBe('INVALID_SCHEMA');
    },
  );

  it('un elenco di sorgenti non valido è INVALID_SCHEMA', () => {
    const p = withSources();
    const d = p.devices[0]!;
    const f = files(p);
    const dev = json(f, `plc/${d.id}/device.json`);
    delete dev.sources;
    put(f, `plc/${d.id}/device.json`, dev);
    expect(code(zipSync(f))).toBe('INVALID_SCHEMA');
  });

  it('formato 4 → NEWER_FORMAT', () => {
    const f = files(makeProject());
    put(f, 'baaportal.json', { format: 'baaportal-project', formatVersion: 4 });
    expect(code(zipSync(f))).toBe('NEWER_FORMAT');
  });
});

describe('migrazione dal formato 2', () => {
  /** Un file come lo scriveva il formato 2: niente `sources`, manifest e progetto a versione 2. */
  function asFormat2(p: Project): Uint8Array {
    const f = files(p);
    put(f, 'baaportal.json', {
      format: 'baaportal-project',
      formatVersion: 2,
      savedWith: 'BaaPortal 0.2.0',
    });
    const proj = json(f, 'project.json');
    proj.formatVersion = 2;
    put(f, 'project.json', proj);
    for (const d of p.devices) {
      const dev = json(f, `plc/${d.id}/device.json`);
      delete dev.sources;
      put(f, `plc/${d.id}/device.json`, dev);
    }
    return zipSync(f);
  }

  it('un file del formato 2 si apre con tutti i dispositivi e i blocchi e sources []', () => {
    const p = makeProject();
    const second = structuredClone(p.devices[0]!);
    // id nuovi per il secondo dispositivo (gli id sono unici solo dentro un dispositivo)
    second.id = 'dev2';
    second.name = 'PLC_2';
    p.devices.push(second);
    const opened = readBaap(asFormat2(p));
    expect(opened.formatVersion).toBe(3);
    expect(opened.devices).toHaveLength(2);
    expect(opened.devices.map((d) => d.blocks.length)).toEqual(
      p.devices.map((d) => d.blocks.length),
    );
    expect(opened.devices.every((d) => d.sources.length === 0)).toBe(true);
    expect(opened).toEqual(p);
  });

  it('salvato di nuovo, il progetto migrato è del formato 3 e si riapre uguale', () => {
    const p = makeProject();
    const opened = readBaap(asFormat2(p));
    addSource(opened.devices[0]!, 'Nuova.awl', 'NOP 0\n');
    expect(readBaap(writeBaap(opened, { appVersion: 'x' }))).toEqual(opened);
  });

  it('un file del formato 2 con una chiave sources estranea la ignora', () => {
    const p = makeProject();
    const f = unzipSync(asFormat2(p));
    const d = p.devices[0]!;
    const dev = json(f, `plc/${d.id}/device.json`);
    dev.sources = [{ id: 'zz', name: 'x.awl' }];
    put(f, `plc/${d.id}/device.json`, dev);
    expect(readBaap(zipSync(f)).devices[0]!.sources).toEqual([]);
  });

  it('formato 0 o non intero è INVALID_SCHEMA', () => {
    for (const v of [0, 1.5, -1]) {
      const f = files(makeProject());
      put(f, 'baaportal.json', { format: 'baaportal-project', formatVersion: v });
      expect(code(zipSync(f))).toBe('INVALID_SCHEMA');
    }
  });
});
