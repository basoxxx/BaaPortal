import { act, render, screen, waitFor } from '@testing-library/react';
import { readBaap } from '@baaportal/project';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CommitInput, CommitTextarea } from '../src/components/CommitField';
import { PROJECT_PATH, renderApp } from './renderApp';

describe('CommitInput', () => {
  it('conferma su blur e Invio, Esc annulla, validate blocca', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    const validate = (v: string) => (v.length > 4 ? 'troppo lungo' : null);
    render(
      <CommitInput id="f" aria-label="Campo" value="x" onCommit={onCommit} validate={validate} />,
    );
    const input = screen.getByLabelText('Campo');

    await user.click(input);
    await user.type(input, 'ab');
    expect(onCommit).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(onCommit).toHaveBeenLastCalledWith('xab');

    await user.type(input, 'c');
    await user.tab();
    expect(onCommit).toHaveBeenLastCalledWith('xabc');
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it('Esc ripristina il valore e non conferma; valore invariato non conferma', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<CommitInput aria-label="Campo" value="x" onCommit={onCommit} />);
    const input = screen.getByLabelText('Campo');
    await user.click(input);
    await user.type(input, 'zz{Escape}');
    expect(input).toHaveValue('x');
    await user.tab();
    await user.click(input);
    await user.tab();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('con validate che fallisce mostra il messaggio e non conferma', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <CommitInput
        id="f"
        aria-label="Campo"
        value=""
        onCommit={onCommit}
        validate={(v) => (v === 'no' ? 'non valido' : null)}
      />,
    );
    const input = screen.getByLabelText('Campo');
    await user.type(input, 'no');
    expect(screen.getByRole('alert')).toHaveTextContent('non valido');
    expect(input).toHaveAccessibleDescription('non valido');
    await user.keyboard('{Enter}');
    await user.tab();
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('segue il valore esterno quando non ha il focus', async () => {
    function Host() {
      const [v, setV] = useState('uno');
      return (
        <>
          <button onClick={() => setV('due')}>cambia</button>
          <CommitInput aria-label="Campo" value={v} onCommit={setV} />
        </>
      );
    }
    const user = userEvent.setup();
    render(<Host />);
    await user.click(screen.getByText('cambia'));
    expect(screen.getByLabelText('Campo')).toHaveValue('due');
  });
});

describe('CommitTextarea', () => {
  it('conferma solo su blur (Invio va a capo); Esc ripristina', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<CommitTextarea id="t" value="" onCommit={onCommit} rows={3} />);
    const ta = screen.getByRole('textbox');
    await user.type(ta, 'a{Enter}b');
    expect(onCommit).not.toHaveBeenCalled();
    await user.tab();
    expect(onCommit).toHaveBeenCalledWith('a\nb');
    onCommit.mockClear();
    await user.click(ta);
    await user.type(ta, 'zz{Escape}');
    await user.tab();
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe("annulla e ripeti nell'app", () => {
  it('la barra mostra la modifica, Ctrl+Z annulla fuori dai campi e non dentro un campo', async () => {
    const { user, store } = await renderApp({ view: 'project', withProject: true });
    await user.click(screen.getByTestId('tree-node-project'));
    const author = screen.getByLabelText('Autore');
    await user.type(author, 'Z');
    await user.tab();
    expect(store.getState().doc?.project.meta.author).toBe('MarioZ');
    expect(screen.getByRole('button', { name: 'Annulla' }).title).toMatch(
      /^Annulla: Autore del progetto \(/,
    );

    // Dentro un campo Ctrl+Z resta del campo.
    await user.click(author);
    await user.keyboard('{Control>}z{/Control}');
    expect(store.getState().history.past).toHaveLength(1);
    await user.click(document.body);

    await user.keyboard('{Control>}z{/Control}');
    expect(store.getState().doc?.project.meta.author).toBe('Mario');
    expect(screen.getByLabelText('Autore')).toHaveValue('Mario');
    expect(screen.getByRole('button', { name: 'Ripeti' }).title).toMatch(
      /^Ripeti: Autore del progetto \(/,
    );
    await user.keyboard('{Control>}y{/Control}');
    expect(store.getState().doc?.project.meta.author).toBe('MarioZ');
  });
});

describe('bozze in modifica e salvataggio/chiusura', () => {
  it('Ctrl+S con il campo ancora in modifica salva il valore e non lascia il documento modificato', async () => {
    const { user, store, bridge } = await renderApp({ view: 'project', withProject: true });
    await user.click(screen.getByTestId('tree-node-project'));
    await user.type(screen.getByLabelText('Autore'), 'Z');
    await user.keyboard('{Control>}s{/Control}');
    await waitFor(() => expect(store.getState().doc?.dirty).toBe(false));
    expect(store.getState().doc?.project.meta.author).toBe('MarioZ');
    expect(readBaap(bridge.files.get(PROJECT_PATH)!).meta.author).toBe('MarioZ');
  });

  it('una richiesta di chiusura con il campo in modifica chiede di salvare', async () => {
    const { user, bridge } = await renderApp({ view: 'project', withProject: true });
    await user.click(screen.getByTestId('tree-node-project'));
    await user.type(screen.getByLabelText('Autore'), 'Z');
    await act(async () => {
      await bridge.emitCloseRequest();
    });
    expect(bridge.confirmTexts).toHaveLength(1);
    expect(bridge.closeConfirmed).toBe(false);
  });
});
