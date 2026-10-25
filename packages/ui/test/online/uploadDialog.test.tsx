import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { findCpu } from '@baaportal/catalog';
import { compileDevice, createPlcDevice } from '@baaportal/project';
import { commands } from '../../src/commands/commands';
import type { PlcUploadedFile } from '../../src/online/plcTypes';
import { renderApp } from '../renderApp';

const IFACE = { name: 'en0', address: '192.0.2.5', netmask: '255.255.255.0' };
const ORDER = '6ES7 315-2EH14-0AB0';

function files(): PlcUploadedFile[] {
  const dev = createPlcDevice({
    cpu: findCpu('cpu-315-2-pn-dp')!,
    orderNumber: ORDER,
    firmware: 'V3.3',
    name: 'PLC_1',
    texts: { defaultTagTable: 'T' },
  });
  dev.blocks[0]!.networks[0]!.source = 'A %I0.0\n= %Q0.0';
  return compileDevice(dev, findCpu(dev.cpu.typeId)).results.map((r) => ({
    type: 'OB',
    number: 1,
    bytes: r.file!,
  }));
}

async function open(opts: { withProject: boolean }) {
  const app = await renderApp({
    view: opts.withProject ? 'project' : 'portal',
    withProject: opts.withProject,
    withPlc: opts.withProject,
  });
  app.bridge.plcInterfacesValue = [IFACE];
  await act(async () => {
    await commands['online.upload'].run({
      store: app.store,
      service: app.service,
      bridge: app.bridge,
    });
  });
  const dlg = await screen.findByRole('dialog', { name: 'Dispositivi accessibili' });
  await within(dlg).findByRole('option', { name: /en0/ });
  return { ...app, dlg };
}

describe('Carica dal dispositivo', () => {
  it('il comando è attivo anche senza progetto e apre la finestra', async () => {
    const { store, dlg } = await open({ withProject: false });
    expect(commands['online.upload'].isEnabled(store.getState())).toBe(true);
    expect(dlg).toBeTruthy();
  });

  it('il comando è spento durante un comando della CPU o un caricamento nella CPU', async () => {
    const { store } = await renderApp({ view: 'portal' });
    act(() => store.getState().patchOnline({ commanding: true }));
    expect(commands['online.upload'].isEnabled(store.getState())).toBe(false);
  });

  it('il pulsante crea un progetto nuovo dalla CPU scelta, senza progetto aperto', async () => {
    const { user, bridge, store, dlg } = await open({ withProject: false });
    const upload = within(dlg).getByRole('button', { name: 'Carica dal dispositivo' });
    expect(upload).toBeDisabled();
    await user.type(within(dlg).getByLabelText('Indirizzo manuale'), '192.0.2.10');
    await user.click(within(dlg).getByRole('button', { name: 'Aggiungi indirizzo' }));
    bridge.plcUploadResults = [
      { ok: true, files: files(), identity: { orderNumber: ORDER }, failed: [] },
    ];
    expect(upload).toBeEnabled();
    await user.click(upload);
    await waitFor(() => expect(store.getState().doc).not.toBeNull());
    expect(bridge.plcUploadCalls[0]).toMatchObject({ host: '192.0.2.10', rack: 0, slot: 2 });
    expect(store.getState().doc?.dirty).toBe(true);
    expect(screen.queryByRole('dialog', { name: 'Dispositivi accessibili' })).toBeNull();
  });

  it('chiudere la finestra durante il caricamento lo interrompe', async () => {
    const { user, bridge, dlg } = await open({ withProject: false });
    await user.type(within(dlg).getByLabelText('Indirizzo manuale'), '192.0.2.10');
    await user.click(within(dlg).getByRole('button', { name: 'Aggiungi indirizzo' }));
    let release!: () => void;
    bridge.plcUploadGate = new Promise<void>((r) => (release = r));
    bridge.plcUploadResults = [{ ok: false, cancelled: true }];
    await user.click(within(dlg).getByRole('button', { name: 'Carica dal dispositivo' }));
    await waitFor(() => expect(bridge.plcUploadCalls).toHaveLength(1));
    await user.click(within(dlg).getByTestId('dialog-cancel'));
    expect(bridge.plcUploadCancelCalls).toBe(1);
    release();
  });
});
