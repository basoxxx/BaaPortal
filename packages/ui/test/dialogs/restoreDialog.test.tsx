import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { commands } from '../../src/commands/commands';
import { ONLINE_OFF } from '../../src/state/store';
import { initI18n } from '../../src/i18n';
import type { PlcRestorePlanResult, PlcRestoreResult } from '../../src/online/plcTypes';
import { DEFAULT_SETTINGS, saveSettings, updateSettings } from '../../src/settings/settings';
import { ctx, setupOnline } from '../online/downloadHelpers';

afterEach(async () => {
  saveSettings(DEFAULT_SETTINGS);
  await initI18n('it');
});

const PLAN: Extract<PlcRestorePlanResult, { ok: true }> = {
  ok: true,
  token: 'tok1',
  warnings: [],
  rows: [
    { name: 'SDB 1', action: 'load' },
    { name: 'SDB 0', action: 'load' },
    { name: 'OB1', action: 'load' },
    { name: 'SDB 2', action: 'skip', why: 'creato dalla CPU' },
    { name: 'FC9', action: 'keep' },
  ],
};

async function open(plan: PlcRestorePlanResult = PLAN) {
  const { app } = await setupOnline([]);
  updateSettings({ online: { experimental: true } });
  app.bridge.plcRestorePlanImpl = () => plan;
  await act(async () => {
    await commands['online.restore'].run(ctx(app));
  });
  await screen.findByTestId('restore-dialog');
  return app;
}
const choose = async () => {
  fireEvent.click(screen.getByTestId('restore-choose'));
  await screen.findByTestId('restore-table');
};
const run = async () => {
  await act(async () => {
    fireEvent.click(screen.getByTestId('restore-run'));
  });
};

describe('finestra di ripristino', () => {
  it('righe SDB 2 «Saltato: creato dalla CPU» e FC9 «Resta nella CPU»; avvisi fissi', async () => {
    await open();
    await choose();
    const rows = screen.getByTestId('restore-table').textContent!;
    expect(rows).toContain('Saltato: creato dalla CPU');
    expect(rows).toContain('Resta nella CPU');
    const w = screen.getByTestId('restore-warnings').textContent!;
    expect(w).toContain('Funzione sperimentale, mai provata su una CPU reale');
    expect(w).toContain('La CPU andrà in STOP');
    expect(w).toContain(
      'I DB tornano ai valori salvati nel backup; merker, temporizzatori e contatori no',
    );
    expect(w).not.toContain('CPU diversa');
  });

  it('STOP inviato ma non confermato → avviso dedicato, diverso da «CPU lasciata in STOP»', async () => {
    const app = await open();
    await choose();
    app.bridge.plcRestoreImpl = () => ({
      ok: false,
      error: 'STOP inviato ma non confermato',
      cpuStopped: false,
      stopUnconfirmed: true,
      rows: [],
    });
    await run();
    await waitFor(() => screen.getByTestId('restore-result'));
    expect(screen.getByTestId('restore-stop-unconfirmed').textContent).toContain(
      'non lo ha confermato',
    );
    expect(screen.getByTestId('restore-result').textContent).not.toContain('CPU lasciata in STOP');
    expect(screen.getByTestId('restore-result').textContent).not.toContain('Nessuna modifica');
  });

  it('Avvia la CPU spenta per default → plcRestore con restart false; con la casella, true', async () => {
    const app = await open();
    await choose();
    const box = screen.getByTestId('restore-restart') as HTMLInputElement;
    expect(box.checked).toBe(false);
    app.bridge.plcRestoreImpl = () => ({ ok: true, rows: [], cpuStopped: false });
    await run();
    expect(app.bridge.plcRestoreCalls).toEqual([{ token: 'tok1', restart: false }]);
  });

  it('casella accesa → restart true', async () => {
    const app = await open();
    await choose();
    fireEvent.click(screen.getByTestId('restore-restart'));
    app.bridge.plcRestoreImpl = () => ({ ok: true, rows: [], cpuStopped: false });
    await run();
    expect(app.bridge.plcRestoreCalls).toEqual([{ token: 'tok1', restart: true }]);
  });

  it('esito con SDB 1 unknown e il resto notDone → testi, «CPU lasciata in STOP» con «Avvia CPU»', async () => {
    const app = await open();
    await choose();
    const res: PlcRestoreResult = {
      ok: false,
      error: 'SDB 1: Esito sconosciuto',
      cpuStopped: true,
      rows: [
        { name: 'SDB 1', outcome: 'unknown', error: 'Esito sconosciuto' },
        { name: 'SDB 0', outcome: 'notDone', error: 'Non caricato' },
        { name: 'OB1', outcome: 'notDone', error: 'Non caricato' },
      ],
    };
    app.bridge.plcRestoreImpl = () => res;
    await run();
    const t = screen.getByTestId('restore-table').textContent!;
    expect(t).toContain('Esito sconosciuto');
    expect(t).toContain('Non caricato');
    const r = screen.getByTestId('restore-result');
    expect(r.textContent).toContain('CPU lasciata in STOP');
    // «Avvia CPU» usa il comando del 3B (con la sua conferma nativa)
    fireEvent.click(screen.getByTestId('restore-start-cpu'));
    await waitFor(() => expect(app.bridge.plcControlCalls).toContain('RUN'));
  });

  it('collegamento perso durante il ripristino: l’esito resta visibile, senza «Avvia CPU»', async () => {
    const app = await open();
    await choose();
    app.bridge.plcRestoreImpl = () => {
      app.store.getState().setOnline(ONLINE_OFF);
      return {
        ok: false,
        error: 'SDB 1: Esito sconosciuto',
        cpuStopped: true,
        rows: [{ name: 'SDB 1', outcome: 'unknown', error: 'Esito sconosciuto' }],
      };
    };
    await run();
    expect(await screen.findByTestId('restore-result')).toBeTruthy();
    expect(screen.getByTestId('restore-result').textContent).toContain('CPU lasciata in STOP');
    expect(screen.queryByTestId('restore-start-cpu')).toBeNull();
    expect(screen.getByTestId('restore-dialog')).toBeTruthy();
  });

  it('esiti: Caricato per tutti, rifiuto con il motivo', async () => {
    const app = await open();
    await choose();
    app.bridge.plcRestoreImpl = () => ({
      ok: false,
      cpuStopped: true,
      error: 'x',
      rows: [
        { name: 'SDB 1', outcome: 'loaded' },
        { name: 'OB1', outcome: 'rejected', error: 'Rifiutato dalla CPU: D241' },
      ],
    });
    await run();
    const t = screen.getByTestId('restore-table').textContent!;
    expect(t).toContain('Caricato');
    expect(t).toContain('Rifiutato dalla CPU: D241');
  });

  it('conferma annullata → nessun messaggio, finestra aperta, si può scegliere di nuovo', async () => {
    const app = await open();
    await choose();
    const n = app.store.getState().messages.length;
    app.bridge.plcRestoreImpl = () => ({ ok: false, cancelled: true, rows: [], cpuStopped: false });
    await run();
    expect(screen.getByTestId('restore-dialog')).toBeTruthy();
    expect(screen.queryByTestId('restore-result')).toBeNull();
    expect(screen.queryByTestId('restore-error')).toBeNull();
    expect(app.store.getState().messages.length).toBe(n);
    expect(screen.getByTestId('restore-choose')).toBeTruthy();
  });

  it('rifiuto per FRCE → messaggio e «Nessuna modifica alla CPU»', async () => {
    await open({ ok: false, error: 'Forzamento attivo sulla CPU: terminarlo con TIA o STEP 7' });
    fireEvent.click(screen.getByTestId('restore-choose'));
    const e = await screen.findByTestId('restore-error');
    expect(e.textContent).toContain('Forzamento attivo sulla CPU');
    expect(e.textContent).toContain('Nessuna modifica alla CPU');
  });

  it('file annullato → nessun errore', async () => {
    await open({ ok: false, cancelled: true });
    fireEvent.click(screen.getByTestId('restore-choose'));
    await waitFor(() =>
      expect((screen.getByTestId('restore-choose') as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.queryByTestId('restore-error')).toBeNull();
  });

  it('dopo l’esito → confronto online rilanciato', async () => {
    const app = await open();
    await choose();
    const before = app.bridge.plcBlocksCalls;
    app.bridge.plcRestoreImpl = () => ({
      ok: true,
      cpuStopped: true,
      rows: [{ name: 'OB1', outcome: 'loaded' }],
    });
    await run();
    await waitFor(() => expect(app.bridge.plcBlocksCalls).toBeGreaterThan(before));
  });

  it('Interrompi nella barra di stato → plcRestoreInterrupt', async () => {
    const app = await open();
    await choose();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = app.bridge.plcRestore.bind(app.bridge);
    app.bridge.plcRestore = async (req) => {
      await gate;
      return orig(req);
    };
    app.bridge.plcRestoreImpl = () => ({ ok: false, cancelled: true, rows: [], cpuStopped: false });
    await run();
    fireEvent.click(await screen.findByRole('button', { name: 'Interrompi' }));
    expect(app.bridge.plcRestoreInterruptCalls).toBe(1);
    await act(async () => release());
  });

  it('en: titoli e azioni in inglese', async () => {
    await open();
    await act(async () => {
      await initI18n('en');
    });
    expect(screen.getByTestId('restore-dialog').textContent).toContain(
      'Restore backup to device (experimental)',
    );
    fireEvent.click(screen.getByTestId('restore-choose'));
    await screen.findByTestId('restore-table');
    const t = screen.getByTestId('restore-table').textContent!;
    expect(t).toContain('Skipped: created by the CPU');
    expect(t).toContain('Stays in the CPU');
    expect(t).toContain('Load');
  });
});
