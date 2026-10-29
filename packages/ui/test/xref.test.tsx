import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createCodeBlock, findDevice, type CodeBlock } from '@baaportal/project';
import { commands } from '../src/commands/commands';
import { ids } from '../src/project/navigation/treeIds';
import { renderApp, type RenderedApp } from './renderApp';

const T = 30_000;
const PLC = 'id1';

/** OB1 chiama FC1 (AWL) e FC2 (KOP); FC3 non la usa nessuno. */
async function setup() {
  const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
  const fc1 = createCodeBlock({ kind: 'FC', number: 1, name: 'Uno', language: 'AWL' });
  fc1.networks[0]!.source = 'A I 0.0\n= Q 4.0';
  const fc2 = createCodeBlock({ kind: 'FC', number: 2, name: 'Due', language: 'KOP' });
  fc2.networks[0]!.lad = {
    root: {
      id: 'n',
      series: [{ id: 'ea', k: 'contact', neg: false, op: 'I 0.0' }],
      outs: [{ id: 'eq', k: 'coil', op: 'M 1.0' }],
    },
  };
  const fc3 = createCodeBlock({ kind: 'FC', number: 3, name: 'Tre', language: 'AWL' });
  act(() => {
    app.store.getState().edit('history.addBlock', (p) => {
      const d = findDevice(p, PLC)!;
      (d.blocks.find((b) => b.kind === 'OB') as CodeBlock).networks[0]!.source =
        'CALL FC 1\nCALL FC 2';
      d.blocks.push(fc1, fc2, fc3);
    });
  });
  return app;
}

const ctx = (app: RenderedApp) => ({ store: app.store, service: app.service, bridge: app.bridge });
const blockId = (app: RenderedApp, name: string) =>
  findDevice(app.store.getState().doc!.project, PLC)!.blocks.find((b) => b.name === name)!.id;
const activeKey = (app: RenderedApp) => {
  const wa = app.store.getState().workArea;
  return wa.panes[wa.focusedPane];
};
const rowsOf = () => screen.queryAllByTestId('xref-row').map((r) => r.getAttribute('data-operand'));

describe('Riferimenti incrociati', () => {
  it(
    'dal menu Strumenti: tutti gli operandi, il filtro e il clic che porta al punto d’uso',
    async () => {
      const app = await setup();
      await act(() => commands['tools.crossReferences'].run(ctx(app)));
      await screen.findByTestId('xref-view');
      expect(rowsOf()).toEqual(['%I0.0', '%I0.0', '%M1.0', '%Q4.0', 'FC1', 'FC2']);
      const filter = screen.getByTestId('xref-filter');
      await app.user.type(filter, 'Q 4.0');
      expect(rowsOf()).toEqual(['%Q4.0']);
      const row = screen.getByTestId('xref-row');
      expect(within(row).getByText('Scrittura')).toBeTruthy();
      await app.user.click(within(row).getByTestId('xref-goto'));
      expect(activeKey(app)).toBe(`block:${PLC}:${blockId(app, 'Uno')}`);
    },
    T,
  );

  it(
    'un punto d’uso in KOP seleziona l’elemento',
    async () => {
      const app = await setup();
      await act(() => commands['tools.crossReferences'].run(ctx(app)));
      await app.user.type(await screen.findByTestId('xref-filter'), 'M1.0');
      await app.user.click(screen.getByTestId('xref-goto'));
      await waitFor(() =>
        expect(
          screen
            .queryAllByRole('button', { pressed: true })
            .map((e) => e.getAttribute('data-lad-id'))
            .filter((x) => x !== null),
        ).toEqual(['eq']),
      );
    },
    T,
  );

  it(
    'dal menu dell’albero su un blocco: chi lo chiama e cosa usa',
    async () => {
      const app = await setup();
      await app.user.pointer({
        keys: '[MouseRight]',
        target: screen.getByTestId(`tree-node-${ids.block(PLC, blockId(app, 'Uno'))}`),
      });
      await app.user.click(screen.getByRole('menuitem', { name: 'Riferimenti incrociati' }));
      await screen.findByTestId('xref-view');
      expect((screen.getByTestId('xref-filter') as HTMLInputElement).value).toBe('FC1');
      expect(rowsOf()).toEqual(['%I0.0', '%Q4.0', 'FC1']);
    },
    T,
  );
});

describe('Struttura di richiamo', () => {
  it(
    'dagli OB in giù, i blocchi non usati, le dipendenze e il clic che apre il blocco',
    async () => {
      const app = await setup();
      await act(() => commands['tools.callStructure'].run(ctx(app)));
      const view = await screen.findByTestId('calls-view');
      await app.user.click(within(view).getByRole('button', { name: /Espandi Main/ }));
      const keys = () =>
        within(view)
          .getAllByTestId('calls-node')
          .map((n) => n.getAttribute('data-key'));
      expect(keys()).toEqual(['OB1', 'FC1', 'FC2', 'FC3']);
      expect(within(screen.getByTestId('calls-unreferenced')).getByText('Tre [FC3]')).toBeTruthy();
      await app.user.click(within(view).getByRole('button', { name: 'Due [FC2]' }));
      expect(activeKey(app)).toBe(`block:${PLC}:${blockId(app, 'Due')}`);

      app.store.getState().openEditor({ kind: 'callStructure', deviceId: PLC, objectId: '' });
      const again = await screen.findByTestId('calls-view');
      await app.user.click(within(again).getByRole('radio', { name: 'Dipendenze' }));
      await app.user.click(within(again).getByRole('button', { name: /Espandi Uno/ }));
      expect(
        within(again)
          .getAllByTestId('calls-node')
          .map((n) => n.getAttribute('data-key')),
      ).toEqual(['FC1', 'OB1', 'FC2', 'FC3', 'OB1']);
    },
    T,
  );
});
