import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { commands } from '../../src/commands/commands';
import { preparePlcDownload } from '../../src/online/plcDownload';
import { ctx, setupOnline } from './downloadHelpers';

type App = Awaited<ReturnType<typeof setupOnline>>['app'];
const keys = (app: App) => app.store.getState().messages.map((m) => m.textKey);

async function panel(mode: 'RUN' | 'STOP') {
  const { app } = await setupOnline([], mode);
  act(() => app.store.getState().setTaskCard('test'));
  return { app, p: within(screen.getAllByTestId('cpu-panel-online')[0]!) };
}
const click = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
};

describe('comandi della CPU sul PLC', () => {
  it('RUN e STOP chiamano plcControl senza forzare il modo', async () => {
    const { app, p } = await panel('STOP');
    expect(p.getByTestId('cpu-run')).toBeEnabled();
    expect(p.getByTestId('cpu-stop')).toBeDisabled();
    await click(p.getByTestId('cpu-run'));
    expect(app.bridge.plcControlCalls).toEqual(['RUN']);
    expect(app.store.getState().online.mode).toBe('STOP');
    act(() => app.bridge.emitPlcEvent({ kind: 'mode', mode: 'RUN' }));
    expect(commands['online.stopCpu'].isEnabled(app.store.getState())).toBe(true);
    await act(async () => {
      await commands['online.stopCpu'].run(ctx(app));
    });
    expect(app.bridge.plcControlCalls).toEqual(['RUN', 'STOP']);
    expect(app.store.getState().online.mode).toBe('RUN');
  });

  it('MRES disabilitato con la spiegazione', async () => {
    const { p } = await panel('STOP');
    expect(p.getByTestId('cpu-mres')).toBeDisabled();
    expect(p.getByTestId('cpu-mres')).toHaveAttribute('title', 'Usa il selettore della CPU (MRES)');
  });

  it('copia RAM in ROM e comprimi', async () => {
    const { app, p } = await panel('STOP');
    await click(p.getByTestId('cpu-copy-ram-rom'));
    await click(p.getByTestId('cpu-compress'));
    expect(app.bridge.plcControlCalls).toEqual(['COPY_RAM_TO_ROM', 'COMPRESS']);
    expect(keys(app)).toContain('messages.plcCopiedRamToRom');
    expect(keys(app)).toContain('messages.plcCompressed');
  });

  it('annullato: nessun messaggio', async () => {
    const { app, p } = await panel('STOP');
    const n = app.store.getState().messages.length;
    app.bridge.plcControlResults.push({ ok: false, cancelled: true });
    await click(p.getByTestId('cpu-compress'));
    expect(app.store.getState().messages.length).toBe(n);
    expect(app.store.getState().online.commanding).toBeFalsy();
  });

  it('errore: messaggio', async () => {
    const { app, p } = await panel('STOP');
    app.bridge.plcControlResults.push({ ok: false, error: 'rifiutato' });
    await click(p.getByTestId('cpu-run'));
    const m = app.store.getState().messages.find((x) => x.textKey === 'messages.plcCommandFailed');
    expect(m?.params).toEqual({ message: 'rifiutato' });
    expect(app.store.getState().online.commanding).toBe(false);
  });

  it('un comando alla volta e non durante il caricamento', async () => {
    const { app } = await setupOnline([], 'STOP');
    let release!: () => void;
    const orig = app.bridge.plcControl.bind(app.bridge);
    app.bridge.plcControl = async (op) => {
      await new Promise<void>((r) => (release = r));
      return orig(op);
    };
    let first!: Promise<void>;
    act(() => {
      first = Promise.resolve(commands['online.compress'].run(ctx(app)));
    });
    expect(app.store.getState().online.commanding).toBe(true);
    for (const id of ['online.startCpu', 'online.copyRamToRom', 'online.compress'] as const)
      expect(commands[id].isEnabled(app.store.getState())).toBe(false);
    await act(async () => {
      release();
      await first;
    });
    expect(commands['online.compress'].isEnabled(app.store.getState())).toBe(true);
    act(() => app.store.getState().patchOnline({ downloading: true }));
    for (const id of ['online.startCpu', 'online.copyRamToRom', 'online.compress'] as const)
      expect(commands[id].isEnabled(app.store.getState())).toBe(false);
  });

  it('durante un comando il caricamento è bloccato', async () => {
    const { app } = await setupOnline([], 'STOP');
    app.bridge.plcControl = () => new Promise(() => undefined);
    act(() => {
      void commands['online.compress'].run(ctx(app));
    });
    expect(commands['online.download'].isEnabled(app.store.getState())).toBe(false);
    await act(async () => {
      await preparePlcDownload(ctx(app));
    });
    expect(app.store.getState().online.downloading).toBeFalsy();
    expect(screen.queryByTestId('download-preview')).toBeNull();
  });

  it('collegamento perso a metà comando: la risposta tardiva non tocca la nuova sessione', async () => {
    const { app } = await setupOnline([], 'STOP');
    let release!: () => void;
    app.bridge.plcControl = () =>
      new Promise((r) => {
        release = () => r({ ok: false, error: 'tardivo' });
      });
    act(() => {
      void commands['online.compress'].run(ctx(app));
    });
    act(() => app.bridge.emitPlcEvent({ kind: 'lost', reason: 'closed' }));
    expect(app.store.getState().online.commanding).toBeFalsy();
    app.bridge.plcResults.push({
      ok: true,
      mode: 'STOP',
      identity: { orderNumber: '6ES7 315-2EH14-0AB0', moduleName: 'CPU 315-2 PN/DP' },
    });
    await act(async () => {
      await commands['online.goOnline'].run(ctx(app));
    });
    app.store.getState().patchOnline({ commanding: true });
    const n = app.store.getState().messages.length;
    await act(async () => {
      release();
    });
    expect(app.store.getState().messages.length).toBe(n);
    expect(app.store.getState().online.commanding).toBe(true);
  });
});
