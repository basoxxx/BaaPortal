import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listFolderFiles } from '../src/main/listFolder';

let dir = '';
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('listFolderFiles', () => {
  it('elenca i file con le estensioni date, in ordine, senza sottocartelle', async () => {
    dir = await mkdtemp(join(tmpdir(), 'baa-list-'));
    await writeFile(join(dir, 'b.AWL'), '');
    await writeFile(join(dir, 'a.scl'), '');
    await writeFile(join(dir, 'nota.txt'), '');
    await mkdir(join(dir, 'sub.awl'));
    expect(await listFolderFiles(dir, ['awl', 'scl'])).toEqual([
      join(dir, 'a.scl'),
      join(dir, 'b.AWL'),
    ]);
  });
});
