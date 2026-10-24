import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  BaapzFormatError,
  createProject,
  readBaap,
  readBaapz,
  writeBaap,
  writeBaapz,
} from '../src';

const project = createProject(
  { name: 'Linea 3', author: 'Mario', comment: '' },
  new Date('2026-01-01T00:00:00Z'),
);
const opts = { appVersion: '1.2.3', projectFileName: 'Linea 3.baap' };

function codeOf(fn: () => unknown): { code: string; detail?: string } {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BaapzFormatError);
    const err = e as BaapzFormatError;
    return { code: err.code, detail: err.detail };
  }
  throw new Error('non ha lanciato');
}
const manifest = (over: object) =>
  strToU8(
    JSON.stringify({
      formatVersion: 1,
      appVersion: '1',
      createdAt: '2026-01-01T00:00:00.000Z',
      projectFileName: 'a.baap',
      ...over,
    }),
  );

describe('baapz', () => {
  it('writeBaapz → readBaapz: manifesto e progetto identico a readBaap(writeBaap(p))', () => {
    const now = new Date('2026-02-03T04:05:06Z');
    const out = readBaapz(writeBaapz(project, { ...opts, now }));
    expect(out.manifest).toEqual({
      formatVersion: 1,
      appVersion: '1.2.3',
      createdAt: now.toISOString(),
      projectFileName: 'Linea 3.baap',
    });
    expect(readBaap(out.baap)).toEqual(readBaap(writeBaap(project, { appVersion: '1.2.3' })));
  });

  it('formatVersion 2 → VERSIONE_FUTURA', () => {
    const z = zipSync({ 'manifest.json': manifest({ formatVersion: 2 }) });
    expect(codeOf(() => readBaapz(z)).code).toBe('VERSIONE_FUTURA');
  });

  it('zip senza manifest.json → MANIFESTO_MANCANTE', () => {
    const z = zipSync({ 'a.baap': strToU8('x') });
    expect(codeOf(() => readBaapz(z)).code).toBe('MANIFESTO_MANCANTE');
  });

  it('baap interno rotto → PROGETTO_ILLEGGIBILE con detail = codice originale', () => {
    const z = zipSync({ 'manifest.json': manifest({}), 'a.baap': strToU8('non zip') });
    expect(codeOf(() => readBaapz(z))).toEqual({
      code: 'PROGETTO_ILLEGGIBILE',
      detail: 'NOT_ZIP',
    });
  });

  it('byte non zip → NON_ZIP; troppo grande → NON_ZIP', () => {
    expect(codeOf(() => readBaapz(strToU8('abc'))).code).toBe('NON_ZIP');
    expect(codeOf(() => readBaapz(new Uint8Array(200 * 1024 * 1024 + 1)))).toEqual({
      code: 'NON_ZIP',
      detail: 'troppo grande',
    });
  });

  it.each(['../x.baap', 'a/b.baap', 'a\\b.baap', 'C:x.baap', '..', '.', 'x.txt'])(
    'nome progetto non valido %s → PROGETTO_MANCANTE (nome non valido)',
    (name) => {
      const z = zipSync({
        'manifest.json': manifest({ projectFileName: name }),
        [name]: writeBaap(project, { appVersion: '1' }),
      });
      expect(codeOf(() => readBaapz(z))).toEqual({
        code: 'PROGETTO_MANCANTE',
        detail: 'nome non valido',
      });
    },
  );

  it('file del progetto assente → PROGETTO_MANCANTE', () => {
    const z = zipSync({ 'manifest.json': manifest({}) });
    expect(codeOf(() => readBaapz(z)).code).toBe('PROGETTO_MANCANTE');
  });
});
