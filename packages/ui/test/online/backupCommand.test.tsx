import { act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { commands } from '../../src/commands/commands';
import { getProgress } from '../../src/project/progress';
import { ctx, setupOnline } from './downloadHelpers';

const keys = (app: Awaited<ReturnType<typeof setupOnline>>['app']) =>
  app.store.getState().messages.map((m) => m.textKey);

describe('online.backup', () => {
  it('abilitato solo online', async () => {
    const { app } = await setupOnline([]);
    expect(commands['online.backup'].isEnabled(app.store.getState())).toBe(true);
    await act(async () => {
      await commands['online.goOffline'].run(ctx(app));
    });
    expect(commands['online.backup'].isEnabled(app.store.getState())).toBe(false);
  });

  it('esito con percorso e blocchi non copiati', async () => {
    const { app } = await setupOnline([]);
    app.bridge.plcBackupResults.push({
      ok: true,
      path: '/tmp/cpu.baapbak',
      count: 5,
      failed: [{ type: 'DB', number: 3, error: 'protetto' }],
    });
    await act(async () => {
      await commands['online.backup'].run(ctx(app));
    });
    const m = app.store.getState().messages.find((x) => x.textKey === 'messages.backupDonePartial');
    expect(m?.params).toEqual({
      path: '/tmp/cpu.baapbak',
      count: '5',
      missing: '1',
      list: 'DB3',
    });
    expect(getProgress()).toBeNull();
  });

  it('esito completo: messaggio di conferma', async () => {
    const { app } = await setupOnline([]);
    app.bridge.plcBackupResults.push({ ok: true, path: '/tmp/a.baapbak', count: 2, failed: [] });
    await act(async () => {
      await commands['online.backup'].run(ctx(app));
    });
    expect(keys(app)).toContain('messages.backupDone');
  });

  it('annullato: nessun messaggio; errore: messaggio', async () => {
    const { app } = await setupOnline([]);
    const n = app.store.getState().messages.length;
    app.bridge.plcBackupResults.push({ ok: false, cancelled: true });
    await act(async () => {
      await commands['online.backup'].run(ctx(app));
    });
    expect(app.store.getState().messages.length).toBe(n);
    app.bridge.plcBackupResults.push({ ok: false, error: 'CPU diversa' });
    await act(async () => {
      await commands['online.backup'].run(ctx(app));
    });
    expect(
      app.store.getState().messages.find((x) => x.textKey === 'messages.backupFailed')?.params,
    ).toEqual({ message: 'CPU diversa' });
  });

  it('durante il backup: avanzamento con Interrompi, comando disabilitato', async () => {
    const { app } = await setupOnline([]);
    let release!: () => void;
    app.bridge.plcBackupGate = new Promise<void>((r) => (release = r));
    app.bridge.plcBackupResults.push({ ok: false, cancelled: true });
    let p!: Promise<void>;
    act(() => {
      p = commands['online.backup'].run(ctx(app)) as Promise<void>;
    });
    expect(getProgress()?.labelKey).toBe('status.backup');
    expect(commands['online.backup'].isEnabled(app.store.getState())).toBe(false);
    act(() => getProgress()?.cancel?.());
    expect(app.bridge.plcBackupCancelCalls).toBe(1);
    await act(async () => {
      release();
      await p;
    });
    expect(getProgress()).toBeNull();
    expect(app.bridge.plcBackupCalls).toBe(1);
  });
});
