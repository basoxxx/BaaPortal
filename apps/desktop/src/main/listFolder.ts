import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

/** Al massimo tanti file: una cartella con migliaia di file non è un'esportazione di STEP 7. */
export const MAX_FOLDER_FILES = 500;

/**
 * I file di `dir` (solo il primo livello, niente collegamenti né sottocartelle) con una delle estensioni
 * date (senza punto, minuscole), in ordine di nome e al massimo `MAX_FOLDER_FILES`.
 */
export async function listFolderFiles(
  dir: string,
  extensions: readonly string[],
): Promise<string[]> {
  const wanted = new Set(extensions.map((e) => e.toLowerCase()));
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && wanted.has(extname(e.name).slice(1).toLowerCase()))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_FOLDER_FILES)
    .map((name) => join(dir, name));
}
