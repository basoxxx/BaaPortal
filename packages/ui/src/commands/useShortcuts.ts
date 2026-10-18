import { useEffect } from 'react';
import { useServices } from '../state/AppContext';
import { commands, matchShortcut, type CommandContext } from './commands';

/** Esegue il comando associato al tasto premuto; true se un comando è partito. */
export function handleShortcutKeydown(e: KeyboardEvent, ctx: CommandContext): boolean {
  if (e.repeat) return false;
  // Un dialogo modale aperto tiene per sé la tastiera: nessun comando globale.
  if (ctx.store.getState().dialog !== null) return false;
  const target = e.target as HTMLElement | null;
  const inField = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';
  for (const cmd of Object.values(commands)) {
    const all = [cmd.shortcut, ...(cmd.altShortcuts ?? [])];
    if (!all.some((sc) => sc && matchShortcut(e, sc, ctx.bridge.platform))) continue;
    // Nei campi di testo resta globale solo Mod+S: annulla e ripeti sono quelli del campo.
    if (inField && cmd.shortcut !== 'Mod+S') continue;
    // Una bozza ancora nel campo va confermata prima che il comando legga lo stato: il campo può
    // stare in una finestra separata, quindi si toglie il focus proprio a lui.
    if (inField) target.blur();
    if (!cmd.isEnabled(ctx.store.getState())) continue;
    e.preventDefault();
    const restore = inField ? target : null;
    void Promise.resolve(cmd.run(ctx)).then(() => {
      const doc = restore?.ownerDocument;
      if (restore?.isConnected && doc?.activeElement === doc?.body) restore.focus();
    });
    return true;
  }
  return false;
}

export function useShortcuts(): void {
  const ctx = useServices();
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => void handleShortcutKeydown(e, ctx);
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [ctx]);
}
