import { act, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { findDevice } from '@baaportal/project';
import { commands } from '../../src/commands/commands';
import { renderApp } from '../renderApp';

const ACCESS = { host: '192.0.2.10', rack: 0, slot: 2, connectionType: 'PG' as const };

async function online(mode: 'RUN' | 'STOP' = 'RUN') {
  const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
  await act(async () => {
    await app.service.open('/doc/BaaPortal/Linea 3.baap');
  });
  findDevice(app.store.getState().doc!.project, 'id1')!.properties.access = ACCESS;
  app.bridge.plcResults.push({
    ok: true,
    mode,
    identity: { orderNumber: '6ES7 315-2EH14-0AB0', moduleName: 'CPU 315-2 PN/DP' },
  });
  await act(async () => {
    await commands['online.goOnline'].run({
      store: app.store,
      service: app.service,
      bridge: app.bridge,
    });
  });
  return app;
}

describe('modalità online nell interfaccia', () => {
  it('senza collegamento il contenitore non ha la classe online', async () => {
    await renderApp({ view: 'project', withProject: true, withPlc: true });
    expect(screen.getByTestId('app-root')).not.toHaveClass('online');
  });

  it('con il collegamento il contenitore ha la classe online e il titolo la dicitura', async () => {
    const app = await online();
    expect(screen.getByTestId('app-root')).toHaveClass('online');
    expect(app.bridge.title).toMatch(/ — Online$/);
    expect(document.querySelector('[data-panel="navigation"] > .baa-panel-header')).not.toBeNull();
    expect(document.querySelector('.baa-menubar')).not.toBeNull();
    await act(async () => {
      await commands['online.goOffline'].run({
        store: app.store,
        service: app.service,
        bridge: app.bridge,
      });
    });
    expect(screen.getByTestId('app-root')).not.toHaveClass('online');
    expect(app.bridge.title).not.toMatch(/Online/);
  });

  it('la barra di stato mostra modulo, host e stato', async () => {
    await online('STOP');
    expect(screen.getByTestId('plc-indicator')).toHaveTextContent(
      'Online: CPU 315-2 PN/DP 192.0.2.10 - STOP',
    );
  });

  it('il pannello CPU mostra LED e identità; solo MRES è disabilitato', async () => {
    const app = await online('RUN');
    act(() => app.store.getState().setTaskCard('test'));
    const panels = screen.getAllByTestId('cpu-panel-online');
    const p = within(panels[0]!);
    expect(p.getByTestId('led-run')).toHaveAttribute('data-on', 'true');
    expect(p.getByTestId('led-stop')).toHaveAttribute('data-on', 'false');
    expect(p.getByTestId('cpu-identity')).toHaveTextContent('6ES7 315-2EH14-0AB0');
    expect(p.getByTestId('cpu-identity')).toHaveTextContent('CPU 315-2 PN/DP');
    expect(p.getByTestId('cpu-mres')).toBeDisabled();
    expect(p.getByTestId('cpu-stop')).toBeEnabled();
    expect(p.getAllByText('Non disponibile in sola lettura').length).toBeGreaterThan(0);
    act(() => app.bridge.emitPlcEvent({ kind: 'mode', mode: 'STOP' }));
    expect(
      within(screen.getAllByTestId('cpu-panel-online')[0]!).getByTestId('led-stop'),
    ).toHaveAttribute('data-on', 'true');
  });
});

describe('chiusura della finestra', () => {
  it('handleCloseRequest scollega il PLC', async () => {
    const app = await online();
    await act(async () => {
      await app.service.handleCloseRequest();
    });
    expect(app.store.getState().online.status).toBe('off');
    expect(app.bridge.plcDisconnectCalls).toBe(1);
  });
});
