import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { findDevice } from '@baaportal/project';
import { nodeIdOfEditor } from '../../src/state/workArea';
import { renderApp, type RenderedApp } from '../renderApp';

const T = 30_000;
const PLC = 'id1';
const DI16 = '6ES7 321-1BH02-0AA0';
const PS5 = '6ES7 307-1EA01-0AA0';
const AI8 = '6ES7 331-7KF02-0AB0';

async function open() {
  const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
  await app.user.dblClick(screen.getByTestId(`tree-node-plc:${PLC}:device-config`));
  const view = await screen.findByTestId('device-view');
  return { app, view };
}
const modules = (app: RenderedApp) =>
  findDevice(app.store.getState().doc!.project, PLC)!.hardware?.modules ?? [];
const slot = (view: HTMLElement, n: number) =>
  within(view)
    .getAllByTestId('hw-slot')
    .find((s) => s.getAttribute('data-slot') === String(n))!;
const item = (view: HTMLElement, order: string) =>
  within(view)
    .getAllByTestId('hw-catalog-item')
    .find((s) => s.getAttribute('data-order') === order)!;
const drop = (el: HTMLElement, type: string, value: string) =>
  fireEvent.drop(el, { dataTransfer: { getData: (k: string) => (k === type ? value : '') } });

describe('Vista dispositivi', () => {
  it(
    'si apre dal nodo Configurazione dispositivi, CPU nel posto 2 e caricamento HW disattivato',
    async () => {
      const { app, view } = await open();
      expect(within(view).getAllByTestId('hw-slot')).toHaveLength(11);
      expect(slot(view, 2)).toHaveAccessibleName(/Posto 2: CPU 315-2 PN\/DP/);
      const dl = within(view).getByTestId('hw-download');
      expect(dl).toBeDisabled();
      expect(dl).toHaveAccessibleDescription(/SDB/);
      const e = app.store.getState().workArea.editors.find((x) => x.kind === 'deviceView')!;
      expect(nodeIdOfEditor(e)).toBe(`plc:${PLC}:device-config`);
    },
    T,
  );

  it(
    'inserimento con doppio clic e trascinamento, panoramica, annulla e ripristina',
    async () => {
      const { app, view } = await open();
      await app.user.dblClick(item(view, PS5));
      await app.user.dblClick(item(view, DI16));
      expect(modules(app).map((m) => [m.slot, m.orderNumber])).toEqual([
        [1, PS5],
        [4, DI16],
      ]);
      act(() => void drop(slot(view, 6), 'application/x-baa-hw-order', AI8));
      const rows = within(view).getAllByTestId('hw-overview-row');
      expect(rows.map((r) => r.getAttribute('data-slot'))).toEqual(['0.1', '0.4', '0.6']);
      expect(rows[2]).toHaveTextContent('288…303');
      // un PS nel rack pieno: avviso, nessuna modifica
      await app.user.dblClick(item(view, PS5));
      expect(within(view).getByTestId('hw-notice')).toHaveTextContent('Nessun posto libero');
      expect(modules(app)).toHaveLength(3);
      act(() => app.store.getState().undo());
      expect(modules(app)).toHaveLength(2);
      act(() => app.store.getState().redo());
      expect(modules(app)).toHaveLength(3);
    },
    T,
  );

  it(
    'ricerca e famiglia filtrano il catalogo',
    async () => {
      const { app, view } = await open();
      await app.user.type(within(view).getByRole('searchbox'), '343-1');
      expect(within(view).getAllByTestId('hw-catalog-item')).toHaveLength(2);
      await app.user.clear(within(view).getByRole('searchbox'));
      await app.user.selectOptions(within(view).getByRole('combobox'), 'SM 322');
      expect(
        within(view)
          .getAllByTestId('hw-catalog-item')
          .every((i) => i.getAttribute('data-order')!.startsWith('6ES7 322')),
      ).toBe(true);
    },
    T,
  );

  it(
    'spostamento, proprietà, sovrapposizione e cancellazione',
    async () => {
      const { app, view } = await open();
      await app.user.dblClick(item(view, DI16));
      await app.user.dblClick(item(view, DI16));
      // trascinamento del secondo DI dal posto 5 al posto 8: l'indirizzo fisso segue il posto
      const second = modules(app)[1]!;
      act(() => void drop(slot(view, 8), 'application/x-baa-hw-module', second.id));
      expect(modules(app)[1]).toMatchObject({ slot: 8, inputStart: 16 });
      // Ctrl+freccia sposta il modulo selezionato
      await app.user.click(slot(view, 8));
      slot(view, 8).focus();
      await app.user.keyboard('{Control>}{ArrowRight}{/Control}');
      expect(modules(app)[1]).toMatchObject({ slot: 9, inputStart: 20 });

      await app.user.click(slot(view, 9));
      const props = within(view).getByTestId('hw-props');
      const start = within(props).getByLabelText('Indirizzo iniziale degli ingressi');
      await app.user.clear(start);
      await app.user.type(start, '1{Enter}');
      expect(modules(app)[1]!.inputStart).toBe(1);
      await waitFor(() =>
        expect(within(props).getByTestId('hw-issues')).toHaveTextContent('si sovrappongono'),
      );
      expect(slot(view, 9)).toHaveAttribute('aria-invalid', 'true');
      const name = within(props).getByLabelText('Nome');
      await app.user.clear(name);
      await app.user.type(name, 'Finecorsa{Enter}');
      expect(modules(app)[1]!.name).toBe('Finecorsa');

      await app.user.click(within(props).getByTestId('hw-delete'));
      expect(modules(app)).toHaveLength(1);
      await app.user.click(slot(view, 4));
      slot(view, 4).focus();
      await app.user.keyboard('{Delete}');
      expect(modules(app)).toHaveLength(0);
    },
    T,
  );
});
