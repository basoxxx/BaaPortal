import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { initI18n } from '../../src/i18n';
import type { DiagEventView, DiagPart, PlcDiagData } from '../../src/online/plcTypes';
import { commands } from '../../src/commands/commands';
import { PLC, setupOnline } from '../online/downloadHelpers';
import { renderApp } from '../renderApp';

const T = { year: 2026, month: 3, day: 4, hour: 5, minute: 6, second: 7, ms: 0 };
const ev = (over: Partial<DiagEventView>): DiagEventView => ({
  eventId: 0x4302,
  priority: 0x1c,
  obNumber: 0x68,
  datId: 0x1234,
  info1: 0x00ff,
  info2: 0x0000abcd,
  time: T,
  ...over,
});

const DATA: PlcDiagData = {
  identity: {
    ok: true,
    value: { orderNumber: '6ES7 315-2EH14-0AB0', moduleName: 'CPU 315-2 PN/DP' },
  },
  mode: { ok: true, value: 'RUN' },
  leds: { ok: true, value: [{ id: 4, name: 'RUN', on: true, blink: 'none' }] },
  protection: { ok: true, value: { validLevel: 1, modeSwitch: 'RUN' } },
  lastModeChange: { ok: true, value: ev({}) },
  cycle: {
    ok: true,
    value: { time: { lastMs: 4, minMs: 2, maxMs: 9 }, config: { minMs: 0, maxMs: 150 } },
  },
  memory: {
    ok: true,
    value: [{ index: 1, kind: 'work', size: 1000, used: 250, free: 750 }],
  },
  buffer: { ok: true, value: [ev({}), ev({ eventId: 0x5f01, time: undefined, rawTime: '0a0b' })] },
  clock: { ok: true, value: T },
};

async function open(over: Partial<Record<DiagPart, PlcDiagData[DiagPart]>> = {}) {
  const r = await setupOnline([]);
  r.app.bridge.plcDiagnosticsImpl = (parts) => ({
    ok: true,
    data: Object.fromEntries(parts.map((p) => [p, (over as never)[p] ?? DATA[p]])),
  });
  act(() => r.app.store.getState().openEditor({ kind: 'onlineDiag', deviceId: PLC, objectId: '' }));
  await screen.findByTestId('diag-view');
  return r.app;
}

const page = (p: string) => fireEvent.click(screen.getByTestId(`diag-page-${p}`));

afterEach(async () => {
  await initI18n('it');
});

describe('editor Online e diagnostica', () => {
  it('Generale con modo e LED', async () => {
    await open();
    expect(await screen.findByTestId('diag-mode')).toHaveTextContent('RUN');
    expect(await screen.findByTestId('diag-led-RUN')).toHaveAttribute('data-on', 'true');
    expect(await screen.findByText('6ES7 315-2EH14-0AB0')).toBeInTheDocument();
  });

  it('memoria non disponibile: testo al suo posto, Generale aggiornata', async () => {
    await open({ memory: { ok: false, unavailable: true } });
    await screen.findByText('6ES7 315-2EH14-0AB0');
    page('memory');
    expect(await screen.findByTestId('diag-unavailable')).toHaveTextContent(
      'non disponibile su questa CPU',
    );
  });

  it('un error mostra il messaggio nella sezione', async () => {
    await open({ cycle: { ok: false, error: 'Lettura troppo lunga' } });
    page('cycle');
    expect(await screen.findByTestId('diag-part-error')).toHaveTextContent('Lettura troppo lunga');
  });

  it('buffer: 0x4302 con il cambio di modo nei dettagli', async () => {
    await open();
    page('buffer');
    const row = await screen.findByTestId('diag-row-0');
    expect(row).toHaveTextContent('passaggio da AVVIAMENTO a RUN');
    expect(row).toHaveTextContent('04/03/2026 05:06:07');
    fireEvent.click(row);
    const d = screen.getByTestId('diag-details');
    expect(d).toHaveTextContent('0x4302');
    expect(d).toHaveTextContent('da avviamento a RUN');
    expect(d).toHaveTextContent('0x1234');
    expect(screen.queryByTestId('diag-generic-note')).toBeNull();
  });

  it('buffer: ID sconosciuto 0x5F01 con testo generico, nota e ora in esadecimale', async () => {
    await open();
    page('buffer');
    const row = await screen.findByTestId('diag-row-1');
    expect(row).toHaveTextContent('0A 0B');
    fireEvent.click(row);
    expect(screen.getByTestId('diag-generic-note')).toHaveTextContent(
      'Evento non in tabella: descrizione generica',
    );
    expect(screen.getByTestId('diag-details')).toHaveTextContent('0x00FF');
    expect(screen.getByTestId('diag-details')).toHaveTextContent('0x0000ABCD');
  });

  it('Blocca visualizzazione: la lista non cambia, il resto sì', async () => {
    const app = await open();
    page('buffer');
    await screen.findByTestId('diag-row-0');
    fireEvent.click(screen.getByTestId('diag-freeze'));
    app.bridge.plcDiagnosticsImpl = (parts) => ({
      ok: true,
      data: {
        mode: { ok: true, value: 'STOP' },
        ...(parts.includes('buffer') ? { buffer: { ok: true, value: [] } } : {}),
      },
    });
    page('cycle');
    await waitFor(() => expect(screen.getByTestId('diag-mode')).toHaveTextContent('STOP'));
    page('buffer');
    expect(screen.getByTestId('diag-row-0')).toBeInTheDocument();
    expect(app.bridge.plcDiagnosticsCalls.at(-1)).not.toContain('buffer');
  });

  it('tempo di ciclo e memoria', async () => {
    await open();
    page('cycle');
    expect(await screen.findByTestId('cycle-last')).toHaveTextContent('4 ms');
    expect(screen.getByTestId('cycle-watchdog')).toHaveTextContent('150 ms');
    page('memory');
    expect(await screen.findByText('25 %')).toBeInTheDocument();
  });

  it("Imposta all'ora del PC chiama plcSetClock({ source: 'pc' }) e rilegge l'ora", async () => {
    const app = await open();
    page('clock');
    await screen.findByTestId('clock-cpu');
    const before = app.bridge.plcDiagnosticsCalls.length;
    fireEvent.click(screen.getByTestId('clock-set-pc'));
    await waitFor(() => expect(app.bridge.plcClockCalls).toEqual([{ source: 'pc' }]));
    await waitFor(() => expect(app.bridge.plcDiagnosticsCalls.length).toBeGreaterThan(before));
  });

  it('ora a mano 2026-02-30: errore sul campo e nessuna chiamata', async () => {
    const app = await open();
    page('clock');
    await screen.findByTestId('clock-cpu');
    fireEvent.change(screen.getByTestId('clock-date'), { target: { value: '2026-02-30' } });
    fireEvent.change(screen.getByTestId('clock-time'), { target: { value: '10:00:00' } });
    fireEvent.click(screen.getByTestId('clock-apply'));
    expect(screen.getByTestId('clock-field-error')).toHaveTextContent('non esiste');
    expect(screen.getByTestId('clock-date')).toHaveAttribute('aria-invalid', 'true');
    expect(app.bridge.plcClockCalls).toEqual([]);
  });

  it('ora a mano valida: la richiesta parte', async () => {
    const app = await open();
    page('clock');
    await screen.findByTestId('clock-cpu');
    fireEvent.change(screen.getByTestId('clock-date'), { target: { value: '2026-02-27' } });
    fireEvent.change(screen.getByTestId('clock-time'), { target: { value: '10:11:12' } });
    fireEvent.click(screen.getByTestId('clock-apply'));
    await waitFor(() =>
      expect(app.bridge.plcClockCalls).toEqual([
        {
          source: 'manual',
          time: { year: 2026, month: 2, day: 27, hour: 10, minute: 11, second: 12 },
        },
      ]),
    );
  });

  it('conferma annullata: nessun messaggio; un errore sì', async () => {
    const app = await open();
    page('clock');
    await screen.findByTestId('clock-cpu');
    app.bridge.plcClockResults.push({ ok: false, cancelled: true });
    fireEvent.click(screen.getByTestId('clock-set-pc'));
    await waitFor(() => expect(app.bridge.plcClockCalls).toHaveLength(1));
    expect(screen.queryByTestId('clock-error')).toBeNull();
    app.bridge.plcClockResults.push({ ok: false, error: 'La CPU ha rifiutato' });
    fireEvent.click(screen.getByTestId('clock-set-pc'));
    expect(await screen.findByTestId('clock-error')).toHaveTextContent('La CPU ha rifiutato');
  });

  it('offline: invito al collegamento', async () => {
    const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
    await act(async () => {
      await app.service.open('/doc/BaaPortal/Linea 3.baap');
    });
    act(() => app.store.getState().openEditor({ kind: 'onlineDiag', deviceId: PLC, objectId: '' }));
    expect(await screen.findByText('Collegamento online necessario')).toBeInTheDocument();
    expect(screen.getByTestId('diag-go-online')).toHaveTextContent('Collegamento online');
  });

  it('simulazione attiva: rimando al Pannello di comando CPU', async () => {
    const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
    await act(async () => {
      await app.service.open('/doc/BaaPortal/Linea 3.baap');
    });
    act(() => app.store.getState().setSim({ phase: 'on' }));
    act(() => app.store.getState().openEditor({ kind: 'onlineDiag', deviceId: PLC, objectId: '' }));
    expect(await screen.findByTestId('diag-sim-hint')).toHaveTextContent('Pannello di comando CPU');
    expect(screen.queryByTestId('diag-go-online')).toBeNull();
  });

  it('comando online.diagnostics apre l editor con una CPU nel progetto', async () => {
    const app = await renderApp({ view: 'project', withProject: true, withPlc: true });
    await act(async () => {
      await app.service.open('/doc/BaaPortal/Linea 3.baap');
    });
    expect(commands['online.diagnostics'].isEnabled(app.store.getState())).toBe(true);
    act(() => {
      void commands['online.diagnostics'].run({
        store: app.store,
        service: app.service,
        bridge: app.bridge,
      });
    });
    expect(app.store.getState().workArea.editors.map((e) => e.kind)).toContain('onlineDiag');
  });

  it('en: titoli delle pagine e testo di 0x4304 in inglese', async () => {
    await open({ buffer: { ok: true, value: [ev({ eventId: 0x4304 })] } });
    await act(async () => {
      await initI18n('en');
    });
    expect(screen.getByTestId('diag-page-buffer')).toHaveTextContent('Diagnostic buffer');
    expect(screen.getByTestId('diag-page-cycle')).toHaveTextContent('Cycle time');
    page('buffer');
    expect(await screen.findByTestId('diag-row-0')).toHaveTextContent('STOP from the PG or SFB 20');
  });
});
