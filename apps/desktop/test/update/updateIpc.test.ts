import { describe, expect, it, vi } from 'vitest';
import { registerUpdate } from '../../src/main/update/updateIpc';
import type { UpdateService } from '../../src/main/update/updateService';

type H = (e: unknown, ...a: unknown[]) => unknown;
const info = {
  enabled: false,
  prereleaseBuild: false,
  current: '0.12.0',
  platform: 'win32' as const,
  mode: 'install' as const,
};

function setup(service: UpdateService | null) {
  const handlers = new Map<string, H>();
  registerUpdate((ch, l) => handlers.set(ch, l as H), service, info);
  return handlers;
}

describe('registerUpdate', () => {
  it('senza servizio: risposte spente', async () => {
    const h = setup(null);
    expect(h.get('update:info')!({})).toEqual(info);
    expect(h.get('update:state')!({})).toBeNull();
    expect(h.get('update:canInstall')!({})).toEqual({ ok: false, reason: 'notReady' });
    expect(await h.get('update:install')!({})).toEqual({ ok: false, reason: 'notReady' });
  });

  it('prefs non valide: rifiutate', async () => {
    const setPrefs = vi.fn();
    const h = setup({ setPrefs } as unknown as UpdateService);
    await expect(h.get('update:prefs')!({}, { checkOnStartup: 1 })).rejects.toThrow();
    expect(setPrefs).not.toHaveBeenCalled();
    await h.get('update:prefs')!({}, { checkOnStartup: true, prerelease: null });
    expect(setPrefs).toHaveBeenCalledTimes(1);
  });

  it('later e openNotes con valori non stringa sono ignorati', async () => {
    const later = vi.fn();
    const openNotes = vi.fn();
    const h = setup({ later, openNotes } as unknown as UpdateService);
    h.get('update:later')!({}, 5);
    await h.get('update:openNotes')!({}, { x: 1 });
    expect(later).not.toHaveBeenCalled();
    expect(openNotes).not.toHaveBeenCalled();
    h.get('update:later')!({}, '0.12.1');
    expect(later).toHaveBeenCalledWith('0.12.1');
  });
});
