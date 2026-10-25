import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createCodeBlock, findDevice, type CodeBlock } from '@baaportal/project';
import { commands } from '../../src/commands/commands';
import { compileProgram } from '../../src/project/compile/compileActions';
import { ids } from '../../src/project/navigation/treeIds';
import { runWithProgress } from '../../src/project/progress';
import type { PlcBlocksResult } from '../../src/online/plcTypes';
import { renderApp, type RenderedApp } from '../renderApp';

const PLC = 'id1';
const ACCESS = { host: '192.0.2.10', rack: 0, slot: 2, connectionType: 'PG' as const };
const OK = {
  ok: true as const,
  mode: 'RUN' as const,
  identity: { orderNumber: '6ES7 315-2EH14-0AB0', moduleName: 'CPU 315-2 PN/DP' },
};

function fc(n: number): CodeBlock {
  const b = createCodeBlock({ kind: 'FC', number: n, name: `FC${n}`, language: 'AWL' });
  b.networks[0]!.source = 'A %I0.0\n= %Q0.0';
  return b;
}

async function setup() {
  const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
  await act(async () => {
    await app.service.open('/doc/BaaPortal/Linea 3.baap');
  });
  findDevice(app.store.getState().doc!.project, PLC)!.properties.access = ACCESS;
  const a = fc(1);
  const b = fc(2);
  act(() => {
    app.store.getState().edit('history.addBlock', (p) => {
      findDevice(p, PLC)!.blocks.push(a, b);
    });
  });
  const ctx = { store: app.store, service: app.service, bridge: app.bridge };
  const run = (id: 'online.goOnline' | 'online.goOffline' | 'online.compare') =>
    act(async () => {
      await commands[id].run(ctx);
    });
  const compileAll = () =>
    act(async () => {
      await compileProgram({ store: app.store, bridge: app.bridge }, PLC, 'full');
    });
  app.store.getState().setInfoSubTab('general');
  app.bridge.plcResults.push(OK);
  return { app, a, b, run, compileAll };
}

const st = (app: RenderedApp) => app.store.getState();
const badge = (id: string) =>
  screen.getByTestId(`tree-node-${ids.block(PLC, id)}`).querySelector('[data-compare]');
const messages = (app: RenderedApp) => st(app).messages.map((m) => m.textKey);
/** Stato dei due blocchi aggiunti dal test (il progetto ha anche altri blocchi). */
const states = (app: RenderedApp, ...blockIds: string[]) =>
  blockIds.map((id) => st(app).online.compare?.rows.find((r) => r.blockId === id)?.state);

/** plcBlocks che si risolve a comando. */
function gateBlocks(app: RenderedApp) {
  let resolve!: (r: PlcBlocksResult) => void;
  app.bridge.plcBlocks = () => {
    app.bridge.plcBlocksCalls++;
    return new Promise((r) => (resolve = r));
  };
  return (r: PlcBlocksResult) => act(async () => resolve(r));
}

describe('PlcController.compare', () => {
  it('automatico, tutto compilato: non compila e non tocca la scheda Compila', async () => {
    const { app, a, b, run, compileAll } = await setup();
    await compileAll();
    st(app).setInfoSubTab('general');
    const summary = st(app).compile.summary;
    expect(summary).not.toBeNull();
    await run('online.goOnline');
    await waitFor(() => expect(st(app).online.compare).toBeDefined());
    expect(st(app).compile.summary).toBe(summary);
    expect(st(app).infoSubTab).toBe('general');
    expect(states(app, a.id, b.id)).toEqual(['offlineOnly', 'offlineOnly']);
  }, 30_000);

  it('automatico, blocchi da compilare: compila in silenzio, senza aprire né svuotare la scheda', async () => {
    const { app, a, b, run } = await setup();
    await run('online.goOnline');
    await waitFor(() => expect(st(app).online.compare).toBeDefined());
    expect(st(app).compile.files[a.id]).toBeDefined(); // ha compilato
    expect(st(app).infoSubTab).toBe('general');
    expect(st(app).compile.rows).toEqual([]);
    expect(st(app).compile.summary).toBeNull();
    expect(states(app, a.id, b.id)).toEqual(['offlineOnly', 'offlineOnly']);
    expect(badge(a.id)).toHaveAttribute('data-compare', 'offlineOnly');
  }, 30_000);

  it('il comando Confronta mostra la scheda Compila', async () => {
    const { app, run } = await setup();
    await run('online.goOnline');
    await waitFor(() => expect(st(app).online.compare).toBeDefined());
    await run('online.compare');
    expect(st(app).infoSubTab).toBe('compile');
    expect(st(app).compile.summary).not.toBeNull();
  }, 30_000);

  it('altra operazione in corso: messaggio, confronto con ciò che c è, blocchi da compilare', async () => {
    const { app, a, b, run } = await setup();
    let release!: () => void;
    const busy = runWithProgress(
      'status.compiling',
      1,
      () => new Promise<void>((r) => (release = r)),
    );
    await run('online.goOnline');
    await waitFor(() => expect(st(app).online.compare).toBeDefined());
    expect(messages(app)).toContain('messages.plcCompareSkipped');
    expect(states(app, a.id, b.id)).toEqual(['notCompiled', 'notCompiled']);
    expect(st(app).online.comparing).toBe(false);
    release();
    await busy;
  }, 30_000);

  it('errore dell elenco: plcCompareFailed, comparing azzerato, il comando resta usabile', async () => {
    const { app, run } = await setup();
    app.bridge.plcBlocksResults = [{ ok: false, error: 'nessuna risposta' }];
    await run('online.goOnline');
    await waitFor(() => expect(messages(app)).toContain('messages.plcCompareFailed'));
    await waitFor(() => expect(st(app).online.comparing).toBe(false));
    expect(st(app).online.compare).toBeUndefined();
    expect(commands['online.compare'].isEnabled(st(app))).toBe(true);
  }, 30_000);

  it('scollegato durante il confronto: la risposta tardiva si scarta', async () => {
    const { app, run } = await setup();
    const answer = gateBlocks(app);
    await run('online.goOnline');
    await waitFor(() => expect(app.bridge.plcBlocksCalls).toBe(1));
    await run('online.goOffline');
    await answer({
      ok: true,
      blocks: [{ type: 'FC', number: 9, loadLength: 1, mc7Length: 1, checksum: 1 }],
    });
    expect(st(app).online).toEqual({ status: 'off' });
    expect(messages(app)).not.toContain('messages.plcCompareFailed');
  }, 30_000);

  it('un solo confronto alla volta', async () => {
    const { app, run } = await setup();
    const answer = gateBlocks(app);
    await run('online.goOnline');
    await waitFor(() => expect(app.bridge.plcBlocksCalls).toBe(1));
    expect(commands['online.compare'].isEnabled(st(app))).toBe(false);
    await run('online.compare');
    expect(app.bridge.plcBlocksCalls).toBe(1);
    await answer({ ok: true, blocks: [] });
    await waitFor(() => expect(st(app).online.comparing).toBe(false));
    expect(st(app).online.compare).toBeDefined();
  }, 30_000);
});

describe('albero: illeggibile e «Solo online»', () => {
  const blocks: PlcBlocksResult = {
    ok: true,
    blocks: [
      { type: 'FC', number: 1, loadLength: 0, mc7Length: 0, checksum: 0, unreadable: true },
      { type: 'FC', number: 9, loadLength: 1, mc7Length: 1, checksum: 1 },
    ],
  };

  it('blocco illeggibile: icona con testo italiano', async () => {
    const { app, a, run } = await setup();
    app.bridge.plcBlocksResults = [blocks];
    await run('online.goOnline');
    await waitFor(() => expect(badge(a.id)).toHaveAttribute('data-compare', 'unreadable'));
    expect(badge(a.id)).toHaveAttribute('aria-label', expect.stringContaining('Illeggibile'));
  }, 30_000);

  it('il nodo solo online non si apre, rinomina, elimina, trascina e non ha menu', async () => {
    const { app, run } = await setup();
    app.bridge.plcBlocksResults = [blocks];
    await run('online.goOnline');
    const node = await screen.findByTestId(`tree-node-${ids.onlineBlock(PLC, 'FC9')}`);
    expect(node).not.toHaveAttribute('draggable', 'true');
    const before = JSON.stringify(st(app).doc!.project);
    fireEvent.click(node);
    fireEvent.contextMenu(node);
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.keyDown(node, { key: 'F2' });
    fireEvent.keyDown(node, { key: 'Delete' });
    fireEvent.doubleClick(node);
    expect(node.querySelector('input')).toBeNull();
    expect(JSON.stringify(st(app).doc!.project)).toBe(before);
    expect(screen.queryByRole('dialog')).toBeNull();
  }, 30_000);
});
