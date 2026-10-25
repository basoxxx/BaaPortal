import { app, type BrowserWindow, type MessageBoxOptions } from 'electron';

/** Testi della finestra di conferma di una scrittura nella CPU. */
export interface WriteConfirmTexts {
  title: string;
  message: string;
  detail: string;
  confirmLabel: string;
}

/** Conferma nativa: `true` solo se l'utente sceglie il pulsante di conferma. */
export type ConfirmFn = (owner: unknown, texts: WriteConfirmTexts) => Promise<boolean>;

interface DialogLike {
  showMessageBox(win: BrowserWindow, opts: MessageBoxOptions): Promise<{ response: number }>;
}

/**
 * Finestra nativa del processo principale: è la difesa contro un renderer difettoso. Il pulsante
 * predefinito e quello di Esc sono «Annulla»; chiudere la finestra equivale ad annullare.
 */
export function createConfirm(
  dialog: DialogLike,
  windowOf: (owner: unknown) => BrowserWindow | null,
): ConfirmFn {
  return async (owner, t) => {
    // Aggancio solo per i test e2e: mai nell'app impacchettata, e solo con 'yes' o 'no'.
    const hook = process.env['BAAPORTAL_E2E_CONFIRM'];
    if (!app.isPackaged && (hook === 'yes' || hook === 'no')) return hook === 'yes';
    const opts: MessageBoxOptions = {
      type: 'warning',
      buttons: [t.confirmLabel, 'Annulla'],
      defaultId: 1,
      cancelId: 1,
      title: t.title,
      message: t.message,
      detail: t.detail,
      noLink: true,
    };
    // La finestra è quella che ha chiesto la scrittura; senza, non si mostra nulla e non si scrive.
    const win = windowOf(owner);
    if (!win || win.isDestroyed()) throw new Error('Finestra non disponibile per la conferma');
    const r = await dialog.showMessageBox(win, opts);
    return r.response === 0;
  };
}
