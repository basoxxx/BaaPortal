import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from './renderApp';

const SECTIONS = {
  instructions: [
    'Preferiti',
    'Istruzioni di base',
    'Istruzioni avanzate',
    'Comunicazione',
    'Pacchetti opzionali',
  ],
  test: ['Pannello di comando CPU', 'Stack di chiamata', 'Pannello I/O del simulatore'],
  tasks: ['Trova e sostituisci'],
  libraries: ['Libreria di progetto', 'Librerie globali'],
} as const;

describe('task card', () => {
  it('le quattro schede e le sezioni di Istruzioni', async () => {
    const { store } = await renderApp({ view: 'project', withProject: true });
    const tabs = within(screen.getByTestId('panel-task-cards')).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Istruzioni', 'Test', 'Task', 'Librerie']);
    expect(store.getState().taskCard).toBe('instructions');
    const headings = screen.getAllByRole('button', { expanded: true }).map((b) => b.textContent);
    expect(headings).toEqual([...SECTIONS.instructions]);
  });

  it('cambiare scheda aggiorna lo store e mostra le sue sezioni', async () => {
    const { user, store } = await renderApp({ view: 'project', withProject: true });
    for (const id of ['test', 'tasks', 'libraries'] as const) {
      await user.click(screen.getByTestId(`taskcard-tab-${id}`));
      expect(store.getState().taskCard).toBe(id);
      expect(screen.getByTestId(`taskcard-tab-${id}`)).toHaveAttribute('aria-selected', 'true');
      expect(screen.getAllByRole('button', { expanded: true }).map((b) => b.textContent)).toEqual([
        ...SECTIONS[id],
      ]);
    }
  });

  it('le sezioni si richiudono e mostrano il segnaposto quando aperte', async () => {
    const { user } = await renderApp({ view: 'project', withProject: true });
    expect(screen.getAllByText('Nessun elemento disponibile in questa sezione.')).toHaveLength(5);
    await user.click(screen.getByRole('button', { name: 'Preferiti' }));
    expect(screen.getByRole('button', { name: 'Preferiti' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.getAllByText('Nessun elemento disponibile in questa sezione.')).toHaveLength(4);
  });
});
