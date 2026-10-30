import { act, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { commands } from '../src/commands/commands';
import { renderApp } from './renderApp';

describe('Stampa: finestra', () => {
  it('Stampa… apre la finestra, invia il documento e chiude', async () => {
    const { user, store, bridge, service } = await renderApp({
      view: 'project',
      withProject: true,
      withPlc: true,
    });
    await act(() => commands['project.print'].run({ store, service, bridge }));
    const dlg = screen.getByRole('dialog', { name: 'Stampa' });
    await user.click(within(dlg).getByLabelText('Riferimenti incrociati'));
    await user.selectOptions(within(dlg).getByLabelText('Mnemonici AWL'), 'german');
    await user.selectOptions(within(dlg).getByLabelText('Carta'), 'Letter');
    await user.selectOptions(within(dlg).getByLabelText('Orientamento'), 'landscape');
    await user.click(within(dlg).getByRole('button', { name: 'Stampa' }));
    expect(bridge.printRequests).toHaveLength(1);
    const r = bridge.printRequests[0]!;
    expect(r).toMatchObject({ mode: 'print', paper: 'Letter', landscape: true, title: 'Linea 3' });
    expect(r.html).toContain('<section class="cover">');
    expect(r.html).toContain('Riferimenti incrociati');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Esporta in PDF: modalità pdf; un errore resta nella finestra', async () => {
    const { user, store, bridge, service } = await renderApp({
      view: 'project',
      withProject: true,
      withPlc: true,
    });
    bridge.printResult = { status: 'error', message: 'disco pieno' };
    await act(() => commands['project.exportPdf'].run({ store, service, bridge }));
    const dlg = screen.getByRole('dialog', { name: 'Esporta in PDF' });
    await user.click(within(dlg).getByRole('button', { name: 'Salva PDF' }));
    expect(await within(dlg).findByRole('alert')).toHaveTextContent('disco pieno');
    expect(bridge.printRequests[0]).toMatchObject({ mode: 'pdf' });
    expect(bridge.printRequests[0]!.defaultName).toBe('Linea 3.pdf');
  });

  it('senza PLC i comandi sono disattivati', async () => {
    const { store } = await renderApp({ view: 'project', withProject: true });
    expect(commands['project.print'].isEnabled(store.getState())).toBe(false);
  });
});
