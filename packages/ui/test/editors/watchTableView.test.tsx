import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addWatchTable, createWatchRow, findDevice } from '@baaportal/project';
import { SimController } from '../../src/sim/simController';
import { PLC, setupOnline } from '../online/downloadHelpers';
import type { RenderedApp } from '../renderApp';

afterEach(() => vi.restoreAllMocks());

async function openOnline(rows: [string, string, string?][]) {
  const { app } = await setupOnline([]);
  act(() => {
    app.store.getState().edit('history.addWatchTable', (p) => {
      const t = addWatchTable(findDevice(p, PLC)!, 'Prova', () => 'wt1');
      rows.forEach(([operand, format, modify], i) => {
        t.rows.push({
          ...createWatchRow(operand, format as never, () => `r${i + 1}`),
          ...(modify ? { modify } : {}),
        });
      });
    });
    app.store.getState().openEditor({ kind: 'watchTable', deviceId: PLC, objectId: 'wt1' });
  });
  await screen.findByTestId('watch-bar');
  return app;
}

const cell = (row: string, col: string) =>
  document.querySelector<HTMLElement>(`[data-row-key="${row}"] [data-col-id="${col}"]`)!;
const text = (c: HTMLElement) => document.getElementById(c.getAttribute('aria-describedby')!);
const click = (app: RenderedApp, name: string) =>
  app.user.click(screen.getByRole('button', { name }));

describe('tabella di controllo online', () => {
  it('«Osserva tutto» online: plcReadWatch con gli operandi, valori nel formato della riga', async () => {
    const app = await openOnline([
      ['%MW10', 'DEC'],
      ['%QW0', 'DEC'],
    ]);
    app.bridge.plcReadWatchImpl = (items) => ({
      ok: true,
      values: items.map(() => ({ bytes: Uint8Array.of(0, 42) })),
    });
    expect(screen.getByTestId('watch-bar')).toHaveTextContent('Osservazione spenta.');
    await click(app, 'Osserva tutto');
    await waitFor(() => expect(cell('r1', 'status')).toHaveTextContent('42'));
    expect(app.bridge.plcReadWatchCalls[0]).toEqual([
      { area: 'M', byte: 10, size: 'W' },
      { area: 'Q', byte: 0, size: 'W' },
    ]);
    await click(app, 'Osserva tutto'); // spenta: i valori spariscono
    expect(cell('r1', 'status')).toHaveTextContent('');
    const n = app.bridge.plcReadWatchCalls.length;
    await new Promise((r) => setTimeout(r, 700));
    expect(app.bridge.plcReadWatchCalls).toHaveLength(n);
  });

  it('PQW 0 → «non disponibile online»; non entra nella richiesta', async () => {
    const app = await openOnline([['PQW 0', 'DEC']]);
    expect(cell('r1', 'status')).toHaveTextContent('non disponibile online');
    expect(cell('r1', 'operand')).toHaveClass('is-error');
    expect(text(cell('r1', 'operand'))).toHaveTextContent('Non disponibile online');
    await click(app, 'Osserva tutto');
    await new Promise((r) => setTimeout(r, 50));
    expect(app.bridge.plcReadWatchCalls).toEqual([]);
  });

  it('PIW 0 in comando → errore di riga, nessuna scrittura', async () => {
    const app = await openOnline([['PIW 0', 'DEC', '5']]);
    await click(app, 'Comanda');
    await waitFor(() => expect(cell('r1', 'modify')).toHaveClass('is-error'));
    expect(text(cell('r1', 'modify'))).toHaveTextContent('solo osservare');
    expect(app.bridge.plcWriteVarsCalls).toEqual([]);
  });

  it('comando: invia i byte grezzi; esito parziale → errore sulla sola riga fallita', async () => {
    const app = await openOnline([
      ['%MW10', 'DEC', '42'],
      ['%MW12', 'DEC', '7'],
    ]);
    app.bridge.plcWriteVarsResults.push({
      ok: true,
      results: [{ ok: true }, { ok: false, error: 'accesso negato' }],
    });
    await click(app, 'Comanda');
    await waitFor(() => expect(cell('r2', 'modify')).toHaveClass('is-error'));
    expect(cell('r1', 'modify')).not.toHaveClass('is-error');
    expect(text(cell('r2', 'modify'))).toHaveTextContent('accesso negato');
    expect(app.bridge.plcWriteVarsCalls).toEqual([
      [
        { target: { area: 'M', byte: 10, size: 'W' }, data: Uint8Array.of(0, 42) },
        { target: { area: 'M', byte: 12, size: 'W' }, data: Uint8Array.of(0, 7) },
      ],
    ]);
    expect(screen.getByTestId('watch-bar')).toHaveTextContent(
      'Comando eseguito: 1 righe scritte, 1 con errore.',
    );
  });

  it('comando annullato → nessun messaggio, nessun errore', async () => {
    const app = await openOnline([['%MW10', 'DEC', '42']]);
    app.bridge.plcWriteVarsResults.push({ ok: false, cancelled: true });
    await click(app, 'Comanda');
    await waitFor(() => expect(app.bridge.plcWriteVarsCalls).toHaveLength(1));
    await act(async () => undefined);
    expect(screen.getByTestId('watch-bar')).not.toHaveTextContent('Comando eseguito');
    expect(cell('r1', 'modify')).not.toHaveClass('is-error');
  });

  it('simulazione attiva → la tabella usa il simulatore, nessuna chiamata al PLC', async () => {
    const app = await openOnline([['%MW10', 'DEC', '42']]);
    act(() => app.store.getState().setSim({ phase: 'on', deviceId: PLC }));
    const toggle = vi.spyOn(SimController.prototype, 'toggleWatch').mockImplementation(() => {});
    const command = vi.spyOn(SimController.prototype, 'commandWatch').mockResolvedValue({
      written: 1,
      errors: {},
    });
    await click(app, 'Osserva tutto');
    await click(app, 'Comanda');
    expect(toggle).toHaveBeenCalledWith(PLC, 'wt1');
    expect(command).toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 50));
    expect(app.bridge.plcReadWatchCalls).toEqual([]);
    expect(app.bridge.plcWriteVarsCalls).toEqual([]);
  });

  it('collegamento perso → osservazione ferma, valori svuotati', async () => {
    const app = await openOnline([['%MW10', 'DEC']]);
    await click(app, 'Osserva tutto');
    await waitFor(() => expect(cell('r1', 'status')).toHaveTextContent('0'));
    act(() => app.store.getState().setOnline({ status: 'off' }));
    await waitFor(() => expect(cell('r1', 'status')).toHaveTextContent(''));
    expect(screen.getByRole('button', { name: 'Osserva tutto' })).toBeDisabled();
    const n = app.bridge.plcReadWatchCalls.length;
    await new Promise((r) => setTimeout(r, 700));
    expect(app.bridge.plcReadWatchCalls).toHaveLength(n);
  });

  it('tabella chiusa → stop', async () => {
    const app = await openOnline([['%MW10', 'DEC']]);
    await click(app, 'Osserva tutto');
    await waitFor(() => expect(app.bridge.plcReadWatchCalls.length).toBeGreaterThan(0));
    act(() => {
      const st = app.store.getState();
      const key = st.workArea.panes[0]!;
      st.closeEditor(key);
    });
    await new Promise((r) => setTimeout(r, 50));
    const n = app.bridge.plcReadWatchCalls.length;
    await new Promise((r) => setTimeout(r, 700));
    expect(app.bridge.plcReadWatchCalls).toHaveLength(n);
  });
});
