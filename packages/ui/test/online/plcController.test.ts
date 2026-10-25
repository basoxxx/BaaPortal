import { act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { findDevice } from '@baaportal/project';
import { commands } from '../../src/commands/commands';
import { plcControllerFor, shutdownOnline } from '../../src/online/plcController';
import { simControllerFor } from '../../src/sim/simController';
import type { PlcConnectResult } from '../../src/online/plcTypes';
import { renderApp } from '../renderApp';

const ACCESS = { host: '192.0.2.10', rack: 0, slot: 2, connectionType: 'PG' as const };
const OK: PlcConnectResult = {
  ok: true,
  mode: 'RUN',
  identity: { orderNumber: '6ES7 315-2EH14-0AB0', moduleName: 'CPU 315-2 PN/DP' },
};

async function setup(withAccess = true) {
  const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
  await act(async () => {
    await app.service.open('/doc/BaaPortal/Linea 3.baap');
  });
  if (withAccess) findDevice(app.store.getState().doc!.project, 'id1')!.properties.access = ACCESS;
  const ctx = { store: app.store, service: app.service, bridge: app.bridge };
  const run = (id: 'online.goOnline' | 'online.goOffline' | 'online.simulation') =>
    act(async () => {
      await commands[id].run(ctx);
    });
  const messages = () => app.store.getState().messages.map((m) => m.textKey);
  return { app, run, messages, online: () => app.store.getState().online };
}

/** Sostituisce plcConnect con una risposta che si decide a mano. */
function gate(app: Awaited<ReturnType<typeof setup>>['app']) {
  let resolve!: (r: PlcConnectResult) => void;
  app.bridge.plcConnect = (access) => {
    app.bridge.plcConnectCalls.push(access);
    app.bridge.plcState = { connected: true, access };
    return new Promise<PlcConnectResult>((r) => (resolve = r));
  };
  return (r: PlcConnectResult) => act(async () => resolve(r));
}

describe('collegamento online', () => {
  it('goOnline: connecting, poi on con identità e modo', async () => {
    const s = await setup();
    const answer = gate(s.app);
    const p = s.run('online.goOnline');
    expect(s.online()).toMatchObject({ status: 'connecting', deviceId: 'id1' });
    await answer(OK);
    await p;
    expect(s.online()).toMatchObject({ status: 'on', mode: 'RUN', deviceId: 'id1' });
    expect(s.online().identity?.orderNumber).toBe('6ES7 315-2EH14-0AB0');
    expect(s.app.bridge.plcConnectCalls).toEqual([ACCESS]);
    expect(s.messages()).not.toContain('messages.plcMismatch');
  });

  it('senza access apre la finestra e non collega', async () => {
    const s = await setup(false);
    await s.run('online.goOnline');
    expect(s.app.store.getState().dialog?.kind).toBe('accessibleDevices');
    expect(s.online().status).toBe('off');
    expect(s.app.bridge.plcConnectCalls).toHaveLength(0);
  });

  it('collegamento rifiutato: torna off con un messaggio', async () => {
    const s = await setup();
    s.app.bridge.plcResults.push({ ok: false, error: 'nessuna risposta' });
    await s.run('online.goOnline');
    expect(s.online().status).toBe('off');
    expect(s.messages()).toContain('messages.plcConnectFailed');
  });

  it('esclusione con la simulazione, nei due sensi', async () => {
    const s = await setup();
    const st = () => s.app.store.getState();
    expect(commands['online.goOnline'].isEnabled(st())).toBe(true);
    act(() => st().setSim({ phase: 'on', deviceId: 'id1' }));
    expect(commands['online.goOnline'].isEnabled(st())).toBe(false);
    act(() => st().setSim({ phase: 'off' }));
    s.app.bridge.plcResults.push(OK);
    await s.run('online.goOnline');
    expect(commands['online.simulation'].isEnabled(st())).toBe(false);
    expect(commands['online.goOnline'].isEnabled(st())).toBe(false);
    expect(commands['online.goOffline'].isEnabled(st())).toBe(true);
    await s.run('online.goOffline');
    expect(s.online().status).toBe('off');
    expect(s.app.bridge.plcDisconnectCalls).toBe(1);
    expect(commands['online.simulation'].isEnabled(st())).toBe(true);
  });

  it('evento mode aggiorna il modo', async () => {
    const s = await setup();
    s.app.bridge.plcResults.push(OK);
    await s.run('online.goOnline');
    act(() => s.app.bridge.emitPlcEvent({ kind: 'mode', mode: 'STOP' }));
    expect(s.online().mode).toBe('STOP');
  });

  it('evento lost: off e messaggio con il motivo', async () => {
    const s = await setup();
    s.app.bridge.plcResults.push(OK);
    await s.run('online.goOnline');
    act(() => s.app.bridge.emitPlcEvent({ kind: 'lost', reason: 'timeout' }));
    expect(s.online().status).toBe('off');
    const m = s.app.store.getState().messages.at(-1)!;
    expect(m.textKey).toBe('messages.plcLost');
    expect(m.params).toEqual({ reason: 'timeout' });
    // un evento tardivo non risuscita nulla
    act(() => s.app.bridge.emitPlcEvent({ kind: 'mode', mode: 'RUN' }));
    expect(s.online().status).toBe('off');
  });

  it('CPU diversa dal progetto: avviso, non blocca', async () => {
    const s = await setup();
    s.app.bridge.plcResults.push({
      ok: true,
      mode: 'STOP',
      identity: { orderNumber: '6ES7 317-2EK14-0AB0' },
    });
    await s.run('online.goOnline');
    expect(s.online().status).toBe('on');
    const m = s.app.store.getState().messages.find((x) => x.textKey === 'messages.plcMismatch')!;
    expect(m.severity).toBe('warning');
    expect(m.params).toEqual({
      connected: '6ES7 317-2EK14-0AB0',
      project: '6ES7 315-2EH14-0AB0',
    });
  });

  it('cambio progetto durante connecting: nessuna scrittura nel nuovo progetto', async () => {
    const s = await setup();
    const answer = gate(s.app);
    const p = s.run('online.goOnline');
    expect(s.online().status).toBe('connecting');
    await act(async () => {
      await s.app.service.close();
    });
    expect(s.online().status).toBe('off');
    expect(s.app.bridge.plcDisconnectCalls).toBe(1);
    const before = s.app.store.getState().messages.length;
    await answer(OK);
    await p;
    expect(s.online().status).toBe('off');
    expect(s.app.store.getState().messages).toHaveLength(before);
    // la connessione nata dopo la chiusura viene chiusa a sua volta
    expect(s.app.bridge.plcDisconnectCalls).toBe(2);
  });

  it('chiudere il progetto da online scollega e ignora gli eventi', async () => {
    const s = await setup();
    s.app.bridge.plcResults.push(OK);
    await s.run('online.goOnline');
    await act(async () => {
      await s.app.service.close();
    });
    expect(s.online().status).toBe('off');
    expect(s.app.bridge.plcDisconnectCalls).toBe(1);
    act(() => s.app.bridge.emitPlcEvent({ kind: 'lost', reason: 'x' }));
    expect(s.messages()).not.toContain('messages.plcLost');
  });

  it('plcStatus dice non collegato dopo il collegamento: off con plcLost', async () => {
    const s = await setup();
    s.app.bridge.plcResults.push(OK);
    s.app.bridge.plcStatus = async () => ({ connected: false });
    await s.run('online.goOnline');
    expect(s.online().status).toBe('off');
    expect(s.messages()).toContain('messages.plcLost');
    expect(s.messages()).not.toContain('messages.plcConnected');
  });

  it('la simulazione rifiuta di partire con un collegamento online, con un messaggio', async () => {
    const s = await setup();
    s.app.bridge.plcResults.push(OK);
    await s.run('online.goOnline');
    await act(async () => {
      await simControllerFor(s.app.store).toggle();
    });
    expect(s.app.store.getState().sim.phase).toBe('off');
    expect(s.messages().at(-1)).toBe('messages.simBlockedByOnline');
  });

  it('goOnline con la simulazione accesa (anche in avvio) mostra un messaggio', async () => {
    const s = await setup();
    act(() => s.app.store.getState().setSim({ phase: 'starting', deviceId: 'id1' }));
    expect(commands['online.goOnline'].isEnabled(s.app.store.getState())).toBe(false);
    await act(async () => {
      await plcControllerFor(s.app.store, s.app.bridge).goOnline();
    });
    expect(s.online().status).toBe('off');
    expect(s.app.bridge.plcConnectCalls).toHaveLength(0);
    expect(s.messages().at(-1)).toBe('messages.plcBlockedBySim');
  });

  it('goOffline durante connecting annulla; la risposta tardiva non risuscita nulla', async () => {
    const s = await setup();
    const answer = gate(s.app);
    const p = s.run('online.goOnline');
    await s.run('online.goOffline');
    expect(s.online().status).toBe('off');
    await answer(OK);
    await p;
    expect(s.online().status).toBe('off');
    expect(s.app.bridge.plcDisconnectCalls).toBe(2);
  });

  it('un lost durante connecting si ignora; la simulazione è disabilitata', async () => {
    const s = await setup();
    const answer = gate(s.app);
    const p = s.run('online.goOnline');
    expect(commands['online.simulation'].isEnabled(s.app.store.getState())).toBe(false);
    act(() => s.app.bridge.emitPlcEvent({ kind: 'lost', reason: 'x' }));
    expect(s.online().status).toBe('connecting');
    await answer(OK);
    await p;
    expect(s.online().status).toBe('on');
    expect(s.messages()).not.toContain('messages.plcLost');
  });

  it('aprire un altro progetto da online scollega', async () => {
    const s = await setup();
    s.app.bridge.plcResults.push(OK);
    await s.run('online.goOnline');
    await act(async () => {
      await s.app.service.open('/doc/BaaPortal/Linea 3.baap');
    });
    expect(s.online().status).toBe('off');
    expect(s.app.bridge.plcDisconnectCalls).toBe(1);
  });

  it('shutdownOnline (chiusura della finestra) scollega', async () => {
    const s = await setup();
    s.app.bridge.plcResults.push(OK);
    await s.run('online.goOnline');
    shutdownOnline(s.app.store);
    expect(s.online().status).toBe('off');
    expect(s.app.bridge.plcDisconnectCalls).toBe(1);
  });
});
