import { act, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createCodeBlock } from '@baaportal/project';
import { commands } from '../../src/commands/commands';
import en from '../../src/i18n/en.json';
import type { PlcMonitorUiState } from '../../src/state/store';
import { dev, openEditor } from '../blockFixtures';

const T = 30_000;

async function setup(monitor: Partial<PlcMonitorUiState>, lines: unknown = null) {
  const f = createCodeBlock({ kind: 'FC', number: 9, name: 'Prova', language: 'AWL' });
  f.networks[0]!.source = 'L 42\nT MW 10\nNOP 0';
  const app = await openEditor('block', f.id, (d) => void d.blocks.push(f));
  const deviceId = dev(app).id;
  act(() => {
    app.store.setState((x) => ({
      online: {
        ...x.online,
        status: 'on',
        deviceId,
        monitor: { deviceId, blockId: f.id, reason: 'ok', ...monitor },
        monitorLines: lines as never,
      },
      compile: {
        ...x.compile,
        lines: {
          [f.id]: [
            { offset: 0, length: 2, network: 0, line: 0 },
            { offset: 2, length: 2, network: 0, line: 1 },
          ],
        },
      },
    }));
  });
  return { app, f, deviceId };
}

describe("osservazione sulla CPU nell'editor del blocco", () => {
  it(
    'righe con valori in colonna, riga null grigia (baa-mon-off)',
    async () => {
      await setup({}, [
        { offset: 0, regs: { stw: 0x0106, accu1: 42 } },
        { offset: 2, regs: null },
      ]);
      expect(await screen.findByText('Osservazione attiva sulla CPU.')).toBeTruthy();
      expect(document.querySelectorAll('.baa-mon-cell')).toHaveLength(1);
      expect(document.querySelector('.baa-mon-cell')!.textContent).toContain('0000002A');
      expect(document.querySelectorAll('.baa-mon-off')).toHaveLength(1);
    },
    T,
  );

  it(
    'waiting → tutte grigie con il messaggio',
    async () => {
      await setup({ reason: 'waiting' }, [
        { offset: 0, regs: null },
        { offset: 2, regs: null },
      ]);
      expect(screen.getByRole('alert').textContent).toContain(
        'Nessun risultato: il blocco non è elaborato o la finestra non è raggiunta.',
      );
      expect(document.querySelectorAll('.baa-mon-off')).toHaveLength(2);
      expect(document.querySelector('.baa-mon-cell')).toBeNull();
    },
    T,
  );

  it(
    'STOP → «CPU in STOP: nessun valore», nessuna cella',
    async () => {
      await setup({ reason: 'stop' });
      expect(screen.getByRole('alert').textContent).toContain('CPU in STOP: nessun valore');
      expect(document.querySelector('.baa-mon-cell')).toBeNull();
    },
    T,
  );

  it(
    'different → messaggio e pulsante «Confronta con la CPU»',
    async () => {
      await setup({ reason: 'different', message: 'Il blocco è diverso' });
      expect(screen.getByRole('alert').textContent).toContain('Il blocco è diverso');
      expect(screen.getByRole('button', { name: 'Confronta con la CPU' })).toBeTruthy();
    },
    T,
  );

  it(
    'limite: «Osservate le prime N righe visibili» e caselle ACCU2 e AR1',
    async () => {
      await setup({ limit: 24 });
      expect(screen.getByRole('status', { name: /Osservazione/ }).textContent).toContain(
        'Osservate le prime 24 righe visibili',
      );
      expect(screen.getByRole('checkbox', { name: 'ACCU2' })).toBeTruthy();
      expect(screen.getByRole('checkbox', { name: 'AR1' })).toBeTruthy();
    },
    T,
  );

  it(
    'barra di stato: «Osservazione attiva» solo con l osservazione PLC accesa',
    async () => {
      const { app } = await setup({});
      expect(screen.getByTestId('plc-monitor-warning').textContent).toContain(
        'Osservazione attiva — il tempo di ciclo della CPU aumenta',
      );
      act(() => app.store.getState().patchOnline({ monitor: null }));
      expect(screen.queryByTestId('plc-monitor-warning')).toBeNull();
    },
    T,
  );

  it(
    'en: «Monitoring active — CPU cycle time increases»',
    () => {
      expect(en.plcMonitor.cycleWarning).toBe('Monitoring active — CPU cycle time increases');
    },
    T,
  );

  it(
    'simulazione attiva → online.monitor usa il simulatore, nessuna chiamata al PLC',
    async () => {
      const { app, deviceId } = await setup({});
      act(() => {
        app.store.getState().patchOnline({ monitor: null });
        app.store.getState().setSim({ phase: 'on', deviceId });
      });
      act(
        () =>
          void commands['online.monitor'].run({
            store: app.store,
            service: app.service,
            bridge: app.bridge,
          }),
      );
      expect(app.store.getState().sim.monitor).not.toBeNull();
      expect(app.store.getState().online.monitor ?? null).toBeNull();
      expect(
        (app.bridge as unknown as { plcStatusStartCalls: unknown[] }).plcStatusStartCalls,
      ).toHaveLength(0);
    },
    T,
  );
});
