import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { completionStatus } from '@codemirror/autocomplete';
import { describe, expect, it, vi } from 'vitest';
import type { AwlDiagnostic, Mnemonic } from '@baaportal/awl';
import { AwlEditor } from '../src/editors/awl/AwlEditor';

const T = 30_000;
type Props = Parameters<typeof AwlEditor>[0];

function setup(over: Partial<Props> = {}) {
  const onCommit = vi.fn();
  const onChange = vi.fn();
  const props: Props = {
    value: '',
    mnemonic: 'international' as Mnemonic,
    diagnostics: [],
    complete: () => ({ from: 0, options: [] }),
    onCommit,
    onChange,
    'aria-label': 'Codice',
    ...over,
  };
  const r = render(<AwlEditor {...props} />);
  const view = () =>
    EditorView.findFromDOM(r.container.querySelector('.cm-editor') as HTMLElement)!;
  const set = (text: string) =>
    act(() => view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: text } }));
  const again = (next: Partial<Props>) => r.rerender(<AwlEditor {...props} {...over} {...next} />);
  return { ...r, props, onCommit, onChange, view, set, again };
}

const focus = (v: EditorView) =>
  act(() => void v.contentDOM.dispatchEvent(new FocusEvent('focus')));
const blur = (v: EditorView) => act(() => void v.contentDOM.dispatchEvent(new FocusEvent('blur')));

describe('AwlEditor', () => {
  it(
    'mostra il testo e ha il ruolo textbox con la sua etichetta',
    () => {
      const e = setup({ value: 'A I 0.0' });
      expect(e.view().state.doc.toString()).toBe('A I 0.0');
      expect(e.getByRole('textbox', { name: 'Codice' })).toBeInTheDocument();
    },
    T,
  );

  it(
    "conferma all'uscita dal focus, in internazionale, una sola volta",
    () => {
      const e = setup({ value: '', mnemonic: 'german' });
      focus(e.view());
      e.set('U E 0.0');
      expect(e.onCommit).not.toHaveBeenCalled();
      blur(e.view());
      expect(e.onCommit).toHaveBeenCalledTimes(1);
      expect(e.onCommit).toHaveBeenCalledWith('A I 0.0');
      blur(e.view());
      expect(e.onCommit).toHaveBeenCalledTimes(1);
    },
    T,
  );

  it(
    'non conferma se il testo salvato non cambia',
    () => {
      const e = setup({ value: 'A I 0.0' });
      focus(e.view());
      e.set('A I 0.0 ');
      e.set('A I 0.0');
      blur(e.view());
      expect(e.onCommit).not.toHaveBeenCalled();
    },
    T,
  );

  it(
    'alla chiusura conferma la bozza non ancora confermata',
    () => {
      const e = setup();
      focus(e.view());
      e.set('A I 0.0');
      e.unmount();
      expect(e.onCommit).toHaveBeenCalledWith('A I 0.0');
    },
    T,
  );

  it(
    'cambio di mnemonica: conferma la bozza, poi mostra il testo convertito',
    () => {
      const e = setup({ value: 'A I 0.0' });
      focus(e.view());
      e.set('A I 0.1');
      e.again({ mnemonic: 'german' });
      expect(e.onCommit).toHaveBeenCalledTimes(1);
      expect(e.onCommit).toHaveBeenCalledWith('A I 0.1');
      expect(e.view().state.doc.toString()).toBe('U E 0.1');
      // Il cambio da solo non produce altre conferme.
      blur(e.view());
      expect(e.onCommit).toHaveBeenCalledTimes(1);
    },
    T,
  );

  it(
    'cambio di mnemonica senza bozza: nessuna conferma',
    () => {
      const e = setup({ value: 'A I 0.0' });
      e.again({ mnemonic: 'german' });
      expect(e.view().state.doc.toString()).toBe('U E 0.0');
      e.again({ mnemonic: 'international' });
      expect(e.view().state.doc.toString()).toBe('A I 0.0');
      expect(e.onCommit).not.toHaveBeenCalled();
    },
    T,
  );

  it(
    "un valore esterno sostituisce il testo se l'editor non ha il focus",
    () => {
      const e = setup({ value: 'A I 0.0' });
      e.again({ value: 'A I 9.9' });
      expect(e.view().state.doc.toString()).toBe('A I 9.9');
    },
    T,
  );

  it(
    "un valore esterno non cancella quello che si sta scrivendo; vale all'uscita se non c'è stata modifica",
    () => {
      const e = setup({ value: 'A I 0.0' });
      focus(e.view());
      e.set('A I 1.1');
      e.again({ value: 'A I 9.9' });
      expect(e.view().state.doc.toString()).toBe('A I 1.1');
      blur(e.view());
      expect(e.onCommit).toHaveBeenCalledWith('A I 1.1');

      const f = setup({ value: 'A I 0.0' });
      focus(f.view());
      f.again({ value: 'A I 9.9' });
      expect(f.view().state.doc.toString()).toBe('A I 0.0');
      blur(f.view());
      expect(f.view().state.doc.toString()).toBe('A I 9.9');
      expect(f.onCommit).not.toHaveBeenCalled();
    },
    T,
  );

  it(
    'le diagnostiche diventano sottolineature con il messaggio tradotto',
    async () => {
      const d: AwlDiagnostic = {
        severity: 'error',
        code: 'UNKNOWN_SYMBOL',
        network: 0,
        range: {
          from: { line: 0, col: 2, offset: 2 },
          to: { line: 0, col: 9, offset: 9 },
        },
        params: { name: 'Avvio' },
      };
      const e = setup({ value: 'A "Avvio"', diagnostics: [d] });
      await waitFor(() => expect(e.container.querySelector('.cm-lintRange-error')).not.toBeNull());
      expect(e.container.querySelector('.cm-lintRange-error')!.textContent).toBe('"Avvio"');
    },
    T,
  );

  it(
    'evidenzia i token con le classi baa-awl-*',
    () => {
      const e = setup({ value: 'A "Avvio" // x' });
      expect(e.container.querySelector('.baa-awl-instruction')!.textContent).toBe('A');
      expect(e.container.querySelector('.baa-awl-symbol')!.textContent).toBe('"Avvio"');
      expect(e.container.querySelector('.baa-awl-comment')!.textContent).toBe('// x');
    },
    T,
  );

  it(
    'il completamento si apre dopo # e applica il testo dal punto from al cursore',
    async () => {
      const complete = vi.fn((offset: number, text: string) => ({
        from: text.lastIndexOf('#', offset),
        options: [{ label: '#Motore', kind: 'local' as const, apply: '#Motore' }],
      }));
      const e = setup({ complete });
      focus(e.view());
      e.set('A ');
      act(() =>
        e.view().dispatch({
          changes: { from: 2, insert: '#' },
          selection: { anchor: 3 },
          userEvent: 'input.type',
        }),
      );
      await waitFor(() => expect(completionStatus(e.view().state)).toBe('active'));
      expect(complete).toHaveBeenLastCalledWith(3, 'A #');
      const opt = await waitFor(() => {
        const el = e.container.ownerDocument.querySelector('.cm-tooltip-autocomplete li');
        expect(el).not.toBeNull();
        return el!;
      });
      expect(opt.textContent).toContain('#Motore');
      // CodeMirror ignora Invio nei primi istanti dopo l'apertura del menu.
      await new Promise((r) => setTimeout(r, 150));
      fireEvent.keyDown(e.view().contentDOM, { key: 'Enter', keyCode: 13 });
      expect(e.view().state.doc.toString()).toBe('A #Motore');
    },
    T,
  );

  it(
    'focusAt porta il cursore nel punto indicato',
    () => {
      let handle: { focusAt(o: number): void } | null = null;
      const e = setup({
        value: 'A I 0.0\nA I 0.1',
        ref: (h: { focusAt(o: number): void } | null) => void (handle = h),
      } as Partial<Props>);
      act(() => handle!.focusAt(10));
      expect(e.view().state.selection.main.head).toBe(10);
    },
    T,
  );
});
