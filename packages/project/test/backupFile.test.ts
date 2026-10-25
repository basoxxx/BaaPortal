import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import {
  BACKUP_MAX_BYTES,
  decodeBackup,
  encodeBackup,
  type BackupManifest,
} from '../src/backupFile';

const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const decode = (b: Uint8Array) => decodeBackup(b, sha256Hex);
const A = new Uint8Array([1, 2, 3, 4]);
const B = new Uint8Array(300).map((_, i) => i % 251);

function manifest(): BackupManifest {
  return {
    format: 'baaportal-backup',
    version: 1,
    createdAt: '2026-10-25T10:00:00.000Z',
    app: '0.10.0',
    cpu: { orderNumber: '6ES7 315-2EH14-0AB0', host: '127.0.0.1', port: 102, rack: 0, slot: 2 },
    mode: 'RUN',
    blocks: [
      { type: 'OB', number: 1, file: 'blocks/OB1.blk', length: A.length, sha256: sha256Hex(A) },
      { type: 'SDB', number: 0, file: 'blocks/SDB0.blk', length: B.length, sha256: sha256Hex(B) },
    ],
    failed: [{ type: 'DB', number: 5, error: 'protetto' }],
  };
}
const files = () => ({ 'blocks/OB1.blk': A, 'blocks/SDB0.blk': B });

describe('backupFile', () => {
  it('encodeBackup/decodeBackup: andata e ritorno identica', () => {
    const r = decode(encodeBackup(manifest(), files()));
    expect(r.manifest).toEqual(manifest());
    expect(r.files['blocks/OB1.blk']).toEqual(A);
    expect(r.files['blocks/SDB0.blk']).toEqual(B);
  });

  const zipWith = (m: unknown, f: Record<string, Uint8Array> = files()) =>
    zipSync({ 'manifest.json': strToU8(JSON.stringify(m)), ...f });

  it('formato sbagliato → errore', () => {
    expect(() => decode(strToU8('non zip'))).toThrow(/zip/);
    expect(() => decode(zipWith({ ...manifest(), format: 'altro' }))).toThrow(/formato/);
    expect(() => decode(zipWith({ ...manifest(), version: 2 }))).toThrow(/versione/);
    expect(() => decode(zipSync({ 'x.txt': A }))).toThrow(/manifest/);
  });

  it('file mancante → errore', () => {
    expect(() => decode(zipWith(manifest(), { 'blocks/OB1.blk': A }))).toThrow(/mancante/);
  });

  it('sha256 diverso → errore', () => {
    const bad = { ...files(), 'blocks/OB1.blk': new Uint8Array([9, 9, 9, 9]) };
    expect(() => decode(zipWith(manifest(), bad))).toThrow(/diverso/);
  });

  it('percorso con .. o assoluto → errore', () => {
    for (const file of ['../OB1.blk', '/etc/passwd', 'blocks/../../x', 'C:/x', 'a\\b']) {
      const m = manifest();
      m.blocks[0]!.file = file;
      expect(() => decode(zipWith(m))).toThrow(/percorso/);
    }
    expect(() => encodeBackup(manifest(), { '../x': A })).toThrow();
  });

  it('numero, lunghezza, nome del file, duplicati, errori di failed', () => {
    const bad = (mut: (m: BackupManifest) => void) => {
      const m = manifest();
      mut(m);
      return () => decode(zipWith(m));
    };
    expect(bad((m) => (m.blocks[0]!.file = 'blocks/DB9.blk'))).toThrow(/coerente/);
    expect(bad((m) => (m.blocks[0]!.number = -1))).toThrow();
    expect(bad((m) => (m.blocks[0]!.number = 1.5))).toThrow();
    expect(bad((m) => (m.blocks[0]!.length = 1.5))).toThrow();
    expect(bad((m) => m.blocks.push({ ...m.blocks[0]! }))).toThrow(/duplicat/);
    expect(bad((m) => ((m.failed[0] as { error: unknown }).error = 5))).toThrow(/rifiutato/);
  });

  it('encodeBackup controlla che i file corrispondano al manifest', () => {
    expect(() => encodeBackup(manifest(), { 'blocks/OB1.blk': A })).toThrow(/corrispondono/);
    expect(() => encodeBackup(manifest(), { ...files(), 'blocks/DB1.blk': A })).toThrow(
      /corrispondono/,
    );
  });

  it('bomba zip: voce troppo grande dichiarata → errore', () => {
    const big = new Uint8Array(BACKUP_MAX_BYTES + 1);
    const bomb = zipSync({
      'manifest.json': strToU8(JSON.stringify(manifest())),
      'blocks/OB1.blk': big,
    });
    expect(() => decode(bomb)).toThrow(/troppo grande/);
  });

  /** Falsifica la dimensione dichiarata di ogni voce (locale e centrale), lasciando i dati. */
  function lie(zip: Uint8Array, size: number): Uint8Array {
    const out = zip.slice();
    const dv = new DataView(out.buffer);
    for (let i = 0; i + 30 < out.length; i++) {
      if (dv.getUint32(i, true) === 0x04034b50) dv.setUint32(i + 22, size, true);
      if (dv.getUint32(i, true) === 0x02014b50) dv.setUint32(i + 24, size, true);
    }
    return out;
  }

  it('voce con originalSize 10 che si gonfia a 2 MB → «contenuto troppo grande»', () => {
    const zip = zipSync(
      {
        'manifest.json': strToU8(JSON.stringify(manifest())),
        'blocks/OB1.blk': new Uint8Array(2 * 1024 * 1024),
        'blocks/SDB0.blk': B,
      },
      { level: 9 },
    );
    expect(() => decode(lie(zip, 10))).toThrow(/troppo grande/);
  });

  it('manifest dichiarato di 100 byte che diventa 100 KB → errore', () => {
    const m = { ...manifest(), app: 'x'.repeat(100 * 1024) };
    const zip = zipSync(
      { 'manifest.json': strToU8(JSON.stringify(m)), 'blocks/OB1.blk': A, 'blocks/SDB0.blk': B },
      { level: 9 },
    );
    expect(() => decode(lie(zip, 100))).toThrow(/troppo grande/);
  });

  it('blocco più lungo della length del manifest → errore', () => {
    const zip = zipSync({
      'manifest.json': strToU8(JSON.stringify(manifest())),
      'blocks/OB1.blk': new Uint8Array(A.length + 1),
      'blocks/SDB0.blk': B,
    });
    expect(() => decode(zip)).toThrow(/troppo grande/);
  });

  it('length del manifest oltre 1 MB → errore', () => {
    const m = manifest();
    m.blocks[0]!.length = 2 * 1024 * 1024;
    const zip = zipSync({
      'manifest.json': strToU8(JSON.stringify(m)),
      'blocks/OB1.blk': A,
      'blocks/SDB0.blk': B,
    });
    expect(() => decode(zip)).toThrow(/troppo grande/);
  });
});
