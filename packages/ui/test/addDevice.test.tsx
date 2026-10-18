import { act, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from './renderApp';

const openViaMenu = async (user: Awaited<ReturnType<typeof renderApp>>['user']) => {
  await user.click(screen.getByRole('menuitem', { name: 'Inserisci' }));
  await user.click(screen.getByRole('menuitem', { name: 'Nuovo dispositivo…' }));
  return screen.getByRole('dialog', { name: 'Aggiungi nuovo dispositivo' });
};

describe('Aggiungi nuovo dispositivo', () => {
  it('scelta CPU, firmware e nome; OK aggiunge un PLC con un solo passo di annulla', async () => {
    const { user, store } = await renderApp({ view: 'project', withProject: true });
    const dlg = await openViaMenu(user);
    expect(dlg).toHaveAttribute('aria-modal', 'true');
    expect(within(dlg).getByLabelText('Nome del dispositivo')).toHaveValue('PLC_1');

    await user.click(within(dlg).getByTestId('catalog-order:cpu-319-3-pn-dp:6ES7 318-3EL01-0AB0'));
    expect(within(dlg).getByText(/Memoria di lavoro: 2048 KB/)).toBeInTheDocument();
    const fw = within(dlg).getByLabelText('Versione firmware') as HTMLSelectElement;
    const options = [...fw.options].map((o) => o.value);
    expect(options.length).toBeGreaterThan(0);
    await user.selectOptions(fw, options[options.length - 1]!);
    const name = within(dlg).getByLabelText('Nome del dispositivo');
    await user.clear(name);
    await user.type(name, 'Pressa');
    await user.click(within(dlg).getByTestId('dialog-ok'));

    const { devices } = store.getState().doc!.project;
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      name: 'Pressa',
      cpu: {
        typeId: 'cpu-319-3-pn-dp',
        orderNumber: '6ES7 318-3EL01-0AB0',
        firmware: options[options.length - 1],
      },
    });
    expect(store.getState().history.past).toHaveLength(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(store.getState().selection).toBe(`plc:${devices[0]!.id}`);
    expect(screen.getByTestId(`tree-node-plc:${devices[0]!.id}`)).toHaveAttribute(
      'aria-selected',
      'true',
    );
    act(() => store.getState().undo());
    expect(store.getState().doc!.project.devices).toEqual([]);
  });

  it('il nome predefinito evita i nomi in uso e un nome doppio disattiva OK', async () => {
    const { user, store } = await renderApp({ view: 'project', withProject: true, withPlc: true });
    const dlg = await openViaMenu(user);
    const name = within(dlg).getByLabelText('Nome del dispositivo');
    expect(name).toHaveValue('PLC_2');
    await user.clear(name);
    await user.type(name, 'plc_1');
    expect(within(dlg).getByRole('alert')).toHaveTextContent('Esiste già un dispositivo');
    expect(within(dlg).getByTestId('dialog-ok')).toBeDisabled();
    await user.keyboard('{Enter}');
    expect(store.getState().doc!.project.devices).toHaveLength(1);
    await user.clear(name);
    expect(within(dlg).getByRole('alert')).toHaveTextContent('Inserisci un nome');
  });

  it('Esc e Annulla chiudono senza modificare; Invio conferma', async () => {
    const { user, store } = await renderApp({ view: 'project', withProject: true });
    await openViaMenu(user);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const dlg = await openViaMenu(user);
    await user.click(within(dlg).getByTestId('dialog-cancel'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(store.getState().doc!.project.devices).toEqual([]);
    expect(store.getState().history.past).toHaveLength(0);
    await openViaMenu(user);
    await user.keyboard('{Enter}');
    expect(store.getState().doc!.project.devices).toHaveLength(1);
  });

  it('il catalogo si scorre con le frecce e porta il focus', async () => {
    const { user } = await renderApp({ view: 'project', withProject: true });
    const dlg = await openViaMenu(user);
    const tree = within(dlg).getByRole('tree', { name: 'Catalogo dei dispositivi' });
    const selected = () => within(tree).getByRole('treeitem', { selected: true });
    expect(selected()).toHaveTextContent('CPU 315-2 PN/DP');
    expect(selected()).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(selected()).toHaveTextContent('6ES7 315-2EH14-0AB0');
    expect(selected()).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(selected()).toHaveTextContent('CPU 315-2 PN/DP');
    await user.keyboard('{ArrowUp}');
    // Le intestazioni non si scelgono: si torna all'ultimo numero di articolo della CPU precedente.
    expect(selected()).toHaveTextContent('6ES7 315-2AG10-0AB0');
  });

  it('dal portale: Aggiungi nuovo dispositivo apre il dialogo e dopo OK si passa alla vista progetto', async () => {
    const { user, store } = await renderApp({ withProject: true });
    await user.click(screen.getByTestId('portal-devices'));
    await user.click(screen.getByRole('button', { name: 'Aggiungi nuovo dispositivo' }));
    const dlg = screen.getByRole('dialog', { name: 'Aggiungi nuovo dispositivo' });
    await user.click(within(dlg).getByTestId('dialog-ok'));
    expect(store.getState().view).toBe('project');
    expect(await screen.findByTestId('menu-bar')).toBeInTheDocument();
    const id = store.getState().doc!.project.devices[0]!.id;
    expect(screen.getByTestId(`tree-node-plc:${id}`)).toHaveAttribute('aria-selected', 'true');
  });

  it('doppio clic e Invio su "Aggiungi nuovo dispositivo" nell\'albero aprono il dialogo', async () => {
    const { user } = await renderApp({ view: 'project', withProject: true });
    await user.dblClick(screen.getByTestId('tree-node-add-device'));
    expect(screen.getByRole('dialog', { name: 'Aggiungi nuovo dispositivo' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.getByTestId('tree-node-add-device')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog', { name: 'Aggiungi nuovo dispositivo' })).toBeInTheDocument();
  });
});
