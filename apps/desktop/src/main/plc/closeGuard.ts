import type { BrowserWindow, MessageBoxOptions } from 'electron';

export const INTERRUPT_MESSAGE =
  'Un caricamento nella CPU è in corso. Interromperlo? La CPU può restare con un programma incompleto.';

interface DialogLike {
  showMessageBox(win: BrowserWindow, opts: MessageBoxOptions): Promise<{ response: number }>;
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
    // Senza finestra a cui agganciare la domanda non si può chiedere: si resta, non si interrompe.
    if (!win || win.isDestroyed()) return false;
    const r = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Annulla', 'Interrompi'],
      defaultId: 0,
      cancelId: 0,
      title: 'Caricamento in corso',
      message: INTERRUPT_MESSAGE,
      noLink: true,
    });
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
  ) {}

  /** `true` se prima di chiudere va chiesta conferma. */
  needsConfirm(): boolean {
    if (!this.writing()) {
      this.confirmed = false;
      return false;
    }
    return !this.confirmed;
  }

  /** Chiede (una sola domanda alla volta); `true` se l'utente sceglie di interrompere. */
  confirm(): Promise<boolean> {
    this.asking ??= this.ask()
      .catch(() => false)
      .then((yes) => {
        this.confirmed = yes;
        return yes;
      })
      .finally(() => {
        this.asking = null;
      });
    return this.asking;
  }
}
