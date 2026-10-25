import { act } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { commands } from '../../src/commands/commands';
import { initI18n } from '../../src/i18n';
import {
  actionText,
  chooseRestore,
  executeRestore,
  outcomeText,
} from '../../src/online/plcRestore';
import type { PlcRestoreResult } from '../../src/online/plcTypes';
import { getProgress } from '../../src/project/progress';
import { DEFAULT_SETTINGS, saveSettings, updateSettings } from '../../src/settings/settings';
import { ctx, setupOnline } from './downloadHelpers';

afterEach(async () => {
  saveSettings(DEFAULT_SETTINGS);
  await initI18n('it');
});

const RES: PlcRestoreResult = {
  ok: true,
  cpuStopped: true,
  rows: [{ name: 'OB1', outcome: 'loaded' }],
};

describe('online.restore', () => {
  it('disabilitato offline, con l impostazione spenta, durante un caricamento', async () => {
    const { app } = await setupOnline([]);
    const cmd = commands['online.restore'];
    expect(cmd.isEnabled(app.store.getState())).toBe(false); // impostazione spenta
    updateSettings({ online: { experimental: true } });
    expect(cmd.isEnabled(app.store.getState())).toBe(true);
    act(() => app.store.getState().patchOnline({ downloading: true }));
    expect(cmd.isEnabled(app.store.getState())).toBe(false);
    act(() => app.store.getState().patchOnline({ downloading: false, restoring: true }));
    expect(cmd.isEnabled(app.store.getState())).toBe(false);
    act(() => app.store.getState().patchOnline({ restoring: false }));
    await act(async () => {
      await commands['online.goOffline'].run(ctx(app));
    });
    expect(cmd.isEnabled(app.store.getState())).toBe(false);
  });

  it('il comando apre la finestra', async () => {
    const { app } = await setupOnline([]);
    updateSettings({ online: { experimental: true } });
    await act(async () => {
      await commands['online.restore'].run(ctx(app));
    });
    expect(app.store.getState().dialog).toEqual({ kind: 'restore' });
  });
});

describe('testi delle righe', () => {
  it('azioni: SDB 2 «Saltato: creato dalla CPU»; FC9 «Resta nella CPU»', () => {
    expect(actionText({ name: 'SDB 2', action: 'skip', why: 'creato dalla CPU' })).toBe(
      'Saltato: creato dalla CPU',
    );
    expect(actionText({ name: 'FC9', action: 'keep' })).toBe('Resta nella CPU');
    expect(actionText({ name: 'OB1', action: 'load' })).toBe('Carica');
    expect(actionText({ name: 'SDB 5', action: 'delete' })).toBe('Cancella');
  });

  it('esiti', () => {
    expect(outcomeText({ name: 'a', outcome: 'loaded' })).toBe('Caricato');
    expect(outcomeText({ name: 'a', outcome: 'unknown', error: 'Esito sconosciuto' })).toBe(
      'Esito sconosciuto',
    );
    expect(outcomeText({ name: 'a', outcome: 'notDone' })).toBe('Non caricato');
    expect(
      outcomeText({ name: 'a', outcome: 'rejected', error: 'Rifiutato dalla CPU: D241' }),
    ).toBe('Rifiutato dalla CPU: D241');
    expect(
      outcomeText({
        name: 'a',
        outcome: 'rejected',
        error: 'Rifiutato da BaaPortal (frame non ammesso)',
      }),
    ).toBe('Rifiutato da BaaPortal (frame non ammesso)');
  });
});

describe('chooseRestore / executeRestore', () => {
  it('piano annullato → cancelled, piano valido → righe', async () => {
    const { app } = await setupOnline([]);
    app.bridge.plcRestorePlanImpl = () => ({ ok: false, cancelled: true });
    expect(await chooseRestore(app.bridge)).toEqual({ kind: 'cancelled' });
    app.bridge.plcRestorePlanImpl = () => ({ ok: false, error: 'Forzamento attivo' });
    expect(await chooseRestore(app.bridge)).toEqual({ kind: 'error', error: 'Forzamento attivo' });
  });

  it('avvia con restart, segna restoring e l avanzamento con Interrompi, rilancia il confronto', async () => {
    const { app } = await setupOnline([]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    app.bridge.plcRestoreImpl = () => RES;
    const orig = app.bridge.plcRestore.bind(app.bridge);
    app.bridge.plcRestore = async (req) => {
      await gate;
      return orig(req);
    };
    const compares = app.bridge.plcBlocksCalls;
    let p!: ReturnType<typeof executeRestore>;
    act(() => {
      p = executeRestore({ store: app.store, bridge: app.bridge }, 'tok', true);
    });
    expect(app.store.getState().online.restoring).toBe(true);
    expect(getProgress()?.labelKey).toBe('status.restore');
    act(() => getProgress()?.cancel?.());
    expect(app.bridge.plcRestoreInterruptCalls).toBe(1);
    await act(async () => {
      release();
      await p;
    });
    expect(app.bridge.plcRestoreCalls).toEqual([{ token: 'tok', restart: true }]);
    expect(app.store.getState().online.restoring).toBeFalsy();
    expect(getProgress()).toBeNull();
    expect(app.bridge.plcBlocksCalls).toBeGreaterThan(compares);
  });

  it('annullato nella conferma: nessun confronto', async () => {
    const { app } = await setupOnline([]);
    app.bridge.plcRestoreImpl = () => ({ ok: false, cancelled: true, rows: [], cpuStopped: false });
    const compares = app.bridge.plcBlocksCalls;
    const r = await act(() =>
      executeRestore({ store: app.store, bridge: app.bridge }, 'tok', false),
    );
    expect(r.cancelled).toBe(true);
    expect(app.bridge.plcBlocksCalls).toBe(compares);
  });
});
