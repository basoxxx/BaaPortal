import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createCodeBlock, findDevice, type CodeBlock } from '@baaportal/project';
import { commands } from '../src/commands/commands';
import { nodeIdOfEditor } from '../src/state/workArea';
import { renderApp, type RenderedApp } from './renderApp';

const T = 30_000;
const PLC = 'id1';

/** OB1 chiama FC1; FC1 ha una variabile TEMP; FC2 non compila. */
async function setup() {
  const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
  const fc1 = createCodeBlock({ kind: 'FC', number: 1, name: 'Uno', language: 'AWL' });
  fc1.interface.temp.push({ id: 'tt', name: 'a', type: 'DInt', comment: '' });
  fc1.networks[0]!.source = 'A I 0.0\n= Q 4.0';
  const bad = createCodeBlock({ kind: 'FC', number: 2, name: 'Rotto', language: 'AWL' });
  bad.networks[0]!.source = 'QUESTO NON COMPILA';
  act(() => {
    app.store.getState().edit('history.addBlock', (p) => {
      const d = findDevice(p, PLC)!;
      (d.blocks.find((b) => b.kind === 'OB') as CodeBlock).networks[0]!.source =
        'CALL FC 1\nS M 10.3\nL MW 10';
      d.blocks.push(fc1, bad);
    });
  });
  return app;
}
const ctx = (app: RenderedApp) => ({ store: app.store, service: app.service, bridge: app.bridge });

describe('Informazioni sul programma: assegnazione e risorse', () => {
  it(
    'elenco di assegnazione: celle per area e clic che apre i riferimenti incrociati',
    async () => {
      const app = await setup();
      await act(() => commands['tools.assignmentList'].run(ctx(app)));
      const view = await screen.findByTestId('assign-view');
      const cell = (a: string) =>
        within(view)
          .getAllByTestId('assign-cell')
          .find((c) => c.getAttribute('data-address') === a)!;
      expect(cell('I0.0').getAttribute('data-access')).toBe('read');
      await app.user.click(within(view).getByRole('radio', { name: /Merker/ }));
      expect(cell('M10.3').getAttribute('data-access')).toBe('readWrite');
      await app.user.click(cell('M10.3'));
      await screen.findByTestId('xref-view');
      await waitFor(() =>
        expect(
          screen.getAllByTestId('xref-row').map((r) => r.getAttribute('data-operand')),
        ).toEqual(['%M10.3', '%MW10']),
      );
    },
    T,
  );

  it(
    'risorse: dimensioni, blocco da compilare e percorso dei dati locali',
    async () => {
      const app = await setup();
      await act(() => commands['tools.resources'].run(ctx(app)));
      const view = await screen.findByTestId('resources-view');
      const row = (k: string) =>
        within(view)
          .getAllByTestId('resources-row')
          .find((r) => r.getAttribute('data-key') === k)!;
      expect(within(row('FC2')).getByText('da compilare')).toBeTruthy();
      expect(within(row('FC1')).queryByTestId('resources-uncompiled')).toBeNull();
      expect(within(view).getByTestId('resources-path').textContent).toContain('OB1 → FC1');
      expect(within(view).getAllByTestId('resources-area')).toHaveLength(5);
    },
    T,
  );

  it(
    'cartella Informazioni sul programma: ogni voce apre la sua vista e torna selezionata',
    async () => {
      const app = await setup();
      const views = [
        ['prog-xref', 'xref-view', 'crossRef'],
        ['prog-calls', 'calls-view', 'callStructure'],
        ['prog-assignment', 'assign-view', 'assignment'],
        ['prog-resources', 'resources-view', 'resources'],
      ] as const;
      // la cartella si chiude e si riapre come le altre, senza aprire viste
      const folder = screen.getByTestId(`tree-node-plc:${PLC}:prog-info`);
      await app.user.dblClick(folder);
      expect(folder).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByTestId('calls-view')).toBeNull();
      await app.user.dblClick(folder);
      expect(folder).toHaveAttribute('aria-expanded', 'true');
      for (const [node, view] of views) {
        await app.user.dblClick(await screen.findByTestId(`tree-node-plc:${PLC}:${node}`));
        await screen.findByTestId(view);
      }
      // la scheda attiva riporta alla sua voce nell'albero
      const wa = app.store.getState().workArea;
      for (const [node, , kind] of views) {
        const e = wa.editors.find((x) => x.kind === kind)!;
        expect(nodeIdOfEditor(e)).toBe(`plc:${PLC}:${node}`);
      }
    },
    T,
  );
});
