import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '../src/main/fsAtomic';

const bytes = (s: string) => new TextEncoder().encode(s);
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'baa-fs-'));
});
afterEach(() => {
  chmodSync(dir, 0o755);
  rmSync(dir, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
  it('scrive e sostituisce un file esistente', async () => {
    const p = join(dir, 'a.baap');
    await writeFileAtomic(p, bytes('uno'));
    await writeFileAtomic(p, bytes('due'));
    expect(readFileSync(p, 'utf8')).toBe('due');
    expect(readdirSync(dir)).toEqual(['a.baap']);
  });
  it('crea le cartelle mancanti', async () => {
    const p = join(dir, 'a', 'b', 'c.baap');
    await writeFileAtomic(p, bytes('x'));
    expect(readFileSync(p, 'utf8')).toBe('x');
  });
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'se la scrittura fallisce, il file originale resta intatto e non resta il .tmp',
    async () => {
      const p = join(dir, 'a.baap');
      writeFileSync(p, 'uno');
      chmodSync(dir, 0o555);
      await expect(writeFileAtomic(p, bytes('due'))).rejects.toHaveProperty('code');
      chmodSync(dir, 0o755);
      expect(readFileSync(p, 'utf8')).toBe('uno');
      expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
    },
  );
});
