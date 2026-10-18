import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

let counter = 0;

export async function writeFileAtomic(path: string, data: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${counter++}`;
  try {
    const fh = await open(tmp, 'w');
    try {
      await fh.writeFile(data);
      await fh.sync(); // i dati devono essere su disco prima che il rename li renda il file definitivo
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}
