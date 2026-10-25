import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { findDevice, type CodeBlock } from '@baaportal/project';
import { commands } from '../../src/commands/commands';
import { ids } from '../../src/project/navigation/treeIds';
import { PLC, cpuBlock, ctx, runDownload, setupOnline } from './downloadHelpers';

// Gancio sul compilatore di ogni blocco: il test vi inserisce un'eccezione a metà compilazione.
const hook = vi.hoisted(() => ({ onBlock: (n: number): void => void n, n: 0 }));
vi.mock('@baaportal/project', async (importOriginal) => {
  const real = await importOriginal<typeof import('@baaportal/project')>();
  return {
    ...real,
    blockToMc7File: (...a: Parameters<typeof real.blockToMc7File>) => {
      hook.onBlock(++hook.n);
      return real.blockToMc7File(...a);
    },
  };
});

const preview = () => screen.findByTestId('download-preview');
const row = (key: string) => screen.getByRole('checkbox', { name: key }).closest('tr')!;

async function open(kinds: Parameters<typeof setupOnline>[0], mode: 'RUN' | 'STOP' = 'RUN') {
  const s = await setupOnline(kinds, mode);
  return s;
}

describe('anteprima «Carica nel dispositivo»', () => {
  it('anteprima: nuovo, diverso, uguale, solo CPU con Cancella spenta', async () => {
    const { app, blocks } = await open([
      ['FC', 1],
      ['FC', 2],
      ['FC', 3],
    ]);
    const [same, diff] = blocks;
    app.bridge.plcBlocksResults = [
      {
        ok: true,
        blocks: [
          cpuBlock(app, same!, 'FC'),
          cpuBlock(app, diff!, 'FC', 1),
          { type: 'FC', number: 9, loadLength: 80, mc7Length: 8, checksum: 5 },
        ],
      },
    ];
    await runDownload(app);
    await preview();
    expect(within(row('FC1')).getByText('Nessuna azione')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'FC1' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'FC2' })).toBeChecked();
    expect(within(row('FC2')).getByText('Carica')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'FC3' })).toBeChecked();
    expect(row('FC3').getAttribute('data-state')).toBe('offlineOnly');
    expect(screen.getByRole('checkbox', { name: 'FC9' })).not.toBeChecked();
    expect(row('FC9').getAttribute('data-state')).toBe('onlineOnly');
    expect(within(row('FC9')).getByText('Nessuna azione')).toBeInTheDocument();
    expect(app.bridge.plcDownloadCalls).toHaveLength(0);
  }, 30_000);

  it('RUN con un OB → avviso e Arresta spento', async () => {
    const { app } = await open([
      ['OB', 35],
      ['FC', 1],
    ]);
    await runDownload(app);
    await preview();
    expect(screen.getByTestId('download-run-warning')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Arresta la CPU' })).not.toBeChecked();
    // senza l'OB (azione tolta) l'avviso sparisce
    for (const ob of screen.getAllByRole('checkbox', { name: /^OB/ })) fireEvent.click(ob);
    expect(screen.queryByTestId('download-run-warning')).toBeNull();
  }, 30_000);

  it('CPU in STOP: nessun avviso anche con un OB', async () => {
    const { app } = await open([['OB', 35]], 'STOP');
    await runDownload(app);
    await preview();
    expect(screen.queryByTestId('download-run-warning')).toBeNull();
  }, 30_000);

  it("Annulla nell'anteprima → nessuna chiamata al bridge", async () => {
    const { app } = await open([['FC', 1]]);
    await runDownload(app);
    await preview();
    fireEvent.click(screen.getByTestId('download-cancel'));
    expect(screen.queryByTestId('download-preview')).toBeNull();
    expect(app.bridge.plcDownloadCalls).toHaveLength(0);
    expect(app.bridge.plcControlCalls).toHaveLength(0);
    expect(app.store.getState().online.downloading).toBe(false);
    expect(commands['online.download'].isEnabled(app.store.getState())).toBe(true);
  }, 30_000);

  it('blocchi selezionati nell’albero → solo quelli', async () => {
    const { app, blocks } = await open([
      ['FC', 1],
      ['FC', 2],
    ]);
    app.bridge.plcBlocksResults = [
      { ok: true, blocks: [{ type: 'FC', number: 9, loadLength: 80, mc7Length: 8, checksum: 5 }] },
    ];
    const { preparePlcDownload } = await import('../../src/online/plcDownload');
    await act(async () => {
      await preparePlcDownload(ctx(app), [blocks[1]!.id]);
    });
    await preview();
    expect(screen.queryByRole('checkbox', { name: 'FC1' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'FC2' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'FC9' })).toBeNull();
  }, 30_000);

  it('blocco non attuale → stop prima dell’anteprima', async () => {
    const { app, blocks } = await open([
      ['FC', 1],
      ['FC', 2],
    ]);
    // Cambiano entrambi; il compilatore guasta al secondo: resta un blocco con l'impronta vecchia.
    act(() => {
      app.store.getState().edit('history.editBlock', (p) => {
        for (const b of findDevice(p, PLC)!.blocks)
          (b as CodeBlock).networks[0]!.source = 'A %I0.1\n= %Q0.1';
      });
    });
    void blocks;
    hook.n = 0;
    hook.onBlock = (n) => {
      if (n === 2) throw new Error('compilatore guasto');
    };
    await runDownload(app);
    expect(screen.queryByTestId('download-preview')).toBeNull();
    expect(app.store.getState().messages.at(-1)!.textKey).toBe('messages.simDownloadStale');
    expect(app.bridge.plcDownloadCalls).toHaveLength(0);
    expect(app.store.getState().online.downloading).toBe(false);
  }, 30_000);

  it('menu del blocco: «Carica nel dispositivo» apre l’anteprima con quel solo blocco', async () => {
    const { app, blocks } = await open([
      ['FC', 1],
      ['FC', 2],
    ]);
    app.store.getState().setInfoSubTab('general');
    const node = await screen.findByTestId(`tree-node-${ids.block(PLC, blocks[1]!.id)}`);
    fireEvent.contextMenu(node);
    await act(async () => {
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Carica nel dispositivo' }));
    });
    await preview();
    expect(screen.getByRole('checkbox', { name: 'FC2' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'FC1' })).toBeNull();
  }, 30_000);
});
