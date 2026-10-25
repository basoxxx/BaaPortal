import type { BrowserWindow, MessageBoxOptions } from 'electron';

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
  showMessageBox(opts: MessageBoxOptions): Promise<{ response: number }>;
}

/**
 * Finestra nativa del processo principale: è la difesa contro un renderer difettoso. Il pulsante
 * predefinito e quello di Esc sono «Annulla»; chiudere la finestra equivale ad annullare.
 */
export function createConfirm(
  dialog: DialogLike,
  getWindow: () => BrowserWindow | null,
): ConfirmFn {
  return async (_owner, t) => {
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
    const win = getWindow();
    const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    return r.response === 0;
  };
}
