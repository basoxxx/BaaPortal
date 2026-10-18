import { act, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PROJECT_PATH, renderApp } from './renderApp';

describe('finestra di ispezione', () => {
  it('ha le schede Proprietà, Informazioni, Diagnostica', async () => {
    const { user } = await renderApp({ view: 'project', withProject: true });
    for (const id of ['properties', 'info', 'diagnostics'])
      expect(screen.getByTestId(`inspector-tab-${id}`)).toBeInTheDocument();
    await user.click(screen.getByTestId('inspector-tab-diagnostics'));
    expect(screen.getByTestId('inspector-tab-diagnostics')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByText('Nessuna informazione diagnostica disponibile.')).toBeInTheDocument();
  });

  it('Proprietà: con altro nodo dice che non ce ne sono', async () => {
    const { user } = await renderApp({ view: 'project', withProject: true });
    await user.click(screen.getByTestId('tree-node-common-data'));
    expect(screen.getByText('Nessuna proprietà disponibile')).toBeInTheDocument();
  });

  it('Proprietà: mostra nome, percorso e date; modificare Autore rende il progetto modificato', async () => {
    const { user, store } = await renderApp({ view: 'project', withProject: true });
    await user.click(screen.getByTestId('tree-node-project'));
    expect(screen.getByLabelText('Nome')).toHaveValue('Linea 3');
    expect(screen.getByLabelText('Percorso')).toHaveValue(PROJECT_PATH);
    const created = new Intl.DateTimeFormat('it-IT', {
      dateStyle: 'short',
      timeStyle: 'medium',
    }).format(new Date('2026-01-01T00:00:00Z'));
    expect(screen.getByLabelText('Creato il')).toHaveValue(created);
    expect(screen.getByLabelText('Ultima modifica')).toHaveValue(created);
    expect(store.getState().doc?.dirty).toBe(false);
    await user.type(screen.getByLabelText('Autore'), 'Z');
    expect(store.getState().doc?.dirty).toBe(true);
    expect(store.getState().doc?.project.meta.author).toBe('MarioZ');
    expect(screen.getByLabelText('Autore')).toHaveValue('MarioZ');
  });

  it('Commento è multiriga e il caret non si perde scrivendo più caratteri', async () => {
    const { user, store } = await renderApp({ view: 'project', withProject: true });
    await user.click(screen.getByTestId('tree-node-project'));
    const c = screen.getByLabelText('Commento');
    expect(c.tagName).toBe('TEXTAREA');
    await user.type(c, 'ab{Enter}cd');
    expect(store.getState().doc?.project.meta.comment).toBe('ab\ncd');
    expect(c).toHaveFocus();
  });

  it('Nome e Percorso sono in sola lettura', async () => {
    const { user } = await renderApp({ view: 'project', withProject: true });
    await user.click(screen.getByTestId('tree-node-project'));
    for (const l of ['Nome', 'Percorso', 'Creato il', 'Ultima modifica'])
      expect(screen.getByLabelText(l)).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Autore')).not.toHaveAttribute('readonly');
  });

  it('Informazioni → Generale elenca i messaggi, il più recente in alto', async () => {
    const { user, store } = await renderApp({ view: 'project', withProject: true });
    act(() => {
      store
        .getState()
        .pushMessage({ severity: 'info', textKey: 'messages.saved', params: { name: 'Primo' } });
      store.getState().pushMessage({
        severity: 'warning',
        textKey: 'messages.recentMissing',
        params: { name: 'Secondo' },
      });
    });
    await user.click(screen.getByTestId('inspector-tab-info'));
    expect(screen.getByTestId('info-subtab-general')).toHaveAttribute('aria-selected', 'true');
    const headers = within(screen.getByTestId('panel-inspector'))
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toEqual(['Gravità', 'Messaggio', 'Data', 'Ora']);
    const rows = screen.getAllByTestId('info-row');
    // l'apertura del progetto ha già prodotto un messaggio: i due nuovi stanno in cima
    expect(rows[0]).toHaveTextContent('Secondo');
    expect(rows[1]).toHaveTextContent('Progetto "Primo" salvato.');
    expect(within(rows[0]!).getByTestId('severity-warning')).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent(store.getState().messages.at(-1)!.time);
  });

  it('le sottoschede Riferimenti incrociati e Compila sono vuote con testo segnaposto', async () => {
    const { user } = await renderApp({ view: 'project', withProject: true });
    await user.click(screen.getByTestId('inspector-tab-info'));
    await user.click(screen.getByTestId('info-subtab-crossRefs'));
    expect(screen.getByText('Nessun riferimento incrociato da mostrare.')).toBeInTheDocument();
    await user.click(screen.getByTestId('info-subtab-compile'));
    expect(screen.getByText('Nessun risultato di compilazione da mostrare.')).toBeInTheDocument();
  });
});
