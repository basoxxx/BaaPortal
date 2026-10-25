import { act, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { findDevice } from '@baaportal/project';
import { commands } from '../../src/commands/commands';
import { renderApp } from '../renderApp';

const ACCESS = { host: '192.0.2.10', rack: 0, slot: 2, connectionType: 'PG' as const };

async function online(force?: boolean) {
  const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
  await act(async () => {
    await app.service.open('/doc/BaaPortal/Linea 3.baap');
  });
  findDevice(app.store.getState().doc!.project, 'id1')!.properties.access = ACCESS;
  app.bridge.plcResults.push({
    ok: true,
    mode: 'RUN',
    identity: { orderNumber: '6ES7 315-2EH14-0AB0', moduleName: 'CPU 315-2 PN/DP' },
    ...(force !== undefined ? { force } : {}),
  });
  const ctx = { store: app.store, service: app.service, bridge: app.bridge };
  await act(async () => {
    await commands['online.goOnline'].run(ctx);
  });
  return { app, ctx };
}

describe('barra di stato: forzamento attivo', () => {
  it("FRCE acceso online → «Forzamento attivo sulla CPU»; spento dall'evento → sparisce", async () => {
    const { app } = await online(true);
    expect(await screen.findByTestId('plc-force-warning')).toHaveTextContent(
      'Forzamento attivo sulla CPU',
    );
    act(() => app.bridge.emitPlcEvent({ kind: 'force', active: false }));
    expect(screen.queryByTestId('plc-force-warning')).toBeNull();
    act(() => app.bridge.emitPlcEvent({ kind: 'force', active: true }));
    expect(screen.getByTestId('plc-force-warning')).toBeInTheDocument();
  });

  it('offline → niente, anche se prima era acceso', async () => {
    const { app, ctx } = await online(true);
    expect(screen.getByTestId('plc-force-warning')).toBeInTheDocument();
    await act(async () => {
      await commands['online.goOffline'].run(ctx);
    });
    expect(screen.queryByTestId('plc-force-warning')).toBeNull();
    expect(app.store.getState().online.force).toBeUndefined();
  });

  it('senza FRCE nel risultato → niente', async () => {
    await online();
    expect(screen.queryByTestId('plc-force-warning')).toBeNull();
  });
});
