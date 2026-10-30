import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, launchApp, removeDir, test } from './helpers';

// Il percorso del PDF lo decide BAAPORTAL_E2E_SAVE_PATH (solo app non impacchettata): niente finestra di salvataggio.
test('printDocument produce un PDF vero da un HTML con un <script> che non deve eseguirsi', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'baa-stampa-'));
  const pdf = join(dir, 'doc.pdf');
  const { app, page } = await launchApp({ env: { BAAPORTAL_E2E_SAVE_PATH: pdf } });
  try {
    const html =
      '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'">' +
      '<h1>Prova</h1><p>&lt;script&gt;</p><script>document.body.innerHTML="HACK"</script>';
    const r = await page.evaluate(
      (h) =>
        window.baa.printDocument({
          html: h,
          mode: 'pdf',
          paper: 'A4',
          landscape: false,
          title: 'Prova',
          defaultName: 'prova.pdf',
        }),
      html,
    );
    expect(r).toEqual({ status: 'saved', path: pdf });
    expect(statSync(pdf).size).toBeGreaterThan(0);
    expect(readFileSync(pdf).subarray(0, 4).toString('latin1')).toBe('%PDF');
  } finally {
    await app.close();
    removeDir(dir);
  }
});
