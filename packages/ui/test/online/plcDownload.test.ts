import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { parseBlockFile } from '@baaportal/s7comm';
import { commands } from '../../src/commands/commands';
import type { PlcDownloadResult } from '../../src/online/plcTypes';
import { cpuBlock, runDownload, setupOnline } from './downloadHelpers';

const st = (app: Awaited<ReturnType<typeof setupOnline>>['app']) => app.store.getState();
const messages = (app: Awaited<ReturnType<typeof setupOnline>>['app']) =>
  st(app).messages.map((m) => m.textKey);
const ok = async () => {
  await screen.findByTestId('download-preview');
};
const press = async () => {
  await act(async () => {
    fireEvent.click(screen.getByTestId('download-ok'));
  });
};
const names = (files: Uint8Array[]) =>
  files.map((f) => {
    const h = parseBlockFile(f).header;
    return `${h.type}${h.number}`;
  });

describe('Carica nel dispositivo (PLC vero)', () => {
  it('ordine dei file come downloadOrder', async () => {
    const { app } = await setupOnline([
      ['OB', 35],
      ['FB', 1],
      ['FC', 1],
      ['DB', 3],
    ]);
    await runDownload(app);
    await ok();
    await press();
    await waitFor(() => expect(app.bridge.plcDownloadCalls).toHaveLength(1));
    const order = names(app.bridge.plcDownloadCalls[0]!.files).filter((n) =>
      ['OB35', 'FB1', 'FC1', 'DB3'].includes(n),
    );
    expect(order).toEqual(['DB3', 'FC1', 'FB1', 'OB35']);
    expect(app.bridge.plcDownloadCalls[0]!.deleteBlocks).toEqual([]);
  }, 30_000);

  it('sequenza: STOP, caricamento, «Avviare la CPU?», RUN, nuovo confronto', async () => {
    const { app } = await setupOnline([['OB', 35]]);
    const before = app.bridge.plcBlocksCalls;
    app.bridge.plcDownloadResults.push({ ok: true, loaded: ['OB35'], deleted: [] });
    await runDownload(app);
    await ok();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Arresta la CPU' }));
    await press();
    await waitFor(() => expect(app.bridge.plcWriteLog).toEqual(['STOP', 'download', 'RUN']));
    expect(app.bridge.questions.at(-1)!.message).toBe('Avviare la CPU?');
    await waitFor(() => expect(app.bridge.plcBlocksCalls).toBeGreaterThan(before + 1));
    await screen.findByTestId('download-result');
    expect(messages(app)).toContain('messages.plcDownloaded');
  }, 30_000);

  it('STOP annullato o fallito → nessun caricamento', async () => {
    const { app } = await setupOnline([['OB', 35]]);
    app.bridge.plcControlResults.push({ ok: false, cancelled: true });
    await runDownload(app);
    await ok();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Arresta la CPU' }));
    await press();
    await screen.findByTestId('download-result');
    expect(app.bridge.plcDownloadCalls).toHaveLength(0);
    expect(app.bridge.plcWriteLog).toEqual(['STOP']);
  }, 30_000);

  it('STOP fallito → messaggio e nessun caricamento', async () => {
    const { app } = await setupOnline([['OB', 35]]);
    app.bridge.plcControlResults.push({ ok: false, error: 'rifiutato' });
    await runDownload(app);
    await ok();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Arresta la CPU' }));
    await press();
    await screen.findByTestId('download-result');
    expect(app.bridge.plcDownloadCalls).toHaveLength(0);
    expect(messages(app)).toContain('messages.plcStopFailed');
  }, 30_000);

  it('«Avviare la CPU?» rifiutata → nessun RUN', async () => {
    const { app } = await setupOnline([['FC', 1]], 'STOP');
    app.bridge.plcDownloadResults.push({ ok: true, loaded: ['FC1'], deleted: [] });
    app.bridge.questionAnswers.push(false);
    await runDownload(app);
    await ok();
    await press();
    await screen.findByTestId('download-result');
    expect(app.bridge.plcWriteLog).toEqual(['download']);
    expect(app.bridge.questions).toHaveLength(1);
  }, 30_000);

  it('CPU in RUN e nessun arresto → nessuna domanda', async () => {
    const { app } = await setupOnline([['FC', 1]]);
    app.bridge.plcDownloadResults.push({ ok: true, loaded: ['FC1'], deleted: [] });
    await runDownload(app);
    await ok();
    await press();
    await screen.findByTestId('download-result');
    expect(app.bridge.questions).toHaveLength(0);
    expect(app.bridge.plcControlCalls).toEqual([]);
  }, 30_000);

  it('Cancella: solo se spuntata, con il blocco nella lista', async () => {
    const { app } = await setupOnline([['FC', 1]]);
    app.bridge.plcBlocksResults = [
      { ok: true, blocks: [{ type: 'FC', number: 9, loadLength: 80, mc7Length: 8, checksum: 5 }] },
    ];
    await runDownload(app);
    await ok();
    fireEvent.click(screen.getByRole('checkbox', { name: 'FC9' }));
    await press();
    await waitFor(() => expect(app.bridge.plcDownloadCalls).toHaveLength(1));
    expect(app.bridge.plcDownloadCalls[0]!.deleteBlocks).toEqual([{ type: 'FC', number: 9 }]);
  }, 30_000);

  it('errore a metà → messaggio con caricati e fallito', async () => {
    const { app } = await setupOnline([
      ['FC', 1],
      ['FB', 1],
    ]);
    const bad: PlcDownloadResult = {
      ok: false,
      loaded: ['FC1'],
      deleted: [],
      failedAt: 'FB1',
      error: 'CPU_ERROR',
    };
    app.bridge.plcDownloadResults.push(bad);
    await runDownload(app);
    await ok();
    await press();
    const res = await screen.findByTestId('download-result');
    expect(res).toHaveTextContent('Caricamento non riuscito');
    expect(res).toHaveTextContent('Caricati: FC1');
    expect(res).toHaveTextContent('Fallito: FB1');
    const m = st(app).messages.find((x) => x.textKey === 'messages.plcDownloadFailed')!;
    expect(m.params).toMatchObject({ loaded: 'FC1', failedAt: 'FB1', message: 'CPU_ERROR' });
  }, 30_000);

  it('annullato nella conferma nativa → nessuna modifica e nessun confronto', async () => {
    const { app } = await setupOnline([['FC', 1]]);
    const before = app.bridge.plcBlocksCalls;
    app.bridge.plcDownloadResults.push({ ok: false, cancelled: true });
    await runDownload(app);
    await ok();
    await press();
    await screen.findByTestId('download-result');
    expect(app.bridge.plcBlocksCalls).toBe(before + 1); // solo quello dell'anteprima
    expect(app.bridge.questions).toHaveLength(0);
  }, 30_000);

  it('avanzamento mostrato durante la scrittura', async () => {
    const { app } = await setupOnline([['FC', 1]]);
    let release!: (r: PlcDownloadResult) => void;
    app.bridge.plcDownload = () => new Promise((r) => (release = r));
    await runDownload(app);
    await ok();
    await press();
    await act(async () => {
      app.bridge.emitPlcWriteProgress({ done: 1, total: 3, current: 'FC1' });
    });
    expect(screen.getByTestId('download-progress')).toHaveTextContent('1 di 3 (FC1)');
    await act(async () => release({ ok: true, loaded: ['FC1'], deleted: [] }));
    await screen.findByTestId('download-result');
  }, 30_000);

  it('scollegato durante la scrittura: nessuna scrittura nello stato, nessun confronto', async () => {
    const { app } = await setupOnline([['FC', 1]], 'STOP');
    let release!: (r: PlcDownloadResult) => void;
    app.bridge.plcDownload = () => new Promise((r) => (release = r));
    await runDownload(app);
    await ok();
    await press();
    await act(async () => {
      await commands['online.goOffline'].run({
        store: app.store,
        service: app.service,
        bridge: app.bridge,
      });
    });
    const n = st(app).messages.length;
    const calls = app.bridge.plcBlocksCalls;
    await act(async () => release({ ok: true, loaded: ['FC1'], deleted: [] }));
    await screen.findByTestId('download-result');
    expect(
      st(app)
        .messages.slice(n)
        .map((m) => m.textKey),
    ).not.toContain('messages.plcDownloaded');
    expect(app.bridge.questions).toHaveLength(0);
    expect(app.bridge.plcBlocksCalls).toBe(calls);
    expect(st(app).online.status).toBe('off');
  }, 30_000);

  it('uguali di default senza azione; spuntarli li carica', async () => {
    const { app, blocks } = await setupOnline([['FC', 1]]);
    app.bridge.plcBlocksResults = [{ ok: true, blocks: [cpuBlock(app, blocks[0]!, 'FC')] }];
    await runDownload(app);
    await ok();
    expect(screen.getByRole('checkbox', { name: 'FC1' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'FC1' }));
    await press();
    await waitFor(() => expect(app.bridge.plcDownloadCalls).toHaveLength(1));
    expect(names(app.bridge.plcDownloadCalls[0]!.files)).toContain('FC1');
  }, 30_000);

  it('senza PLC online né simulazione il comando è spento e non scrive', async () => {
    const { app } = await setupOnline([['FC', 1]]);
    expect(commands['online.download'].isEnabled(st(app))).toBe(true);
    await act(async () => {
      await commands['online.goOffline'].run({
        store: app.store,
        service: app.service,
        bridge: app.bridge,
      });
    });
    expect(commands['online.download'].isEnabled(st(app))).toBe(false);
    expect(app.bridge.plcDownloadCalls).toHaveLength(0);
  }, 30_000);
});
