import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, launchApp, test, removeDir } from './helpers';

/** Copia ricorsiva: fs.cpSync di Node 22 su Windows storpia i percorsi di destinazione non ASCII. */
function copyDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) copyDir(join(from, e.name), join(to, e.name));
    else copyFileSync(join(from, e.name), join(to, e.name));
  }
}

// Su Windows l'installazione per utente finisce sotto il nome dell'utente (spazi, accenti, apostrofi):
// la pagina caricata da quella cartella deve essere riconosciuta come l'app e poter usare i canali IPC.
const folders: [string, string[]][] = [
  ['semplice', ['BaaPortal']],
  ['con spazi, accenti e apostrofo', ["Niccolò D'Amico", 'BaaPortal']],
  ['con i simboli { } ^ [ ]', ['Programmi {ditta}^[1]', 'BaaPortal']],
];

for (const [label, parts] of folders) {
  test(`l'app funziona installata in una cartella ${label}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'baa-install-'));
    try {
      const appDir = join(root, ...parts);
      copyDir('out', join(appDir, 'out'));
      writeFileSync(
        join(appDir, 'package.json'),
        JSON.stringify({ name: 'baaportal', version: '0.1.0', type: 'module' }),
      );
      const { app, page } = await launchApp({ cwd: appDir });
      expect(fileURLToPath(page.url())).toContain(join(...parts, 'out', 'renderer', 'index.html'));

      expect(await page.evaluate(() => window.baa.fileExists('nessun-file-qui.baap'))).toBe(false);
      expect(await page.evaluate(() => window.baa.recentList())).toEqual([]);
      await expect(page.getByTestId('portal-start')).toBeVisible();
      await app.close();
    } finally {
      removeDir(root);
    }
  });
}
