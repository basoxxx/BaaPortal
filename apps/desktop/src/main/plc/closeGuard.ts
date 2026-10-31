import type { BrowserWindow, MessageBoxOptions } from 'electron';
import { tr } from './dialogText';

export const INTERRUPT_MESSAGE =
  'Un caricamento nella CPU è in corso. Interromperlo? La CPU può restare con un programma incompleto.';

interface DialogLike {
  showMessageBox(win: BrowserWindow, opts: MessageBoxOptions): Promise<{ response: number }>;
  showMessageBox(opts: MessageBoxOptions): Promise<{ response: number }>;
}

/**
 * Domanda nativa prima di chiudere con una scrittura in corso: «Annulla» è predefinito e di fuga,
 * quindi tiene la finestra aperta. Non passa dall'aggancio e2e delle conferme di scrittura.
 */
export function createInterruptAsk(
  dialog: DialogLike,
  windowOf: () => BrowserWindow | null,
): () => Promise<boolean> {
  return async () => {
    const win = windowOf();
    const opts: MessageBoxOptions = {
      type: 'warning',
      buttons: [tr('Annulla'), tr('Interrompi')],
      defaultId: 0,
      cancelId: 0,
      title: tr('Caricamento in corso'),
      message: tr(INTERRUPT_MESSAGE),
      noLink: true,
    };
    // Senza finestra a cui agganciarla, la domanda si mostra da sola: l'uscita non va persa.
    const r =
      win && !win.isDestroyed()
        ? await dialog.showMessageBox(win, opts)
        : await dialog.showMessageBox(opts);
    return r.response === 1;
  };
}

/**
 * Decide se una chiusura (di finestra o dell'app) può procedere mentre si scrive nella CPU. La
 * risposta «Interrompi» vale finché la scrittura dura, così la chiusura della finestra e l'uscita
 * non chiedono due volte. Senza Electron, per poterla provare.
 */
export class WriteCloseGuard {
  private confirmed = false;
  private asking: Promise<boolean> | null = null;

  constructor(
    private readonly writing: () => boolean,
    private readonly ask: () => Promise<boolean>,
    private readonly interrupt: () => void = () => undefined,
  ) {}

  /** `true` se prima di chiudere va chiesta conferma. */
  needsConfirm(): boolean {
    if (!this.writing()) {
      this.confirmed = false;
      return false;
    }
    return !this.confirmed;
  }

  /**
   * Chiede (una sola domanda alla volta); `true` se l'utente sceglie di interrompere, e allora la
   * scrittura si ferma prima del blocco successivo anche se poi la chiusura viene annullata. Chi
   * arriva mentre la domanda è aperta riceve `false`: agisce solo chi l'ha posta.
   */
  confirm(): Promise<boolean> {
    if (this.asking) return Promise.resolve(false);
    this.asking = this.ask()
      .catch(() => false)
      .then((yes) => {
        this.confirmed = yes;
        if (yes) this.interrupt();
        return yes;
      })
      .finally(() => {
        this.asking = null;
      });
    return this.asking;
  }
}
