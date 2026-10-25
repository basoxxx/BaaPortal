import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createCodeBlock, findDevice, type CodeBlock } from '@baaportal/project';
import { parseBlockFile } from '@baaportal/s7comm';
import { commands } from '../../src/commands/commands';
import { ids } from '../../src/project/navigation/treeIds';
import { renderApp, type RenderedApp } from '../renderApp';

const PLC = 'id1';
const ACCESS = { host: '192.0.2.10', rack: 0, slot: 2, connectionType: 'PG' as const };

function fc(n: number): CodeBlock {
  const b = createCodeBlock({ kind: 'FC', number: n, name: `FC${n}`, language: 'AWL' });
  b.networks[0]!.source = 'A %I0.0\n= %Q0.0';
  return b;
}

const badgeOf = (app: RenderedApp, id: string) =>
  screen.getByTestId(`tree-node-${ids.block(PLC, id)}`).querySelector('[data-compare]');

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
  return { app, a, b, run };
}

describe('confronto nell albero', () => {
  it('le icone compaiono online e spariscono offline; modifica dopo il confronto: da compilare', async () => {
    const { app, a, b, run } = await setup();
    // Prima compilazione: serve per sapere checksum e lunghezza di FC1.
    await act(async () => {
      const { compileProgram } = await import('../../src/project/compile/compileActions');
      await compileProgram({ store: app.store, bridge: app.bridge }, PLC, 'full');
    });
    const f1 = app.store.getState().compile.files[a.id]!;
    const p1 = parseBlockFile(f1);
    app.bridge.plcBlocksResults = [
      {
        ok: true,
        blocks: [
          // FC1 uguale, FC2 diverso, FC9 solo nella CPU, SFC20 escluso
          {
            type: 'FC',
            number: 1,
            loadLength: f1.length,
            mc7Length: p1.header.mc7Length,
            checksum: p1.footer!.checksum,
          },
          { type: 'FC', number: 2, loadLength: 1, mc7Length: 1, checksum: 1 },
          { type: 'FC', number: 9, loadLength: 1, mc7Length: 1, checksum: 1 },
          { type: 'SFC', number: 20, loadLength: 1, mc7Length: 1, checksum: 1 },
        ],
      },
    ];
    app.bridge.plcResults.push({
      ok: true,
      mode: 'RUN',
      identity: { orderNumber: '6ES7 315-2EH14-0AB0', moduleName: 'CPU 315-2 PN/DP' },
    });
    expect(badgeOf(app, a.id)).toBeNull();
    await run('online.goOnline');
    await waitFor(() => expect(badgeOf(app, a.id)).not.toBeNull());
    expect(badgeOf(app, a.id)).toHaveAttribute('data-compare', 'same');
    expect(badgeOf(app, b.id)).toHaveAttribute('data-compare', 'different');
    expect(badgeOf(app, a.id)).toHaveAttribute('aria-label', 'Uguale alla CPU');
    expect(screen.getByTestId(`tree-node-${ids.folder(PLC, 'online-only')}`)).toHaveTextContent(
      'Solo online',
    );
    expect(screen.getByTestId(`tree-node-${ids.onlineBlock(PLC, 'FC9')}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`tree-node-${ids.onlineBlock(PLC, 'SFC20')}`)).toBeNull();

    // Modifica dopo il confronto: da compilare finché non si ricompila.
    act(() => {
      app.store.getState().edit('history.addBlock', (p) => {
        (findDevice(p, PLC)!.blocks.find((x) => x.id === a.id) as CodeBlock).networks[0]!.source =
          'A %I0.1\n= %Q0.0';
      });
    });
    expect(badgeOf(app, a.id)).toHaveAttribute('data-compare', 'notCompiled');
    expect(badgeOf(app, b.id)).toHaveAttribute('data-compare', 'different');

    await run('online.goOffline');
    expect(badgeOf(app, a.id)).toBeNull();
    expect(app.store.getState().online.compare).toBeUndefined();
    expect(screen.queryByTestId(`tree-node-${ids.folder(PLC, 'online-only')}`)).toBeNull();
  }, 30_000);

  it('senza blocchi solo nella CPU la sottocartella non c è; errore: messaggio e nessuna icona', async () => {
    const { app, a, run } = await setup();
    app.bridge.plcBlocksResults = [{ ok: false, error: 'nessuna risposta' }];
    app.bridge.plcResults.push({
      ok: true,
      mode: 'RUN',
      identity: { orderNumber: '6ES7 315-2EH14-0AB0', moduleName: 'CPU 315-2 PN/DP' },
    });
    await run('online.goOnline');
    await waitFor(() =>
      expect(app.store.getState().messages.map((m) => m.textKey)).toContain(
        'messages.plcCompareFailed',
      ),
    );
    expect(badgeOf(app, a.id)).toBeNull();
    expect(screen.queryByTestId(`tree-node-${ids.folder(PLC, 'online-only')}`)).toBeNull();
    expect(commands['online.compare'].isEnabled(app.store.getState())).toBe(true);
  }, 30_000);
});
