// Tasti dell'editor KOP: mappa un evento di tastiera in un'azione.
export type LadAction =
  | 'contactNo'
  | 'contactNc'
  | 'coil'
  | 'openBranch'
  | 'closeBranch'
  | 'delete'
  | 'edit'
  | 'left'
  | 'right'
  | 'up'
  | 'down';

const KEYS: Record<string, LadAction> = {
  F2: 'contactNo',
  F3: 'contactNc',
  F7: 'coil',
  F8: 'openBranch',
  F9: 'closeBranch',
  Delete: 'delete',
  Enter: 'edit',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

/** Tasto mostrato nel `title` dei pulsanti della barra degli strumenti. */
export const LAD_TOOL_KEYS = {
  contactNo: 'F2',
  contactNc: 'F3',
  coil: 'F7',
  openBranch: 'F8',
  closeBranch: 'F9',
} as const;

export type KeyLike = { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean };

/** Azione del tasto premuto; con Ctrl, Cmd o Alt premuti non c'è nessuna azione. */
export function ladAction(e: KeyLike): LadAction | undefined {
  if (e.ctrlKey || e.metaKey || e.altKey) return undefined;
  return KEYS[e.key];
}
