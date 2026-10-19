import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deleteRecovery,
  listRecovery,
  readRecovery,
  RECOVERY_KEY,
  writeRecovery,
} from '../src/main/recoveryStore';

const info = { originalPath: '/p/a.baap', projectName: 'Pressa', savedAt: '2026-10-18T10:00:00Z' };
const data = new Uint8Array([1, 2, 3]);
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'baa-rec-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('recoveryStore', () => {
  it('scrive, elenca, legge ed elimina', async () => {
    const rec = join(dir, 'recovery'); // la cartella viene creata alla prima scrittura
    expect(await listRecovery(rec)).toEqual([]);
    await writeRecovery(rec, 'k1', data, info);
    expect(await listRecovery(rec)).toEqual([{ key: 'k1', info }]);
    expect(Array.from(await readRecovery(rec, 'k1'))).toEqual([1, 2, 3]);
    await deleteRecovery(rec, 'k1');
    expect(await listRecovery(rec)).toEqual([]);
    expect(existsSync(join(rec, 'k1.baap'))).toBe(false);
    await expect(deleteRecovery(rec, 'k1')).resolves.toBeUndefined();
  });

  it('sovrascrive una voce esistente', async () => {
    await writeRecovery(dir, 'k1', data, info);
    await writeRecovery(dir, 'k1', new Uint8Array([9]), { ...info, projectName: 'Nuovo' });
    expect(Array.from(await readRecovery(dir, 'k1'))).toEqual([9]);
    expect((await listRecovery(dir))[0]?.info.projectName).toBe('Nuovo');
  });

  it.each(['../x', 'a/b', 'A', '', 'a'.repeat(65), 'a.b', 'a\\b'])(
    'chiave non valida %j rifiutata',
    async (key) => {
      expect(RECOVERY_KEY.test(key)).toBe(false);
      for (const op of [
        () => writeRecovery(dir, key, data, info),
        () => readRecovery(dir, key),
        () => deleteRecovery(dir, key),
      ]) {
        await expect(op()).rejects.toMatchObject({ code: 'INVALID_KEY' });
      }
    },
  );

  it('un .json rotto, senza .baap o con campi sbagliati non compare', async () => {
    await writeRecovery(dir, 'ok', data, info);
    writeFileSync(join(dir, 'rotto.baap'), data);
    writeFileSync(join(dir, 'rotto.json'), '{non json');
    writeFileSync(join(dir, 'solojson.json'), JSON.stringify(info));
    writeFileSync(join(dir, 'solobaap.baap'), data);
    writeFileSync(join(dir, 'campi.baap'), data);
    writeFileSync(join(dir, 'campi.json'), JSON.stringify({ originalPath: 1 }));
    writeFileSync(join(dir, 'Maiusc.baap'), data);
    writeFileSync(join(dir, 'Maiusc.json'), JSON.stringify(info));
    expect((await listRecovery(dir)).map((e) => e.key)).toEqual(['ok']);
  });

  it('leggere una chiave inesistente rifiuta con ENOENT', async () => {
    await expect(readRecovery(dir, 'nessuna')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
