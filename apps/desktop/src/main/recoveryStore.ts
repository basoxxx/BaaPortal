import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { RecoveryEntry, RecoveryInfo } from '@baaportal/ui';
import { writeFileAtomic } from './fsAtomic';

// La chiave diventa parte del nome file: questo limite impedisce di uscire dalla cartella.
export const RECOVERY_KEY = /^[a-z0-9-]{1,64}$/;

function checkKey(key: string): void {
  if (!RECOVERY_KEY.test(key)) {
    throw Object.assign(new Error('Chiave di recupero non valida'), { code: 'INVALID_KEY' });
  }
}

const isInfo = (v: unknown): v is RecoveryInfo => {
  const o = v as Record<string, unknown> | null;
  return (
    typeof o === 'object' &&
    o !== null &&
    typeof o['originalPath'] === 'string' &&
    typeof o['projectName'] === 'string' &&
    typeof o['savedAt'] === 'string'
  );
};

export async function writeRecovery(
  dir: string,
  key: string,
  data: Uint8Array,
  info: RecoveryInfo,
): Promise<void> {
  checkKey(key);
  // Prima i dati, poi le informazioni: la voce compare in elenco solo quando è completa.
  await writeFileAtomic(join(dir, `${key}.baap`), data);
  const { originalPath, projectName, savedAt } = info;
  await writeFileAtomic(
    join(dir, `${key}.json`),
    new TextEncoder().encode(JSON.stringify({ originalPath, projectName, savedAt })),
  );
}

export async function listRecovery(dir: string): Promise<RecoveryEntry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const set = new Set(names);
  const out: RecoveryEntry[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const key = name.slice(0, -'.json'.length);
    if (!RECOVERY_KEY.test(key) || !set.has(`${key}.baap`)) continue;
    try {
      const info: unknown = JSON.parse(await readFile(join(dir, name), 'utf8'));
      if (isInfo(info)) out.push({ key, info });
    } catch {
      // json rotto o scomparso: la voce viene ignorata
    }
  }
  return out;
}

export async function readRecovery(dir: string, key: string): Promise<Uint8Array> {
  checkKey(key);
  return new Uint8Array(await readFile(join(dir, `${key}.baap`)));
}

export async function deleteRecovery(dir: string, key: string): Promise<void> {
  checkKey(key);
  // Prima il json: una voce a metà non compare più in elenco.
  await rm(join(dir, `${key}.json`), { force: true });
  await rm(join(dir, `${key}.baap`), { force: true });
}
