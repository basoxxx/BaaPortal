import { app, BrowserWindow, dialog, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { kitZip, type KitProgress } from '@baaportal/s7comm';
import { collectTcp } from '@baaportal/s7comm/node';
import type { KitStartResult, KitSummary } from '@baaportal/ui';
import { writeFileAtomic } from './fsAtomic';
import { kitFileName, parseKitOptions } from './kitOptions';

const PROGRESS_INTERVAL_MS = 100; // al massimo 10 eventi al secondo

export type KitSaveReply = { ok: true; path: string | null } | { ok: false; error: string };

type Handle = (
  channel: string,
  listener: (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
) => void;

/**
 * Raccolta dati CPU in sola lettura. La rete la usa solo questo processo (collectTcp, che passa dal
 * filtro di sola lettura); il renderer vede soltanto l'avanzamento e il riepilogo.
 */
export function registerKit(handle: Handle): void {
  let abort: AbortController | null = null;
  // Solo l'ultima raccolta resta in memoria, per poterla salvare di nuovo; la tiene finché non ne
  // parte un'altra o l'app si chiude.
  // Una raccolta IN CORSO appartiene alla finestra che l'ha avviata: solo quella può interromperla.
  // Una raccolta FINITA invece si può salvare da qualunque finestra fidata (i canali IPC arrivano
  // solo da finestre fidate): la finestra che l'ha avviata potrebbe non esserci più, e senza questa
  // regola i dati raccolti resterebbero irraggiungibili.
  let runOwner: WebContents | null = null;
  let last: { bytes: Uint8Array; fileName: string; summary: KitSummary; saved: boolean } | null =
    null;

  const saveLast = async (sender: WebContents): Promise<string | null> => {
    const cur = last; // una nuova raccolta durante il dialogo non cambia ciò che si sta salvando
    if (!cur) throw new Error('Nessuna raccolta da salvare');
    const win = BrowserWindow.fromWebContents(sender);
    const opts = {
      defaultPath: cur.fileName,
      filters: [{ name: 'Archivio zip', extensions: ['zip'] }],
    };
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    await writeFileAtomic(r.filePath, cur.bytes);
    cur.saved = true;
    return r.filePath;
  };

  handle('kit:start', async (e, raw): Promise<KitStartResult> => {
    let opts;
    try {
      opts = parseKitOptions(raw);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (abort) return { ok: false, error: 'Una raccolta è già in corso.' };
    const ctl = new AbortController();
    abort = ctl;
    last = null; // una nuova raccolta sostituisce quella rimasta in memoria
    const sender = e.sender;
    runOwner = sender;
    const onGone = () => ctl.abort();
    sender.once('destroyed', onGone);

    // Avanzamento al renderer: al massimo 10 eventi al secondo, l'ultimo non va perso.
    let lastSent = 0;
    let pending: KitProgress | null = null;
    let timer: NodeJS.Timeout | null = null;
    const flush = () => {
      timer = null;
      if (pending && !sender.isDestroyed()) {
        sender.send('kit:progress', pending);
        lastSent = Date.now();
      }
      pending = null;
    };
    const onProgress = (p: KitProgress) => {
      pending = p;
      const wait = lastSent + PROGRESS_INTERVAL_MS - Date.now();
      if (wait <= 0) flush();
      else timer ??= setTimeout(flush, wait);
    };

    try {
      const result = await collectTcp(opts, onProgress, ctl.signal, app.getVersion());
      if (timer) clearTimeout(timer);
      flush();
      const bytes = kitZip(result);
      const summary = result.summary;
      last = {
        bytes,
        fileName: kitFileName(summary.identity?.orderNumber, new Date()),
        summary: summary as unknown as KitSummary,
        saved: false,
      };
      let savedTo: string | null = null;
      let saveError: string | undefined;
      // Una raccolta interrotta non apre il salvataggio da sola: la finestra offre "Salva…".
      if (!ctl.signal.aborted && !sender.isDestroyed()) {
        try {
          savedTo = await saveLast(sender);
        } catch (err) {
          savedTo = null; // la finestra mostra l'errore e offre "Salva…" per riprovare
          saveError = err instanceof Error ? err.message : String(err);
        }
      }
      return saveError === undefined
        ? { ok: true, savedTo, summary }
        : { ok: true, savedTo, summary, saveError };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      if (timer) clearTimeout(timer);
      sender.removeListener('destroyed', onGone);
      abort = null;
      runOwner = null;
    }
  });

  handle('kit:cancel', (e) => {
    if (!abort || e.sender !== runOwner) return false;
    abort.abort();
    return true;
  });

  handle('kit:save', async (e): Promise<KitSaveReply> => {
    if (!last) return { ok: false, error: 'Nessuna raccolta da salvare' };
    try {
      return { ok: true, path: await saveLast(e.sender) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Riepilogo della raccolta finita e non ancora salvata, per chi riapre la finestra.
  handle('kit:hasUnsaved', (): KitSummary | null => (last && !last.saved ? last.summary : null));
}
