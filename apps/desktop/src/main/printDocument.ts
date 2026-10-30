// Stampa e PDF del programma: l'HTML arriva dal renderer (testo non fidato, vedi buildPrintDocument)
// e si carica in una finestra nascosta senza JavaScript, in sandbox, senza accesso a Node né alla rete.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrintRequest, PrintResult } from '@baaportal/ui';

const MAX_HTML = 64 * 1024 * 1024;

export function parsePrintRequest(raw: unknown): PrintRequest {
  const r = raw as Partial<PrintRequest> | null;
  if (
    !r ||
    typeof r.html !== 'string' ||
    r.html.length > MAX_HTML ||
    (r.mode !== 'pdf' && r.mode !== 'print') ||
    (r.paper !== 'A4' && r.paper !== 'Letter') ||
    typeof r.landscape !== 'boolean' ||
    typeof r.title !== 'string' ||
    typeof r.defaultName !== 'string'
  )
    throw new Error('Richiesta di stampa non valida');
  return r as PrintRequest;
}

/** Opzioni della finestra di stampa: nessun Node, sandbox, nessuno script, partizione in memoria. */
export const PRINT_WINDOW_OPTIONS = {
  show: false,
  webPreferences: {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    javascript: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    partition: 'baa-print',
  },
} as const;

export interface PrintWindow {
  loadFile(path: string): Promise<void>;
  destroy(): void;
  webContents: {
    printToPDF(o: Record<string, unknown>): Promise<Uint8Array>;
    print(o: Record<string, unknown>, cb: (ok: boolean, reason: string) => void): void;
    on(event: 'will-navigate', cb: (e: { preventDefault(): void }) => void): void;
    setWindowOpenHandler(h: () => { action: 'deny' }): void;
  };
}

export interface PrintDeps {
  createWindow(): PrintWindow;
  pickSavePath(defaultName: string): Promise<string | null>;
  write(path: string, data: Uint8Array): Promise<void>;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function printDocument(raw: unknown, deps: PrintDeps): Promise<PrintResult> {
  const req = parsePrintRequest(raw);
  let savePath: string | null = null;
  if (req.mode === 'pdf') {
    savePath = await deps.pickSavePath(req.defaultName);
    if (!savePath) return { status: 'cancelled' };
  }
  const dir = await mkdtemp(join(tmpdir(), 'baa-print-'));
  const win = deps.createWindow();
  try {
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const file = join(dir, 'doc.html');
    await writeFile(file, req.html, 'utf8');
    await win.loadFile(file);
    if (savePath) {
      const pdf = await win.webContents.printToPDF({
        pageSize: req.paper,
        landscape: req.landscape,
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: '<span></span>',
        footerTemplate:
          '<div style="font-size:8px;width:100%;padding:0 14mm;display:flex;justify-content:space-between">' +
          `<span>${esc(req.title)}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
        margins: { top: 0.7, bottom: 0.8, left: 0.55, right: 0.55 },
      });
      await deps.write(savePath, pdf);
      return { status: 'saved', path: savePath };
    }
    return await new Promise<PrintResult>((resolve) =>
      win.webContents.print(
        { silent: false, printBackground: true, pageSize: req.paper, landscape: req.landscape },
        (ok, reason) =>
          resolve(
            ok
              ? { status: 'printed' }
              : reason === 'cancelled' || reason === 'Print job canceled'
                ? { status: 'cancelled' }
                : { status: 'error', message: reason },
          ),
      ),
    );
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : String(e) };
  } finally {
    win.destroy();
    await rm(dir, { recursive: true, force: true });
  }
}
