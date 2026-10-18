import { useEffect } from 'react';
import { useServices } from '../state/AppContext';
import { commands, matchShortcut, type CommandContext } from './commands';

/** Esegue il comando associato al tasto premuto; true se un comando è partito. */
export function handleShortcutKeydown(e: KeyboardEvent, ctx: CommandContext): boolean {
  if (e.repeat) return false;
  const target = e.target as HTMLElement | null;
  const inField = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';
  for (const cmd of Object.values(commands)) {
    const all = [cmd.shortcut, ...(cmd.altShortcuts ?? [])];
    if (!all.some((sc) => sc && matchShortcut(e, sc, ctx.bridge.platform))) continue;
    // Nei campi di testo resta globale solo Mod+S: annulla e ripeti sono quelli del campo.
    if (inField && cmd.shortcut !== 'Mod+S') continue;
    if (!cmd.isEnabled(ctx.store.getState())) continue;
    e.preventDefault();
    void cmd.run(ctx);
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
