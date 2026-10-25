import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { decodeBackup, encodeBackup, sha256Hex, type BackupManifest } from '../src/backupFile';

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

describe('sha256Hex', () => {
  it('vettori noti', () => {
    expect(sha256Hex(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex(strToU8('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex(strToU8('a'.repeat(1000)))).toBe(
      '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3',
    );
  });
});

describe('backupFile', () => {
  it('encodeBackup/decodeBackup: andata e ritorno identica', () => {
    const r = decodeBackup(encodeBackup(manifest(), files()));
    expect(r.manifest).toEqual(manifest());
    expect(r.files['blocks/OB1.blk']).toEqual(A);
    expect(r.files['blocks/SDB0.blk']).toEqual(B);
  });

  const zipWith = (m: unknown, f: Record<string, Uint8Array> = files()) =>
    zipSync({ 'manifest.json': strToU8(JSON.stringify(m)), ...f });

  it('formato sbagliato → errore', () => {
    expect(() => decodeBackup(strToU8('non zip'))).toThrow(/zip/);
    expect(() => decodeBackup(zipWith({ ...manifest(), format: 'altro' }))).toThrow(/formato/);
    expect(() => decodeBackup(zipWith({ ...manifest(), version: 2 }))).toThrow(/versione/);
    expect(() => decodeBackup(zipSync({ 'x.txt': A }))).toThrow(/manifest/);
  });

  it('file mancante → errore', () => {
    expect(() => decodeBackup(zipWith(manifest(), { 'blocks/OB1.blk': A }))).toThrow(/mancante/);
  });

  it('sha256 diverso → errore', () => {
    const bad = { ...files(), 'blocks/OB1.blk': new Uint8Array([9, 9, 9, 9]) };
    expect(() => decodeBackup(zipWith(manifest(), bad))).toThrow(/diverso/);
  });

  it('percorso con .. o assoluto → errore', () => {
    for (const file of ['../OB1.blk', '/etc/passwd', 'blocks/../../x', 'C:/x', 'a\\b']) {
      const m = manifest();
      m.blocks[0]!.file = file;
      expect(() => decodeBackup(zipWith(m))).toThrow(/percorso/);
    }
    expect(() => encodeBackup(manifest(), { '../x': A })).toThrow(/percorso/);
  });
});
