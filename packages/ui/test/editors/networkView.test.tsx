import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { deviceNodes, findDevice } from '@baaportal/project';
import { nodeIdOfEditor } from '../../src/state/workArea';
import { renderApp, type RenderedApp } from '../renderApp';

const T = 30_000;
const PLC = 'id1';
const DI2 = '6ES7 131-4BB01-0AA0';

async function open() {
  const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
  await app.user.dblClick(screen.getByTestId('tree-node-devices-networks'));
  const view = await screen.findByTestId('network-view');
  return { app, view };
}
const project = (app: RenderedApp) => app.store.getState().doc!.project;
const nodes = (app: RenderedApp) => deviceNodes(findDevice(project(app), PLC)!);
const port = (view: HTMLElement, key: string) =>
  within(view)
    .getAllByTestId('net-port')
    .find((p) => p.getAttribute('data-node') === key)!;
const drop = (el: HTMLElement, value: string) =>
  fireEvent.drop(el, {
    dataTransfer: { getData: (k: string) => (k === 'application/x-baa-net-node' ? value : '') },
  });

describe('Vista di rete', () => {
  it(
    'si apre da «Dispositivi e reti»: CPU con le sue interfacce e panoramica',
    async () => {
      const { app, view } = await open();
      const e = app.store.getState().workArea.editors.find((x) => x.kind === 'networkView')!;
      expect(nodeIdOfEditor(e)).toBe('devices-networks');
      expect(
        within(view)
          .getAllByTestId('net-port')
          .map((p) => p.textContent),
      ).toEqual(['X1 MPI/DP · non collegata', 'X2 PN · non collegata']);
      expect(within(view).getAllByTestId('net-overview-row')).toHaveLength(2);
      expect(within(view).getByTestId('net-overview')).toHaveTextContent(
        "L'interfaccia non è collegata",
      );
      expect(within(view).getByRole('note')).toHaveTextContent('SDB');
    },
    T,
  );

  it(
    'sottoreti nuove, collegamento per trascinamento e dalle proprietà, annulla',
    async () => {
      const { app, view } = await open();
      await app.user.click(within(view).getByTestId('net-add-MPI'));
      await app.user.click(within(view).getByTestId('net-add-ETHERNET'));
      const subnets = project(app).subnets!;
      expect(subnets.map((s) => s.name)).toEqual(['MPI_1', 'Ethernet_1']);
      const bars = within(view).getAllByTestId('net-subnet');
      act(() => void drop(bars[0]!, `${PLC}/X1`));
      expect(nodes(app)[0]).toMatchObject({ subnetId: subnets[0]!.id, address: 2 });
      // PN su MPI: avviso e nessuna modifica
      act(() => void drop(bars[0]!, `${PLC}/X2`));
      expect(within(view).getByTestId('net-notice')).toHaveTextContent('non si può collegare');
      expect(nodes(app)[1]!.subnetId).toBeUndefined();

      // Dalle proprietà: scelta della sottorete e indirizzo IP
      await app.user.click(port(view, `${PLC}/X2`));
      const props = within(view).getByTestId('net-props');
      await app.user.selectOptions(within(props).getByLabelText('Sottorete'), 'Ethernet_1');
      expect(nodes(app)[1]).toMatchObject({ ip: '192.168.0.1' });
      const ip = within(props).getByLabelText('Indirizzo IP');
      await app.user.clear(ip);
      await app.user.type(ip, '192.168.0.300{Enter}');
      await waitFor(() =>
        expect(within(props).getByTestId('net-issues')).toHaveTextContent('IP non valido'),
      );
      expect(port(view, `${PLC}/X2`)).toHaveAttribute('aria-invalid', 'true');

      // Canc sull'interfaccia la scollega; annulla la ricollega
      port(view, `${PLC}/X1`).focus();
      await app.user.keyboard('{Delete}');
      expect(nodes(app)[0]!.subnetId).toBeUndefined();
      act(() => app.store.getState().undo());
      expect(nodes(app)[0]!.subnetId).toBe(subnets[0]!.id);
    },
    T,
  );

  it(
    'proprietà della sottorete ed eliminazione',
    async () => {
      const { app, view } = await open();
      await app.user.click(within(view).getByTestId('net-add-PROFIBUS'));
      const props = within(view).getByTestId('net-props');
      expect(within(props).getByLabelText('Velocità di trasmissione')).toHaveValue('1.5M');
      await app.user.selectOptions(within(props).getByLabelText('Velocità di trasmissione'), '12M');
      expect(project(app).subnets![0]!.rate).toBe('12M');
      act(() => void drop(within(view).getByTestId('net-subnet'), `${PLC}/X1`));
      await app.user.click(within(props).getByTestId('net-delete-subnet'));
      expect(project(app).subnets).toEqual([]);
      expect(nodes(app)[0]!.subnetId).toBeUndefined();
    },
    T,
  );

  it(
    'stazione ET 200 sulla rete del master, vista dispositivi con doppio clic, I/O nella CPU',
    async () => {
      const { app, view } = await open();
      await app.user.click(within(view).getByTestId('net-add-PROFIBUS'));
      act(() => void drop(within(view).getByTestId('net-subnet'), `${PLC}/X1`));
      await app.user.click(within(view).getByTestId('net-add-station')); // IM151-1, DP
      const st = nodes(app).find((n) => n.station)!;
      expect(st).toMatchObject({ label: 'ET200S_1', kind: 'DP', address: 3 });
      expect(within(view).getAllByTestId('net-box')).toHaveLength(2);

      await app.user.dblClick(within(view).getAllByTestId('net-box')[1]!);
      const sv = await screen.findByTestId('station-view');
      expect(within(sv).getAllByTestId('hw-slot')).toHaveLength(63);
      const items = within(sv).getAllByTestId('hw-catalog-item');
      expect(items).toHaveLength(4);
      await app.user.dblClick(items.find((i) => i.getAttribute('data-order') === DI2)!);
      const mods = findDevice(project(app), PLC)!.hardware!.stations![0]!.modules;
      expect(mods).toMatchObject([{ slot: 1, inputStart: 0 }]);
      const tab = app.store.getState().workArea.editors.find((x) => x.objectId === st.port)!;
      expect(tab.kind).toBe('deviceView');
    },
    T,
  );
});
