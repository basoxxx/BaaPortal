import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { setLanguages, setTranslation, textKey } from '@baaportal/project';
import { fb, openEditor, PLC } from './blockFixtures';

const T = 30_000;

async function openWithTexts() {
  const f = fb('Nastro');
  f.header.comment = 'Commento italiano';
  f.networks[0]!.comment = 'Segmento italiano';
  f.networks[0]!.title = 'Titolo italiano';
  const app = await openEditor('block', f.id, (d) => void d.blocks.push(f));
  act(() => {
    app.store.getState().edit('t', (p) => {
      setLanguages(p, { editing: 'it-IT', others: ['en-US'], display: 'en-US' });
      setTranslation(p, textKey(PLC, f.networks[0]!.id, 'comment'), 'en-US', 'English segment');
    });
  });
  return { app, f };
}

describe('testi di progetto nell’interfaccia', () => {
  it(
    'con una lingua mostrata l’editor di blocco usa la traduzione, ricade sull’originale e non si modifica',
    async () => {
      const { f } = await openWithTexts();
      expect(screen.getByLabelText('Commento del segmento 1')).toHaveValue('English segment');
      expect(screen.getByLabelText('Commento del segmento 1')).toHaveAttribute('readonly');
      // Senza traduzione: il testo della lingua di modifica.
      expect(screen.getByLabelText('Titolo del segmento 1')).toHaveValue('Titolo italiano');
      expect(screen.getByTestId('texts-banner')).toBeInTheDocument();
      expect(f.networks[0]!.comment).toBe('Segmento italiano');
    },
    T,
  );

  it(
    'tornando alla lingua di modifica i campi sono quelli originali e modificabili',
    async () => {
      const { app } = await openWithTexts();
      act(() => {
        app.store
          .getState()
          .edit('t', (p) => void setLanguages(p, { editing: 'it-IT', others: ['en-US'] }));
      });
      await waitFor(() =>
        expect(screen.getByLabelText('Commento del segmento 1')).toHaveValue('Segmento italiano'),
      );
      expect(screen.getByLabelText('Commento del segmento 1')).not.toHaveAttribute('readonly');
      expect(screen.queryByTestId('texts-banner')).toBeNull();
    },
    T,
  );

  it(
    'Opzioni → Testi di progetto: elenca i testi e salva una traduzione',
    async () => {
      const { app, f } = await openWithTexts();
      await app.user.click(screen.getByRole('menuitem', { name: 'Opzioni' }));
      await app.user.click(screen.getByRole('menuitem', { name: 'Testi di progetto…' }));
      const d = await screen.findByRole('dialog', { name: 'Testi di progetto' });
      const input = within(d).getByLabelText('FB10 Nastro › N1 Titolo en-US', { exact: false });
      await app.user.type(input, 'English title');
      await app.user.tab();
      const key = textKey(PLC, f.networks[0]!.id, 'title');
      await waitFor(() =>
        expect(app.store.getState().doc!.project.texts?.[key]).toEqual({
          'en-US': 'English title',
        }),
      );
      await app.user.type(
        within(d).getByRole('searchbox', { name: 'Filtra per oggetto o testo' }),
        'zzz',
      );
      expect(within(d).queryByText('Titolo italiano')).toBeNull();
    },
    T,
  );

  it(
    'F1 apre la guida alla pagina dell’editor KOP in primo piano',
    async () => {
      const f = fb('Grafico');
      f.language = 'KOP';
      const app = await openEditor('block', f.id, (d) => void d.blocks.push(f));
      await app.user.keyboard('{F1}');
      const body = await screen.findByTestId('help-body');
      expect(within(body).getAllByRole('heading')[0]).toHaveTextContent('Editor KOP');
    },
    T,
  );
});
