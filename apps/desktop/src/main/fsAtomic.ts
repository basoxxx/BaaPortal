import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

let counter = 0;

export async function writeFileAtomic(path: string, data: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${counter++}`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}
