import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { readBaap, writeBaap, type Project } from '../src/index';
import { makeProject } from './fixtures';

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type Any = any;
type Files = Record<string, Uint8Array>;
const json = (f: Files, path: string): Any => JSON.parse(strFromU8(f[path]!));
const put = (f: Files, path: string, v: unknown) => {
  f[path] = strToU8(JSON.stringify(v));
};
const bytes = (f: Files) => zipSync(f);
const baseFiles = (p: Project): Files => unzipSync(writeBaap(p, { appVersion: 'x' }));
const code = (b: Uint8Array) => (catchError(() => readBaap(b)) as { code?: string }).code;

describe('file .baap formato 2', () => {
  it('andata e ritorno di un progetto completo', () => {
    const p = makeProject();
    expect(readBaap(writeBaap(p, { appVersion: '0.2.0' }))).toEqual(p);
  });

  it('un JSON per oggetto con percorsi basati sugli id', () => {
    const p = makeProject();
    const d = p.devices[0]!;
    const expected = [
      'baaportal.json',
      'project.json',
      `plc/${d.id}/device.json`,
      ...d.tagTables.map((t) => `plc/${d.id}/tags/${t.id}.json`),
      ...d.udts.map((u) => `plc/${d.id}/types/${u.id}.json`),
      ...d.blocks.map((b) => `plc/${d.id}/blocks/${b.id}.json`),
    ];
    expect(Object.keys(baseFiles(p)).sort()).toEqual(expected.sort());
    const f = baseFiles(p);
    expect(json(f, 'project.json').devices).toEqual([{ id: d.id, name: 'PLC_1' }]);
    expect(strFromU8(f['project.json']!)).toContain('\n  "formatVersion"');
  });

  it("l'ordine degli oggetti si conserva anche se lo zip è riordinato", () => {
    const p = makeProject();
    const f = baseFiles(p);
    const reversed: Files = {};
    for (const k of Object.keys(f).reverse()) reversed[k] = f[k]!;
    expect(readBaap(bytes(reversed))).toEqual(p);
  });

  it('le chiavi sconosciute si conservano', () => {
    const p = makeProject();
    const d = p.devices[0]!;
    const f = baseFiles(p);
    const proj = json(f, 'project.json');
    proj.meta.extra = 1;
    proj.topExtra = 'x';
    put(f, 'project.json', proj);
    const tablePath = `plc/${d.id}/tags/${d.tagTables[0]!.id}.json`;
    const table = json(f, tablePath);
    table.tags[0].extra = { a: 1 };
    put(f, tablePath, table);
    const devPath = `plc/${d.id}/device.json`;
    const dev = json(f, devPath);
    dev.cpu.extra = true;
    dev.devExtra = 5;
    put(f, devPath, dev);
    const blockPath = `plc/${d.id}/blocks/${d.blocks[3]!.id}.json`;
    const blk = json(f, blockPath);
    blk.members[0].extra = 'm';
    put(f, blockPath, blk);

    const once = readBaap(bytes(f));
    const twice = readBaap(writeBaap(once, { appVersion: 'x' }));
    for (const r of [once, twice] as Any[]) {
      expect(r.meta.extra).toBe(1);
      expect(r.topExtra).toBe('x');
      expect(r.devices[0].cpu.extra).toBe(true);
      expect(r.devices[0].devExtra).toBe(5);
      expect(r.devices[0].tagTables[0].tags[0].extra).toEqual({ a: 1 });
      expect(r.devices[0].blocks[3].members[0].extra).toBe('m');
    }
  });

  it('id doppi nello stesso dispositivo → INVALID_SCHEMA', () => {
    const p = makeProject();
    const d = p.devices[0]!;
    d.tagTables[0]!.tags[1]!.id = d.tagTables[0]!.tags[0]!.id;
    expect(code(writeBaap(p, { appVersion: 'x' }))).toBe('INVALID_SCHEMA');

    const q = makeProject();
    const dq = q.devices[0]!;
    // un id di membro annidato uguale a quello di un blocco
    dq.udts[0]!.members[0]!.members![0]!.id = dq.blocks[0]!.id;
    expect(code(writeBaap(q, { appVersion: 'x' }))).toBe('INVALID_SCHEMA');
  });

  it('dispositivi con lo stesso id → INVALID_SCHEMA', () => {
    const p = makeProject();
    p.devices.push(structuredClone(p.devices[0]!));
    expect(code(writeBaap(p, { appVersion: 'x' }))).toBe('INVALID_SCHEMA');
  });

  it('file mancante → INVALID_SCHEMA', () => {
    const p = makeProject();
    const d = p.devices[0]!;
    for (const path of [
      `plc/${d.id}/device.json`,
      `plc/${d.id}/tags/${d.tagTables[0]!.id}.json`,
      `plc/${d.id}/types/${d.udts[0]!.id}.json`,
      `plc/${d.id}/blocks/${d.blocks[1]!.id}.json`,
    ]) {
      const f = baseFiles(p);
      delete f[path];
      expect(code(bytes(f)), path).toBe('INVALID_SCHEMA');
    }
  });

  it('i file non elencati sono ignorati', () => {
    const p = makeProject();
    const d = p.devices[0]!;
    const f = baseFiles(p);
    put(f, `plc/${d.id}/blocks/orfano.json`, { id: 'orfano', kind: 'zzz' });
    expect(readBaap(bytes(f))).toEqual(p);
  });

  it('id interno diverso dall’id elencato → INVALID_SCHEMA', () => {
    const p = makeProject();
    const d = p.devices[0]!;
    const f = baseFiles(p);
    const path = `plc/${d.id}/blocks/${d.blocks[0]!.id}.json`;
    put(f, path, { ...json(f, path), id: 'altro' });
    expect(code(bytes(f))).toBe('INVALID_SCHEMA');
  });

  it('le chiavi sconosciute delle voci devices[] di project.json si conservano', () => {
    const p = makeProject();
    const d = p.devices[0]!;
    const f = baseFiles(p);
    const proj = json(f, 'project.json');
    proj.devices[0].kind = 'plc';
    proj.devices[0].extra = { a: 1 };
    put(f, 'project.json', proj);
    const once = readBaap(bytes(f));
    const out = unzipSync(writeBaap(once, { appVersion: 'x' }));
    expect(json(out, 'project.json').devices).toEqual([
      { kind: 'plc', extra: { a: 1 }, id: d.id, name: 'PLC_1' },
    ]);
    // Restano nella voce dell'elenco, non nel file del dispositivo.
    const devJson = json(out, `plc/${d.id}/device.json`);
    expect(devJson).not.toHaveProperty('kind');
    expect(devJson).not.toHaveProperty('extra');
    const twice = readBaap(zipSync(out));
    expect(twice).toEqual(once);
  });

  it('kind sconosciuto → INVALID_SCHEMA', () => {
    const p = makeProject();
    const d = p.devices[0]!;
    const f = baseFiles(p);
    const path = `plc/${d.id}/blocks/${d.blocks[0]!.id}.json`;
    put(f, path, { ...json(f, path), kind: 'XX' });
    expect(code(bytes(f))).toBe('INVALID_SCHEMA');
  });

  it('JSON non valido in un file di dispositivo → INVALID_JSON', () => {
    const p = makeProject();
    const d = p.devices[0]!;
    const f = baseFiles(p);
    f[`plc/${d.id}/device.json`] = strToU8('{');
    expect(code(bytes(f))).toBe('INVALID_JSON');
  });

  it('riferimenti rotti non impediscono l’apertura', () => {
    const p = makeProject();
    const d = p.devices[0]!;
    (d.blocks[4] as { instanceOf: string }).instanceOf = 'Inesistente';
    d.udts[1]!.members[0]!.type = '"Mancante"';
    expect(readBaap(writeBaap(p, { appVersion: 'x' }))).toEqual(p);
  });

  it('formato 4 → NEWER_FORMAT', () => {
    const f = baseFiles(makeProject());
    put(f, 'baaportal.json', { format: 'baaportal-project', formatVersion: 4 });
    expect(code(bytes(f))).toBe('NEWER_FORMAT');
  });
});
