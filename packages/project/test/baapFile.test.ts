import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { createCodeBlock, createProject, readBaap, writeBaap } from '../src/index';
import { makeDevice, seq } from './fixtures';

const now = new Date('2026-10-18T10:00:00.000Z');

function manifest(v: number): Uint8Array {
  return strToU8(
    JSON.stringify({ format: 'baaportal-project', formatVersion: v, savedWith: 'BaaPortal 0.1.0' }),
  );
}

function truncatedValidBaap(): Uint8Array {
  const bytes = writeBaap(createProject({ name: 'X', author: '', comment: '' }, now), {
    appVersion: '0.1.0',
  });
  return bytes.slice(0, Math.floor(bytes.length * 0.6));
}

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe('file .baap', () => {
  it('andata e ritorno conserva tutto, anche caratteri non ASCII e a capo', () => {
    const p = createProject(
      { name: 'Pressa àèìòù 日本', author: 'Zoë', comment: 'riga1\nriga2' },
      now,
    );
    expect(readBaap(writeBaap(p, { appVersion: '0.1.0' }))).toEqual(p);
  });

  it('andata e ritorno conserva il segmento KOP (lad) di un blocco', () => {
    const p = createProject({ name: 'K', author: '', comment: '' }, now);
    const dev = makeDevice(seq('k'));
    const b = createCodeBlock({
      kind: 'FC',
      number: 9,
      name: 'Ko',
      language: 'KOP',
      newId: seq('b'),
    });
    b.networks[0]!.lad = {
      root: {
        id: 'r',
        series: [{ id: 'c1', k: 'contact', neg: true, op: 'I 0.0' }],
        outs: [{ id: 'o1', k: 'coil', op: 'Q 4.0' }],
      },
    };
    dev.blocks.push(b);
    p.devices.push(dev);
    const back = readBaap(writeBaap(p, { appVersion: '0.1.0' }));
    expect(back).toEqual(p);
    const kb = back.devices[0]!.blocks.find((x) => x.id === b.id);
    expect(kb && kb.kind !== 'DB' && kb.kind !== 'IDB' && kb.networks[0]!.lad).toEqual(
      b.networks[0]!.lad,
    );
  });

  it('lo zip contiene manifest e progetto leggibili', () => {
    const files = unzipSync(
      writeBaap(createProject({ name: 'X', author: '', comment: '' }, now), {
        appVersion: '0.1.0',
      }),
    );
    expect(Object.keys(files).sort()).toEqual(['baaportal.json', 'project.json']);
    expect(JSON.parse(strFromU8(files['project.json']!)).formatVersion).toBe(4);
    expect(JSON.parse(strFromU8(files['baaportal.json']!))).toEqual({
      format: 'baaportal-project',
      formatVersion: 4,
      savedWith: 'BaaPortal 0.1.0',
    });
  });

  it.each([
    ['NOT_ZIP', strToU8('ciao')],
    ['NOT_ZIP', new Uint8Array(0)],
    ['MISSING_MANIFEST', zipSync({ 'project.json': strToU8('{}') })],
    ['INVALID_JSON', zipSync({ 'baaportal.json': strToU8('{'), 'project.json': strToU8('{}') })],
    [
      'INVALID_SCHEMA',
      zipSync({
        'baaportal.json': manifest(1),
        'project.json': strToU8('{"formatVersion":1,"meta":{}}'),
      }),
    ],
    [
      'INVALID_SCHEMA',
      zipSync({
        'baaportal.json': manifest(1),
        'project.json': strToU8(
          JSON.stringify({
            formatVersion: 1,
            meta: {
              name: 'X',
              author: '',
              comment: '',
              createdAt: 'ieri',
              modifiedAt: now.toISOString(),
            },
          }),
        ),
      }),
    ],
    [
      'INVALID_SCHEMA',
      zipSync({
        'baaportal.json': manifest(1),
        'project.json': strToU8(
          JSON.stringify({
            formatVersion: 1,
            meta: {
              name: 'X',
              author: '',
              comment: '',
              createdAt: now.toISOString(),
              modifiedAt: '',
            },
          }),
        ),
      }),
    ],
    ['NEWER_FORMAT', zipSync({ 'baaportal.json': manifest(5), 'project.json': strToU8('{}') })],
    ['NOT_ZIP', truncatedValidBaap()],
    // formato 2: schema del progetto non valido
    [
      'INVALID_SCHEMA',
      zipSync({ 'baaportal.json': manifest(2), 'project.json': strToU8('{"formatVersion":2}') }),
    ],
  ])('readBaap rifiuta con %s', (code, bytes) => {
    expect(catchError(() => readBaap(bytes))).toMatchObject({ name: 'BaapFormatError', code });
  });

  it('un file del formato 1 si apre come formato 4 senza dispositivi', () => {
    const meta = {
      name: 'Vecchio',
      author: 'A',
      comment: '',
      createdAt: now.toISOString(),
      modifiedAt: now.toISOString(),
    };
    const v1 = zipSync({
      'baaportal.json': manifest(1),
      'project.json': strToU8(JSON.stringify({ formatVersion: 1, meta })),
    });
    expect(readBaap(v1)).toEqual({ formatVersion: 4, meta, devices: [] });
  });
});
