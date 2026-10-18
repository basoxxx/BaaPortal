import { useEffect } from 'react';
import { useServices } from '../state/AppContext';
import { commands, matchShortcut } from './commands';

export function useShortcuts(): void {
  const ctx = useServices();
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';
      for (const cmd of Object.values(commands)) {
        if (!cmd.shortcut || !matchShortcut(e, cmd.shortcut, ctx.bridge.platform)) continue;
        if (inField && cmd.shortcut !== 'Mod+S') continue;
        if (!cmd.isEnabled(ctx.store.getState())) continue;
        e.preventDefault();
        void cmd.run(ctx);
        return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [ctx]);
}
