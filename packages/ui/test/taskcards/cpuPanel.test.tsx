import { act, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { findDevice } from '@baaportal/project';
import type { DiagEntry } from '@baaportal/sim';
import { simControllerFor } from '../../src/sim/simController';
import { renderApp } from '../renderApp';

const PLC = 'id1';

async function setup(patch: Record<string, unknown> = {}) {
  const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
  act(() => app.store.getState().setTaskCard('test'));
  act(() => app.store.getState().setSim({ phase: 'on', deviceId: PLC, ...patch }));
  return app;
}

const entry = (o: Partial<DiagEntry>): DiagEntry => ({
  time: 1500,
  code: 'AVVIO',
  eventId: 0x9000,
  ...o,
});

describe('pannello di comando CPU', () => {
  it('senza simulazione invita ad avviarla', async () => {
    const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
    act(() => app.store.getState().setTaskCard('test'));
    expect(screen.getAllByText('Avvia la simulazione per usare il pannello')).toHaveLength(2);
  });

  it('LED e pulsanti in STOP; tempi di ciclo', async () => {
    await setup({ stats: { last: 3, min: 2, max: 9, cycles: 4 } });
    expect(screen.getByTestId('led-stop')).toHaveAttribute('data-on', 'true');
    expect(screen.getByTestId('led-run')).toHaveAttribute('data-on', 'false');
    expect(screen.getByTestId('led-sf')).toHaveAttribute('data-on', 'false');
    expect(screen.getByTestId('cpu-run')).toBeEnabled();
    expect(screen.getByTestId('cpu-stop')).toBeDisabled();
    expect(screen.getByTestId('cpu-mres')).toBeEnabled();
    expect(screen.getByTestId('cpu-cycle')).toHaveTextContent('3 ms');
    expect(screen.getByTestId('cpu-cycle')).toHaveTextContent('9 ms');
  });

  it('in RUN MRES è disabilitato', async () => {
    await setup({ mode: 'RUN' });
    expect(screen.getByTestId('led-run')).toHaveAttribute('data-on', 'true');
    expect(screen.getByTestId('cpu-run')).toBeDisabled();
    expect(screen.getByTestId('cpu-stop')).toBeEnabled();
    expect(screen.getByTestId('cpu-mres')).toBeDisabled();
  });

  it('MRES e i pulsanti RUN/STOP vanno al controllore', async () => {
    const app = await setup();
    const c = simControllerFor(app.store);
    const mres = vi.spyOn(c, 'memoryReset').mockResolvedValue();
    const mode = vi.spyOn(c, 'setMode').mockResolvedValue();
    await app.user.click(screen.getByTestId('cpu-mres'));
    await app.user.click(screen.getByTestId('cpu-run'));
    expect(mres).toHaveBeenCalledTimes(1);
    expect(mode).toHaveBeenCalledWith('RUN');
  });

  it('SF si accende con un errore; buffer dal più recente; avvisi', async () => {
    await setup({
      diagnostics: [
        entry({ code: 'AVVIO' }),
        entry({ code: 'TEMPO_CICLO_SUPERATO', eventId: 0x3501, block: 'OB1', offset: 12 }),
      ],
      warnings: [{ code: 'SFC_NON_SIMULATA', block: 'OB1', message: 'x' }],
    });
    expect(screen.getByTestId('led-sf')).toHaveAttribute('data-on', 'true');
    const items = within(screen.getByTestId('cpu-diag')).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Tempo di ciclo massimo superato');
    expect(items[0]).toHaveTextContent('in OB1');
    expect(items[0]).toHaveTextContent('offset 12');
    expect(items[1]).toHaveTextContent('Avvio della CPU');
    expect(screen.getByTestId('cpu-warnings')).toHaveTextContent('SFC non simulata: OB1');
  });

  it.each(['OB_RICHIAMATO', 'SFC_NON_SIMULATA'] as const)(
    'SF spenta con %s in coda',
    async (code) => {
      await setup({ diagnostics: [entry({ code: 'BCD_NON_VALIDO' }), entry({ code })] });
      expect(screen.getByTestId('led-sf')).toHaveAttribute('data-on', 'false');
      expect(screen.getByTestId('led-sf')).toHaveAttribute('aria-label', 'SF: spento');
    },
  );

  it('SF spenta se l ultima voce non è un errore', async () => {
    await setup({
      diagnostics: [entry({ code: 'TEMPO_CICLO_SUPERATO' }), entry({ code: 'AVVIO' })],
    });
    expect(screen.getByTestId('led-sf')).toHaveAttribute('data-on', 'false');
  });
});

describe('stack di chiamata', () => {
  it('mostra lo stack dell ultimo errore e apre il blocco al clic', async () => {
    const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
    const ob = findDevice(app.store.getState().doc!.project, PLC)!.blocks.find(
      (b) => b.kind === 'OB',
    )!;
    act(() => app.store.getState().setTaskCard('test'));
    act(() =>
      app.store.getState().setSim({
        phase: 'on',
        deviceId: PLC,
        diagnostics: [
          entry({
            code: 'BCD_NON_VALIDO',
            stack: [
              { kind: 'FC', number: 99, offset: 4 },
              { kind: 'OB', number: ob.number, offset: 8 },
            ],
          }),
        ],
      }),
    );
    const list = within(screen.getByTestId('call-stack'));
    expect(list.getAllByRole('listitem')).toHaveLength(2);
    expect(list.queryByRole('button', { name: /FC99/ })).toBeNull(); // blocco assente: non cliccabile
    await app.user.click(list.getByRole('button', { name: new RegExp(`OB${ob.number}`) }));
    const eds = app.store.getState().workArea.editors;
    expect(eds.some((e) => JSON.stringify(e).includes(ob.id))).toBe(true);
  });

  it('l ultimo errore senza stack: non ricade su uno stack più vecchio', async () => {
    await setup({
      diagnostics: [
        entry({ code: 'BCD_NON_VALIDO', stack: [{ kind: 'OB', number: 1, offset: 0 }] }),
        entry({ code: 'TEMPO_CICLO_SUPERATO' }),
      ],
    });
    expect(screen.getByText('Nessuno stack di chiamata registrato.')).toBeInTheDocument();
    expect(screen.queryByTestId('call-stack')).toBeNull();
  });

  it('senza stack registrato lo dice', async () => {
    await setup();
    expect(screen.getByText('Nessuno stack di chiamata registrato.')).toBeInTheDocument();
  });
});
