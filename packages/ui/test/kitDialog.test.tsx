import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { KitSummary } from '../src/bridge';
import { renderApp } from './renderApp';

const SUMMARY: KitSummary = {
  identity: { orderNumber: '6ES7 315-2EH14-0AB0', moduleName: 'CPU 315-2 PN/DP' },
  mode: 'RUN',
  szlRead: 42,
  blocksListed: 12,
  blocksUploaded: 10,
  refusedCount: 0,
  errors: [{ step: 'upload DB7', code: 'S7_ERROR', message: 'blocco non disponibile' }],
};

const openViaMenu = async (user: Awaited<ReturnType<typeof renderApp>>['user']) => {
  await user.click(screen.getByRole('menuitem', { name: 'Strumenti' }));
  await user.click(screen.getByRole('menuitem', { name: 'Raccolta dati CPU (sola lettura)…' }));
  return screen.getByRole('dialog', { name: 'Raccolta dati CPU (sola lettura)' });
};

describe('Raccolta dati CPU: finestra', () => {
  it("la voce di menu è attiva anche senza progetto aperto; dal portale c'è un'operazione dedicata", async () => {
    const { user, store } = await renderApp({ view: 'portal' });
    await user.click(screen.getByTestId('action-collectCpu'));
    expect(screen.getByRole('dialog', { name: 'Raccolta dati CPU (sola lettura)' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Annulla' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    store.getState().setView('project');
    await user.click(await screen.findByRole('menuitem', { name: 'Strumenti' }));
    expect(
      screen.getByRole('menuitem', { name: 'Raccolta dati CPU (sola lettura)…' }),
    ).not.toHaveAttribute('aria-disabled', 'true');
  });

  it("valida l'IP e mostra il testo di sola lettura", async () => {
    const { user, bridge } = await renderApp({ view: 'project' });
    const dlg = await openViaMenu(user);
    expect(
      within(dlg).getByText(
        'Questa funzione legge soltanto: non scrive nulla nel PLC e non cambia il suo stato. Usala a macchina ferma o non critica.',
      ),
    ).toBeInTheDocument();
    const start = within(dlg).getByRole('button', { name: 'Avvia' });
    expect(start).toBeDisabled(); // IP vuoto
    const ip = within(dlg).getByLabelText('Indirizzo IP');
    for (const bad of ['300.1.1.1', '1.2.3', 'a b', '-x', '192.168.0.1.5']) {
      await user.clear(ip);
      await user.type(ip, bad);
      expect(start).toBeDisabled();
      expect(within(dlg).getByRole('alert')).toBeInTheDocument();
    }
    for (const good of ['192.168.0.10', 'plc-1.officina.local']) {
      await user.clear(ip);
      await user.type(ip, good);
      expect(start).toBeEnabled();
    }
    // valori predefiniti delle opzioni avanzate
    expect(within(dlg).getByLabelText('Porta')).toHaveValue(102);
    expect(within(dlg).getByLabelText('Rack')).toHaveValue(0);
    expect(within(dlg).getByLabelText('Slot')).toHaveValue(2);
    expect(within(dlg).getByLabelText('Tipo di connessione')).toHaveValue('pg');
    expect(within(dlg).getByLabelText('Carica anche i blocchi dal PLC')).toBeChecked();
    // una porta fuori campo blocca Avvia
    const port = within(dlg).getByLabelText('Porta');
    await user.clear(port);
    await user.type(port, '70000');
    expect(start).toBeDisabled();
    expect(bridge.kitStartCalls).toEqual([]);
  });

  it('Avvia chiama startKit con gli argomenti giusti', async () => {
    const { user, bridge } = await renderApp({ view: 'project' });
    bridge.kitResults.push({ ok: true, savedTo: '/tmp/a.zip', summary: SUMMARY });
    const dlg = await openViaMenu(user);
    await user.type(within(dlg).getByLabelText('Indirizzo IP'), ' 10.0.0.5 ');
    const slot = within(dlg).getByLabelText('Slot');
    await user.clear(slot);
    await user.type(slot, '4');
    await user.selectOptions(within(dlg).getByLabelText('Tipo di connessione'), 'op');
    await user.click(within(dlg).getByLabelText('Carica anche i blocchi dal PLC'));
    await user.click(within(dlg).getByRole('button', { name: 'Avvia' }));
    expect(bridge.kitStartCalls).toEqual([
      {
        host: '10.0.0.5',
        port: 102,
        rack: 0,
        slot: 4,
        connectionType: 'op',
        includeBlocks: false,
      },
    ]);
  });

  it('un IPv4 con zeri iniziali parte in forma canonica e il riepilogo mostra quella', async () => {
    const { user, bridge } = await renderApp({ view: 'project' });
    bridge.kitResults.push({
      ok: true,
      savedTo: '/tmp/a.zip',
      summary: { ...SUMMARY, host: '192.168.0.10' },
    });
    const dlg = await openViaMenu(user);
    await user.type(within(dlg).getByLabelText('Indirizzo IP'), '192.168.000.010');
    expect(within(dlg).getByRole('button', { name: 'Avvia' })).toBeEnabled();
    await user.click(within(dlg).getByRole('button', { name: 'Avvia' }));
    expect(bridge.kitStartCalls[0]!.host).toBe('192.168.0.10');
    expect(await within(dlg).findByTestId('kit-summary')).toHaveTextContent('192.168.0.10');
  });

  it('un contatore 0 / 0 non si mostra', async () => {
    const { user, bridge } = await renderApp({ view: 'project' });
    const release = bridge.holdKit();
    bridge.kitResults.push({ ok: true, savedTo: null, summary: SUMMARY });
    const dlg = await openViaMenu(user);
    await user.type(within(dlg).getByLabelText('Indirizzo IP'), '10.0.0.5');
    await user.click(within(dlg).getByRole('button', { name: 'Avvia' }));
    await bridge.emitKitProgress({ phase: 'blocks', done: 0, total: 0, message: 'Elenco DB' });
    const progress = within(dlg).getByTestId('kit-progress');
    expect(progress).toHaveTextContent('Elenco dei blocchi');
    expect(progress).not.toHaveTextContent('0 / 0');
    release();
    await within(dlg).findByTestId('kit-summary');
    dlg.focus();
    await user.keyboard('{Escape}');
  });

  it('avanzamento e Interrompi passano dal bridge', async () => {
    const { user, bridge } = await renderApp({ view: 'project' });
    const release = bridge.holdKit();
    bridge.kitResults.push({ ok: true, savedTo: null, summary: SUMMARY });
    const dlg = await openViaMenu(user);
    await user.type(within(dlg).getByLabelText('Indirizzo IP'), '10.0.0.5');
    await user.click(within(dlg).getByRole('button', { name: 'Avvia' }));
    expect(within(dlg).getByRole('button', { name: 'Annulla' })).toBeDisabled();
    expect(within(dlg).queryByRole('button', { name: 'Avvia' })).not.toBeInTheDocument();
    await bridge.emitKitProgress({
      phase: 'szl',
      done: 3,
      total: 10,
      message: 'SZL 0x0011',
    });
    const progress = within(dlg).getByTestId('kit-progress');
    expect(progress).toHaveTextContent('Liste di sistema (SZL)');
    expect(progress).toHaveTextContent('3 / 10');
    expect(progress).toHaveTextContent('SZL 0x0011');
    await user.click(within(dlg).getByRole('button', { name: 'Interrompi' }));
    expect(bridge.kitCancelCalls).toBe(1);
    release();
    await within(dlg).findByTestId('kit-summary');
    expect(bridge.listenerCount).toBe(3); // 2 di base + l'avanzamento, finché la finestra è aperta
    bridge.confirmAnswers.push('discard'); // raccolta non salvata: la chiusura chiede conferma
    await user.click(within(dlg).getByRole('button', { name: 'Chiudi' }));
    expect(bridge.listenerCount).toBe(2);
  });

  it('mostra il riepilogo e salva di nuovo con "Salva…"', async () => {
    const { user, bridge } = await renderApp({ view: 'project' });
    bridge.kitResults.push({ ok: true, savedTo: null, summary: SUMMARY });
    bridge.kitSaveResults.push('/home/amico/raccolta.zip');
    const dlg = await openViaMenu(user);
    await user.type(within(dlg).getByLabelText('Indirizzo IP'), '10.0.0.5');
    await user.click(within(dlg).getByRole('button', { name: 'Avvia' }));
    const summary = await within(dlg).findByTestId('kit-summary');
    expect(summary).toHaveTextContent('6ES7 315-2EH14-0AB0');
    expect(summary).toHaveTextContent('CPU 315-2 PN/DP');
    expect(summary).toHaveTextContent('RUN');
    expect(summary).toHaveTextContent('42');
    expect(summary).toHaveTextContent('12');
    expect(summary).toHaveTextContent('10');
    expect(within(dlg).getByText('Errori: 1')).toBeInTheDocument();
    expect(summary).toHaveTextContent('upload DB7');
    expect(summary).toHaveTextContent('blocco non disponibile');
    expect(within(dlg).getByTestId('kit-saved')).toHaveTextContent('non salvato');
    await user.click(within(dlg).getByRole('button', { name: 'Salva…' }));
    expect(bridge.kitSaveCalls).toBe(1);
    expect(await within(dlg).findByTestId('kit-saved')).toHaveTextContent(
      '/home/amico/raccolta.zip',
    );
    expect(within(dlg).queryByRole('button', { name: 'Salva…' })).not.toBeInTheDocument();
  });

  it('un errore della raccolta si legge nella finestra e si può riprovare', async () => {
    const { user, bridge } = await renderApp({ view: 'project' });
    bridge.kitResults.push({ ok: false, error: 'Una raccolta è già in corso.' });
    const dlg = await openViaMenu(user);
    await user.type(within(dlg).getByLabelText('Indirizzo IP'), '10.0.0.5');
    await user.click(within(dlg).getByRole('button', { name: 'Avvia' }));
    expect(await within(dlg).findByRole('alert')).toHaveTextContent('Una raccolta è già in corso.');
    expect(within(dlg).getByRole('button', { name: 'Avvia' })).toBeEnabled();
  });

  it('se il salvataggio automatico fallisce, la finestra mostra il motivo e offre Salva…', async () => {
    const { user, bridge } = await renderApp({ view: 'project' });
    bridge.kitResults.push({
      ok: true,
      savedTo: null,
      summary: SUMMARY,
      saveError: 'EACCES: permesso negato',
    });
    const dlg = await openViaMenu(user);
    await user.type(within(dlg).getByLabelText('Indirizzo IP'), '10.0.0.5');
    await user.click(within(dlg).getByRole('button', { name: 'Avvia' }));
    expect(await within(dlg).findByTestId('kit-saved')).toHaveTextContent(
      'Salvataggio non riuscito: EACCES: permesso negato. Usa «Salva…» per riprovare.',
    );
    expect(within(dlg).getByRole('button', { name: 'Salva…' })).toBeInTheDocument();
  });

  describe('raccolta finita e non salvata', () => {
    const finish = async (
      ctx: Awaited<ReturnType<typeof renderApp>>,
      summary: KitSummary = SUMMARY,
    ) => {
      ctx.bridge.kitResults.push({ ok: true, savedTo: null, summary });
      const dlg = await openViaMenu(ctx.user);
      await ctx.user.type(within(dlg).getByLabelText('Indirizzo IP'), '10.0.0.5');
      await ctx.user.click(within(dlg).getByRole('button', { name: 'Avvia' }));
      await within(dlg).findByTestId('kit-summary');
      return dlg;
    };

    it('Esc chiede conferma; "Chiudi senza salvare" chiude', async () => {
      const ctx = await renderApp({ view: 'project' });
      const { user, bridge } = ctx;
      const dlg = await finish(ctx);
      bridge.confirmAnswers.push('discard');
      dlg.focus();
      await user.keyboard('{Escape}');
      expect(bridge.confirmTexts).toHaveLength(1);
      expect(bridge.confirmTexts[0]).toEqual({
        title: 'Raccolta non salvata',
        message: 'Chiudere senza salvare la raccolta? I dati raccolti andranno persi.',
        yes: 'Salva…',
        no: 'Chiudi senza salvare',
        cancel: 'Annulla',
      });
      expect(dlg).not.toBeInTheDocument();
      expect(bridge.kitSaveCalls).toBe(0);
    });

    it('"Chiudi" chiede conferma; "Annulla" lascia la finestra aperta', async () => {
      const ctx = await renderApp({ view: 'project' });
      const { user, bridge } = ctx;
      const dlg = await finish(ctx);
      bridge.confirmAnswers.push('cancel');
      await user.click(within(dlg).getByRole('button', { name: 'Chiudi' }));
      expect(bridge.confirmTexts).toHaveLength(1);
      expect(dlg).toBeInTheDocument();
      expect(within(dlg).getByTestId('kit-summary')).toBeInTheDocument();
    });

    it('"Salva…" nella conferma salva e, se il file è scritto, chiude', async () => {
      const ctx = await renderApp({ view: 'project' });
      const { user, bridge } = ctx;
      const dlg = await finish(ctx);
      bridge.confirmAnswers.push('save');
      bridge.kitSaveResults.push('/tmp/k.zip');
      dlg.focus();
      await user.keyboard('{Escape}');
      expect(bridge.kitSaveCalls).toBe(1);
      expect(dlg).not.toBeInTheDocument();
    });

    it('"Salva…" nella conferma con salvataggio annullato lascia la finestra aperta', async () => {
      const ctx = await renderApp({ view: 'project' });
      const { user, bridge } = ctx;
      const dlg = await finish(ctx);
      bridge.confirmAnswers.push('save');
      bridge.kitSaveResults.push(null);
      dlg.focus();
      await user.keyboard('{Escape}');
      expect(bridge.kitSaveCalls).toBe(1);
      expect(dlg).toBeInTheDocument();
    });

    it('dopo il salvataggio chiude senza chiedere nulla', async () => {
      const ctx = await renderApp({ view: 'project' });
      const { user, bridge } = ctx;
      const dlg = await finish(ctx);
      bridge.kitSaveResults.push('/tmp/k.zip');
      await user.click(within(dlg).getByRole('button', { name: 'Salva…' }));
      await within(dlg).findByText(/Salvato in/);
      dlg.focus();
      await user.keyboard('{Escape}');
      expect(bridge.confirmTexts).toHaveLength(0);
      expect(dlg).not.toBeInTheDocument();
    });

    it('riaprendo la finestra con una raccolta non salvata si vede il suo riepilogo, con Salva… e Nuova raccolta', async () => {
      const { user, bridge } = await renderApp({ view: 'project' });
      bridge.kitUnsaved = SUMMARY;
      bridge.kitSaveResults.push('/tmp/k.zip');
      const dlg = await openViaMenu(user);
      const summary = await within(dlg).findByTestId('kit-summary');
      expect(summary).toHaveTextContent('6ES7 315-2EH14-0AB0');
      expect(within(dlg).queryByLabelText('Indirizzo IP')).not.toBeInTheDocument();
      expect(within(dlg).getByTestId('kit-saved')).toHaveTextContent('non salvato');
      await user.click(within(dlg).getByRole('button', { name: 'Salva…' }));
      expect(bridge.kitSaveCalls).toBe(1);
      expect(await within(dlg).findByTestId('kit-saved')).toHaveTextContent('/tmp/k.zip');
    });

    it('"Nuova raccolta" chiede conferma e riporta al modulo', async () => {
      const { user, bridge } = await renderApp({ view: 'project' });
      bridge.kitUnsaved = SUMMARY;
      const dlg = await openViaMenu(user);
      await within(dlg).findByTestId('kit-summary');
      bridge.confirmAnswers.push('discard');
      await user.click(within(dlg).getByRole('button', { name: 'Nuova raccolta' }));
      expect(bridge.confirmTexts).toHaveLength(1);
      expect(within(dlg).getByLabelText('Indirizzo IP')).toBeInTheDocument();
      expect(within(dlg).queryByTestId('kit-summary')).not.toBeInTheDocument();
    });

    it('senza raccolta in sospeso la finestra si apre sul modulo', async () => {
      const { user } = await renderApp({ view: 'project' });
      const dlg = await openViaMenu(user);
      expect(within(dlg).getByLabelText('Indirizzo IP')).toBeInTheDocument();
      expect(within(dlg).queryByTestId('kit-summary')).not.toBeInTheDocument();
    });
  });

  describe('CPU protetta', () => {
    const HINT =
      'CPU protetta: i blocchi non si possono caricare senza password. Manda comunque lo zip: contiene il resto dei dati.';
    const run = async (summary: KitSummary) => {
      const { user, bridge } = await renderApp({ view: 'project' });
      bridge.kitResults.push({ ok: true, savedTo: '/tmp/a.zip', summary });
      const dlg = await openViaMenu(user);
      await user.type(within(dlg).getByLabelText('Indirizzo IP'), '10.0.0.5');
      await user.click(within(dlg).getByRole('button', { name: 'Avvia' }));
      return within(dlg).findByTestId('kit-summary');
    };
    const denied = (n: number) => ({
      step: `upload DB${n}`,
      code: 'CPU_ERROR',
      message: `upload DB${n}: classe 0xd2 codice 0x41 (funzione protetta)`,
    });

    it('tutti gli upload rifiutati con 0xD241: suggerimento', async () => {
      const s = await run({
        ...SUMMARY,
        blocksListed: 2,
        blocksUploaded: 0,
        errors: [denied(1), denied(2)],
      });
      expect(s).toHaveTextContent(HINT);
    });

    it('livello di protezione 2 o più letto: suggerimento', async () => {
      const s = await run({ ...SUMMARY, errors: [], protection: { validLevel: 2 } });
      expect(s).toHaveTextContent(HINT);
    });

    it('nessun suggerimento se solo alcuni upload falliscono o la protezione è bassa', async () => {
      const a = await run({
        ...SUMMARY,
        blocksListed: 3,
        blocksUploaded: 1,
        errors: [denied(1), denied(2)],
        protection: { validLevel: 1 },
      });
      expect(a).not.toHaveTextContent('CPU protetta');
    });
  });
});
