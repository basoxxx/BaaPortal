import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  PRINT_WINDOW_OPTIONS,
  parsePrintRequest,
  printDocument,
  type PrintDeps,
  type PrintWindow,
} from '../src/main/printDocument';

const REQ = {
  html: '<!doctype html><p>ciao</p>',
  mode: 'pdf',
  paper: 'A4',
  landscape: false,
  title: 'Linea <3>',
  defaultName: 'Linea.pdf',
};

function fakes(over: Partial<PrintDeps> = {}) {
  let loaded = '';
  const win = {
    loadFile: vi.fn(async (p: string) => {
      loaded = readFileSync(p, 'utf8'); // il file temporaneo esiste durante il caricamento
    }),
    destroy: vi.fn(),
    webContents: {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- il parametro tipizza mock.calls
      printToPDF: vi.fn(async (_o: Record<string, unknown>) => new Uint8Array([37, 80, 68, 70])),
      print: vi.fn((_o: Record<string, unknown>, cb: (ok: boolean, r: string) => void) =>
        cb(true, ''),
      ),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    },
  } satisfies PrintWindow;
  const deps: PrintDeps = {
    createWindow: () => win,
    pickSavePath: async () => '/out/Linea.pdf',
    write: vi.fn(async () => undefined),
    ...over,
  };
  return { win, deps, loaded: () => loaded };
}

describe('finestra di stampa', () => {
  it('è isolata: sandbox, niente Node, niente JavaScript, partizione in memoria', () => {
    expect(PRINT_WINDOW_OPTIONS.show).toBe(false);
    expect(PRINT_WINDOW_OPTIONS.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      webSecurity: true,
    });
    expect(PRINT_WINDOW_OPTIONS.webPreferences.partition).not.toMatch(/^persist:/);
    expect('preload' in PRINT_WINDOW_OPTIONS.webPreferences).toBe(false);
  });

  it('PDF: carica l’HTML, produce il PDF con piè di pagina escapato e lo scrive', async () => {
    const f = fakes();
    expect(await printDocument(REQ, f.deps)).toEqual({ status: 'saved', path: '/out/Linea.pdf' });
    expect(f.loaded()).toBe(REQ.html);
    const o = f.win.webContents.printToPDF.mock.calls[0]![0];
    expect(o).toMatchObject({ pageSize: 'A4', landscape: false, displayHeaderFooter: true });
    expect(o['footerTemplate']).toContain('Linea &#60;3&#62;');
    expect(o['footerTemplate']).not.toContain('<3>');
    expect(f.deps.write).toHaveBeenCalledWith('/out/Linea.pdf', new Uint8Array([37, 80, 68, 70]));
    expect(f.win.webContents.setWindowOpenHandler.mock.calls[0]![0]()).toEqual({ action: 'deny' });
    expect(f.win.destroy).toHaveBeenCalled();
  });

  it('salvataggio annullato: nessuna finestra, nessuna scrittura', async () => {
    const create = vi.fn();
    const f = fakes({ pickSavePath: async () => null, createWindow: create });
    expect(await printDocument(REQ, f.deps)).toEqual({ status: 'cancelled' });
    expect(create).not.toHaveBeenCalled();
  });

  it('stampa: esito del sistema, annullamento compreso', async () => {
    const f = fakes();
    expect(await printDocument({ ...REQ, mode: 'print' }, f.deps)).toEqual({ status: 'printed' });
    f.win.webContents.print.mockImplementationOnce((_o, cb) => cb(false, 'cancelled'));
    expect(await printDocument({ ...REQ, mode: 'print' }, f.deps)).toEqual({ status: 'cancelled' });
  });

  it('un errore diventa un esito e la finestra si chiude comunque', async () => {
    const f = fakes();
    f.win.webContents.printToPDF.mockRejectedValueOnce(new Error('boom'));
    expect(await printDocument(REQ, f.deps)).toEqual({ status: 'error', message: 'boom' });
    expect(f.win.destroy).toHaveBeenCalled();
  });

  it('rifiuta richieste malformate', () => {
    expect(() => parsePrintRequest(null)).toThrow();
    expect(() => parsePrintRequest({ ...REQ, paper: 'A0' })).toThrow();
    expect(() => parsePrintRequest({ ...REQ, html: 5 })).toThrow();
  });
});
