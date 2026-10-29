import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { findDevice } from '@baaportal/project';
import { commands } from '../../src/commands/commands';
import { PlcController } from '../../src/online/plcController';
import { parseAccessInput, parseTsap } from '../../src/online/accessInput';
import { renderApp } from '../renderApp';

describe('parseAccessInput', () => {
  it('accetta un IPv4, con o senza porta', () => {
    expect(parseAccessInput('192.0.2.10')).toEqual({ host: '192.0.2.10' });
    expect(parseAccessInput(' 127.0.0.1:10102 ')).toEqual({ host: '127.0.0.1', port: 10102 });
  });
  it('rifiuta ottetti oltre 255, spazi interni, nomi host, porte e formati strani', () => {
    for (const bad of [
      '192.0.2.300',
      '192.0.2. 10',
      '192.0.2.10 :102',
      'plc-1.officina.local',
      '192.0.2',
      '192.0.2.10:0',
      '192.0.2.10:70000',
      '192.0.2.10:1:2',
      '192.168.01.1',
      '',
    ]) {
      expect(parseAccessInput(bad), bad).toHaveProperty('error');
    }
  });
});

it('zeri iniziali: messaggio dedicato', () => {
  expect(parseAccessInput('192.168.01.1')).toEqual({ error: 'accessDevices.errLeadingZero' });
});

describe('parseTsap', () => {
  it('legge due byte esadecimali', () => {
    expect(parseTsap('03.02')).toBe(0x0302);
    expect(parseTsap('1A.ff')).toBe(0x1aff);
    expect(parseTsap('0302')).toBeNull();
    expect(parseTsap('3.2')).toBeNull();
    expect(parseTsap('zz.00')).toBeNull();
  });
});

const IFACE = { name: 'en0', address: '192.0.2.5', netmask: '255.255.255.0' };
const CPU_DEV = {
  host: '192.0.2.10',
  status: 'cpu' as const,
  identity: { orderNumber: '6ES7 315-2EH14-0AB0', moduleName: 'CPU 315-2 PN/DP' },
  mode: 'RUN' as const,
};

async function openDialog() {
  const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
  app.bridge.plcInterfacesValue = [IFACE];
  await act(async () => {
    await commands['online.accessibleDevices'].run({
      store: app.store,
      service: app.service,
      bridge: app.bridge,
    });
  });
  const dlg = await screen.findByRole('dialog', { name: 'Dispositivi accessibili' });
  await within(dlg).findByRole('option', { name: /en0/ });
  return { ...app, dlg };
}

describe('finestra «Dispositivi accessibili»', () => {
  it('il comando è attivo solo con un progetto aperto', async () => {
    const { store } = await renderApp({ view: 'portal' });
    expect(commands['online.accessibleDevices'].isEnabled(store.getState())).toBe(false);
  });

  it('mostra i dispositivi da eventi finti e Interrompi manda scanCancel', async () => {
    const { user, bridge, dlg } = await openDialog();
    bridge.plcScanResults = [{ ok: true, scanId: 1, total: 254 }];
    await user.click(within(dlg).getByRole('button', { name: 'Avvia ricerca' }));
    await waitFor(() => expect(bridge.plcScanStartCalls).toEqual(['192.0.2.5']));
    act(() => {
      bridge.emitPlcScanEvent({ scanId: 1, kind: 'found', device: CPU_DEV });
      bridge.emitPlcScanEvent({
        scanId: 1,
        kind: 'found',
        device: { host: '192.0.2.20', status: 'unknown', reason: 'x' },
      });
      bridge.emitPlcScanEvent({ scanId: 1, kind: 'progress', done: 10, total: 254 });
    });
    const row = within(dlg).getByRole('row', { name: /192\.0\.2\.10/ });
    expect(within(row).getByText('CPU')).toBeInTheDocument();
    expect(within(row).getByText('CPU 315-2 PN/DP')).toBeInTheDocument();
    expect(within(row).getByText('6ES7 315-2EH14-0AB0')).toBeInTheDocument();
    expect(within(dlg).getByText('Dispositivo non riconosciuto')).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: 'Interrompi' }));
    expect(bridge.plcScanCancelCalls).toBe(1);
    act(() => bridge.emitPlcScanEvent({ scanId: 1, kind: 'done', found: 2, cancelled: true }));
    expect(within(dlg).getByRole('button', { name: 'Avvia ricerca' })).toBeEnabled();
  });

  it('gli eventi arrivati prima della risposta si tengono se il scanId coincide, altrimenti si scartano', async () => {
    const { user, bridge, dlg } = await openDialog();
    bridge.plcScanStart = async (addr: string) => {
      bridge.plcScanStartCalls.push(addr);
      // Prima della risposta: uno della ricerca giusta (7) e uno di un'altra (3).
      bridge.emitPlcScanEvent({ scanId: 7, kind: 'found', device: CPU_DEV });
      bridge.emitPlcScanEvent({
        scanId: 3,
        kind: 'found',
        device: { host: '192.0.2.99', status: 'unknown', reason: 'vecchia' },
      });
      await Promise.resolve();
      return { ok: true, scanId: 7, total: 254 };
    };
    await user.click(within(dlg).getByRole('button', { name: 'Avvia ricerca' }));
    await within(dlg).findByRole('row', { name: /192\.0\.2\.10/ });
    // Dopo la risposta, un evento di un'altra ricerca viene scartato.
    act(() =>
      bridge.emitPlcScanEvent({
        scanId: 8,
        kind: 'found',
        device: { host: '192.0.2.77', status: 'unknown', reason: 'altra' },
      }),
    );
    expect(within(dlg).queryByText('192.0.2.99')).not.toBeInTheDocument();
    expect(within(dlg).queryByText('192.0.2.77')).not.toBeInTheDocument();
  });

  it('indirizzo manuale: errore chiaro per un nome host, riga aggiunta per un IPv4', async () => {
    const { user, dlg } = await openDialog();
    const input = within(dlg).getByLabelText('Indirizzo manuale');
    await user.type(input, 'plc.local');
    await user.click(within(dlg).getByRole('button', { name: 'Aggiungi indirizzo' }));
    expect(within(dlg).getByRole('alert')).toHaveTextContent(/IPv4/);
    await user.clear(input);
    await user.type(input, '127.0.0.1:10102');
    await user.click(within(dlg).getByRole('button', { name: 'Aggiungi indirizzo' }));
    expect(within(dlg).getByRole('row', { name: /127\.0\.0\.1:10102/ })).toBeInTheDocument();
  });

  it('Collega salva access (annullabile) ed esegue goOnline', async () => {
    const { user, store, bridge, dlg } = await openDialog();
    const goOnline = vi
      .spyOn(PlcController.prototype, 'goOnline')
      .mockImplementation(async () => {});
    bridge.plcScanResults = [{ ok: true, scanId: 1, total: 254 }];
    await user.click(within(dlg).getByRole('button', { name: 'Avvia ricerca' }));
    await waitFor(() => expect(bridge.plcScanStartCalls).toHaveLength(1));
    act(() => bridge.emitPlcScanEvent({ scanId: 1, kind: 'found', device: CPU_DEV }));
    const connect = within(dlg).getByRole('button', { name: 'Collega' });
    expect(connect).toBeDisabled();
    await user.click(within(dlg).getByRole('row', { name: /192\.0\.2\.10/ }));
    await user.click(connect);
    const dev = () => findDevice(store.getState().doc!.project, 'id1')!;
    expect(dev().properties.access).toEqual({
      host: '192.0.2.10',
      rack: 0,
      slot: 2,
      connectionType: 'PG',
    });
    expect(goOnline).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    act(() => store.getState().undo());
    expect(dev().properties.access).toBeUndefined();
    act(() => store.getState().redo());
    expect(dev().properties.access?.host).toBe('192.0.2.10');
    goOnline.mockRestore();
  });

  it('Collega con un collegamento online attivo: messaggio, niente access, finestra aperta', async () => {
    const { user, store, dlg } = await openDialog();
    const goOnline = vi
      .spyOn(PlcController.prototype, 'goOnline')
      .mockImplementation(async () => {});
    await user.type(within(dlg).getByLabelText('Indirizzo manuale'), '192.0.2.40');
    await user.click(within(dlg).getByRole('button', { name: 'Aggiungi indirizzo' }));
    await user.click(within(dlg).getByRole('row', { name: /192\.0\.2\.40/ }));
    act(() => store.getState().patchOnline({ status: 'on' }));
    await user.click(within(dlg).getByRole('button', { name: 'Collega' }));
    expect(within(dlg).getByRole('alert')).toHaveTextContent(
      'Interrompi prima il collegamento online',
    );
    expect(findDevice(store.getState().doc!.project, 'id1')!.properties.access).toBeUndefined();
    expect(goOnline).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    goOnline.mockRestore();
  });

  it('plcScanStart che fallisce: errore e si può riprovare', async () => {
    const { user, bridge, dlg } = await openDialog();
    bridge.plcScanStart = async () => {
      throw new Error('boom');
    };
    await user.click(within(dlg).getByRole('button', { name: 'Avvia ricerca' }));
    expect(await within(dlg).findByRole('alert')).toHaveTextContent('boom');
    expect(within(dlg).getByRole('button', { name: 'Avvia ricerca' })).toBeEnabled();
    bridge.plcScanStart = async () => ({ ok: true, scanId: 1, total: 254 });
    await user.click(within(dlg).getByRole('button', { name: 'Avvia ricerca' }));
    await waitFor(() =>
      expect(within(dlg).getByRole('button', { name: 'Interrompi' })).toBeEnabled(),
    );
  });

  it('gateway RFC 1006: il TSAP si valida e finisce in remoteTsap', async () => {
    const { user, store, dlg } = await openDialog();
    const goOnline = vi
      .spyOn(PlcController.prototype, 'goOnline')
      .mockImplementation(async () => {});
    await user.type(within(dlg).getByLabelText('Indirizzo manuale'), '192.0.2.30');
    await user.click(within(dlg).getByRole('button', { name: 'Aggiungi indirizzo' }));
    await user.click(within(dlg).getByRole('row', { name: /192\.0\.2\.30/ }));
    await user.selectOptions(within(dlg).getByLabelText('Tipo di collegamento'), 'gateway');
    const connect = within(dlg).getByRole('button', { name: 'Collega' });
    expect(connect).toBeDisabled(); // TSAP vuoto
    await user.type(within(dlg).getByLabelText('TSAP remoto (esadecimale)'), '03.02');
    await user.click(connect);
    expect(findDevice(store.getState().doc!.project, 'id1')!.properties.access).toEqual({
      host: '192.0.2.30',
      rack: 0,
      slot: 2,
      connectionType: 'PG',
      remoteTsap: 0x0302,
    });
    goOnline.mockRestore();
  });
});

describe('finestra «Dispositivi accessibili»: adattatore MPI', () => {
  async function openMpi() {
    const app = await openDialog();
    app.bridge.plcSerialPortsValue = [{ path: 'COM3' }, { path: 'COM7' }];
    await app.user.selectOptions(
      within(app.dlg).getByLabelText('Tipo di interfaccia PG/PC'),
      'mpi',
    );
    await within(app.dlg).findByRole('option', { name: 'COM3' });
    return app;
  }

  it('mostra porte, velocità, parità, indirizzi, HSA, bus e variante con i valori predefiniti', async () => {
    const { dlg } = await openMpi();
    expect(within(dlg).getByLabelText('Interfaccia PG/PC')).toHaveValue('COM3');
    expect(within(dlg).getByLabelText('Velocità di trasmissione (porta seriale)')).toHaveValue(
      '38400',
    );
    expect(within(dlg).getByLabelText('Parità')).toHaveValue('odd');
    expect(within(dlg).getByLabelText('Indirizzo MPI della CPU')).toHaveValue(2);
    expect(within(dlg).getByLabelText('Indirizzo MPI del PG/PC')).toHaveValue(0);
    expect(within(dlg).getByLabelText('Indirizzo più alto (HSA)')).toHaveValue('31');
    expect(within(dlg).getByLabelText('Velocità di trasmissione (bus MPI)')).toHaveValue('187.5k');
    expect(within(dlg).getByLabelText("Protocollo dell'adattatore")).toHaveValue('auto');
    // la ricerca nella rete non c'entra con l'MPI
    expect(within(dlg).queryByRole('button', { name: 'Avvia ricerca' })).not.toBeInTheDocument();
  });

  it('Aggiorna rilegge le porte', async () => {
    const { user, bridge, dlg } = await openMpi();
    bridge.plcSerialPortsValue = [{ path: 'COM9' }];
    await user.click(within(dlg).getByRole('button', { name: 'Aggiorna' }));
    await within(dlg).findByRole('option', { name: 'COM9' });
    expect(within(dlg).getByLabelText('Interfaccia PG/PC')).toHaveValue('COM9');
  });

  it('Cerca elenca i nodi del bus e sceglierne uno fissa l’indirizzo della CPU', async () => {
    const { user, bridge, dlg } = await openMpi();
    bridge.plcMpiNodesValue = { ok: true, nodes: [0, 2, 6] };
    await user.click(within(dlg).getByRole('button', { name: 'Cerca' }));
    const group = await within(dlg).findByRole('group', { name: 'Nodi sul bus MPI' });
    expect(bridge.plcMpiNodesCalls[0]).toMatchObject({ port: 'COM3', localAddress: 0 });
    // l'indirizzo del PG/PC (0) non si propone
    expect(within(group).queryByRole('button', { name: 'Indirizzo 0' })).not.toBeInTheDocument();
    await user.click(within(group).getByRole('button', { name: 'Indirizzo 6' }));
    expect(within(dlg).getByLabelText('Indirizzo MPI della CPU')).toHaveValue(6);
  });

  it('Cerca che fallisce: il messaggio dell’adattatore nella finestra', async () => {
    const { user, bridge, dlg } = await openMpi();
    bridge.plcMpiNodesValue = {
      ok: false,
      error: 'Adattatore MPI non risponde: controllare porta, velocità e cavo',
    };
    await user.click(within(dlg).getByRole('button', { name: 'Cerca' }));
    expect(await within(dlg).findByRole('alert')).toHaveTextContent('Adattatore MPI non risponde');
  });

  it('Collega salva l’accesso MPI nella CPU ed esegue goOnline', async () => {
    const { user, store, dlg } = await openMpi();
    const goOnline = vi
      .spyOn(PlcController.prototype, 'goOnline')
      .mockImplementation(async () => {});
    await user.selectOptions(within(dlg).getByLabelText('Interfaccia PG/PC'), 'COM7');
    await user.selectOptions(within(dlg).getByLabelText('Parità'), 'even');
    await user.clear(within(dlg).getByLabelText('Indirizzo MPI della CPU'));
    await user.type(within(dlg).getByLabelText('Indirizzo MPI della CPU'), '4');
    await user.click(within(dlg).getByRole('button', { name: 'Collega' }));
    expect(findDevice(store.getState().doc!.project, 'id1')!.properties.access).toEqual({
      host: '',
      rack: 0,
      slot: 2,
      connectionType: 'PG',
      link: {
        kind: 'mpi',
        port: 'COM7',
        baudRate: 38400,
        parity: 'even',
        localAddress: 0,
        cpuAddress: 4,
        highestAddress: 31,
        busSpeed: '187.5k',
        variant: 'auto',
      },
    });
    expect(goOnline).toHaveBeenCalledTimes(1);
    goOnline.mockRestore();
  });

  it('indirizzo MPI oltre 126 o nessuna porta: Collega disattivo', async () => {
    const { user, bridge, dlg } = await openMpi();
    await user.clear(within(dlg).getByLabelText('Indirizzo MPI della CPU'));
    await user.type(within(dlg).getByLabelText('Indirizzo MPI della CPU'), '127');
    expect(within(dlg).getByRole('alert')).toHaveTextContent('tra 0 e 126');
    expect(within(dlg).getByRole('button', { name: 'Collega' })).toBeDisabled();
    // stesso indirizzo dell'adattatore (0): messaggio e Collega disattivo
    await user.clear(within(dlg).getByLabelText('Indirizzo MPI della CPU'));
    await user.type(within(dlg).getByLabelText('Indirizzo MPI della CPU'), '0');
    expect(within(dlg).getByRole('alert')).toHaveTextContent('diverso da quello del PG/PC');
    expect(within(dlg).getByRole('button', { name: 'Collega' })).toBeDisabled();
    await user.clear(within(dlg).getByLabelText('Indirizzo MPI della CPU'));
    await user.type(within(dlg).getByLabelText('Indirizzo MPI della CPU'), '2');
    expect(within(dlg).getByRole('button', { name: 'Collega' })).toBeEnabled();
    bridge.plcSerialPortsValue = [];
    await user.click(within(dlg).getByRole('button', { name: 'Aggiorna' }));
    await within(dlg).findByRole('option', { name: 'Nessuna porta seriale trovata.' });
    expect(within(dlg).getByRole('button', { name: 'Collega' })).toBeDisabled();
  });
});

describe('finestra «Dispositivi accessibili»: chiusura e casi limite', () => {
  it('chiusa durante la ricerca: manda scanCancel e toglie il listener', async () => {
    const { user, bridge, dlg } = await openDialog();
    bridge.plcScanResults = [{ ok: true, scanId: 1, total: 254 }];
    await user.click(within(dlg).getByRole('button', { name: 'Avvia ricerca' }));
    await waitFor(() => expect(bridge.plcScanStartCalls).toHaveLength(1));
    await user.click(within(dlg).getByRole('button', { name: 'Chiudi' }));
    expect(bridge.plcScanCancelCalls).toBe(1);
    expect((bridge as unknown as { plcScanCbs: Set<unknown> }).plcScanCbs.size).toBe(0);
  });

  it("un found di una ricerca vecchia, dopo l'avvio di una nuova, si scarta", async () => {
    const { user, bridge, dlg } = await openDialog();
    bridge.plcScanResults = [
      { ok: true, scanId: 1, total: 254 },
      { ok: true, scanId: 2, total: 254 },
    ];
    const start = () => within(dlg).getByRole('button', { name: 'Avvia ricerca' });
    await user.click(start());
    await waitFor(() => expect(bridge.plcScanStartCalls).toHaveLength(1));
    act(() => bridge.emitPlcScanEvent({ scanId: 1, kind: 'done', found: 0, cancelled: false }));
    await user.click(start());
    await waitFor(() => expect(bridge.plcScanStartCalls).toHaveLength(2));
    act(() => bridge.emitPlcScanEvent({ scanId: 1, kind: 'found', device: CPU_DEV }));
    expect(within(dlg).queryByRole('row', { name: /192\.0\.2\.10/ })).not.toBeInTheDocument();
    act(() => bridge.emitPlcScanEvent({ scanId: 2, kind: 'found', device: CPU_DEV }));
    expect(within(dlg).getByRole('row', { name: /192\.0\.2\.10/ })).toBeInTheDocument();
  });

  it('rack e slot fuori campo: messaggio e Collega disattivo', async () => {
    const { user, dlg } = await openDialog();
    await user.type(within(dlg).getByLabelText('Indirizzo manuale'), '192.0.2.30');
    await user.click(within(dlg).getByRole('button', { name: 'Aggiungi indirizzo' }));
    await user.click(within(dlg).getByRole('row', { name: /192\.0\.2\.30/ }));
    await user.clear(within(dlg).getByLabelText('Rack'));
    await user.type(within(dlg).getByLabelText('Rack'), '9');
    expect(within(dlg).getByRole('alert')).toHaveTextContent(/rack/i);
    expect(within(dlg).getByRole('button', { name: 'Collega' })).toBeDisabled();
  });

  it('plcInterfaces che fallisce: messaggio nella finestra', async () => {
    const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
    app.bridge.plcInterfaces = async () => {
      throw new Error('boom');
    };
    await act(async () => {
      await commands['online.accessibleDevices'].run({
        store: app.store,
        service: app.service,
        bridge: app.bridge,
      });
    });
    const dlg = await screen.findByRole('dialog', { name: 'Dispositivi accessibili' });
    expect(await within(dlg).findByRole('alert')).toHaveTextContent(/boom/);
  });

  describe('più CPU', () => {
    async function twoCpus(select: 'first' | 'second' | 'none') {
      const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
      app.store.getState().edit('history.addDevice', (p) => {
        const d = JSON.parse(JSON.stringify(p.devices[0]));
        d.id = 'id2';
        d.name = 'PLC_2';
        p.devices.push(d);
      });
      if (select === 'second') app.store.getState().select('plc:id2');
      if (select === 'first') app.store.getState().select('plc:id1');
      app.bridge.plcInterfacesValue = [IFACE];
      await act(async () => {
        await commands['online.accessibleDevices'].run({
          store: app.store,
          service: app.service,
          bridge: app.bridge,
        });
      });
      const dlg = await screen.findByRole('dialog', { name: 'Dispositivi accessibili' });
      return { ...app, dlg };
    }

    it('il select parte dalla CPU selezionata nell’albero', async () => {
      const { dlg } = await twoCpus('second');
      expect(within(dlg).getByLabelText('CPU del progetto')).toHaveValue('id2');
    });

    it('senza selezione parte dalla prima e Collega salva sulla scelta', async () => {
      const { user, store, dlg } = await twoCpus('none');
      const goOnline = vi
        .spyOn(PlcController.prototype, 'goOnline')
        .mockImplementation(async () => {});
      const sel = within(dlg).getByLabelText('CPU del progetto');
      expect(sel).toHaveValue('id1');
      await user.selectOptions(sel, 'id2');
      await user.type(within(dlg).getByLabelText('Indirizzo manuale'), '192.0.2.40');
      await user.click(within(dlg).getByRole('button', { name: 'Aggiungi indirizzo' }));
      await user.click(within(dlg).getByRole('button', { name: 'Collega' }));
      const devs = store.getState().doc!.project.devices;
      expect(devs[1]!.properties.access?.host).toBe('192.0.2.40');
      expect(devs[0]!.properties.access).toBeUndefined();
      expect(goOnline).toHaveBeenCalledWith('id2');
      goOnline.mockRestore();
    });

    it('albero su PLC_1, finestra su PLC_2: si collega PLC_2', async () => {
      const { user, store, bridge, dlg } = await twoCpus('first');
      bridge.plcResults.push({
        ok: true,
        mode: 'RUN',
        identity: { orderNumber: '6ES7 315-2EH14-0AB0' },
      });
      await user.selectOptions(within(dlg).getByLabelText('CPU del progetto'), 'id2');
      await user.type(within(dlg).getByLabelText('Indirizzo manuale'), '192.0.2.40');
      await user.click(within(dlg).getByRole('button', { name: 'Aggiungi indirizzo' }));
      await user.click(within(dlg).getByRole('button', { name: 'Collega' }));
      await waitFor(() => expect(store.getState().online.status).toBe('on'));
      expect(store.getState().online.deviceId).toBe('id2');
      expect(bridge.plcConnectCalls[0]!.host).toBe('192.0.2.40');
    });
  });
});
